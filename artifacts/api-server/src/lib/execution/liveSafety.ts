import { createHash } from "crypto";
import { canonicalJson } from "../plan/fingerprint";

export const LIVE_OPERATING_MODES = [
  "NORMAL",
  "NO_NEW_ENTRY",
  "EXIT_ONLY",
  "MAINTENANCE",
  "PROTECTION_DEGRADED",
] as const;
export type LiveOperatingMode = (typeof LIVE_OPERATING_MODES)[number];

export const LIVE_KILL_SWITCH_SCOPES = [
  "GLOBAL",
  "EXCHANGE",
  "MARKET",
  "SYMBOL",
  "STRATEGY_MODEL",
  "USER",
  "SECTION",
  "AUTOPILOT",
] as const;
export type LiveKillSwitchScope = (typeof LIVE_KILL_SWITCH_SCOPES)[number];

export interface LiveCommandIdentity {
  readonly decisionId: string;
  readonly riskDecisionId: string;
  readonly planFingerprint: string;
  readonly ownershipGeneration: number;
  readonly brainVersion: string;
  readonly idempotencyKey: string;
}

export interface ApplicableKillSwitch {
  readonly scope: LiveKillSwitchScope;
  readonly scopeKey: string;
  readonly reason: string;
}

export interface KillSwitchMatchContext {
  readonly userId: number;
  readonly section: string;
  readonly executionAuthority: string;
  readonly marketType: string;
  readonly symbol: string;
  readonly strategyId: string;
  readonly brainVersion: string | null;
  readonly autopilot: boolean;
}

/** Exact, provider-independent scope matching used at the final Live boundary. */
export function killSwitchApplies(
  candidate: Pick<ApplicableKillSwitch, "scope" | "scopeKey">,
  context: KillSwitchMatchContext,
): boolean {
  const key = candidate.scopeKey;
  switch (candidate.scope) {
    case "GLOBAL":
      return key === "*";
    case "EXCHANGE":
      return key === "*" || key === context.executionAuthority;
    case "MARKET":
      return key === "*" || key === context.marketType;
    case "SYMBOL":
      return key === "*" || key === context.symbol;
    case "STRATEGY_MODEL":
      return (
        key === "*" ||
        key === context.strategyId ||
        (context.brainVersion !== null && key === context.brainVersion)
      );
    case "USER":
      return key === "*" || key === String(context.userId);
    case "SECTION":
      return key === "*" || key === context.section;
    case "AUTOPILOT":
      return (
        context.autopilot &&
        (key === "*" ||
          (context.brainVersion !== null && key === context.brainVersion))
      );
  }
}

export interface DrawdownInput {
  /** Exact integer minor units (for example cents); null means UNKNOWN. */
  readonly peakEquityMinor: bigint | null;
  readonly currentEquityMinor: bigint | null;
  readonly limitBps: number;
}

export interface LiveEntrySafetyInput {
  readonly operatingMode: LiveOperatingMode;
  readonly reconciliationState:
    | "HEALTHY"
    | "INCOMPLETE"
    | "UNKNOWN"
    | "ESCALATED";
  readonly protectionState: "HEALTHY" | "DEGRADED" | "UNKNOWN";
  readonly globalDrawdownState: "HEALTHY" | "BREACHED" | "UNKNOWN";
  readonly expectedOwnershipGeneration: number;
  readonly command: LiveCommandIdentity | null;
  readonly switches: readonly ApplicableKillSwitch[];
  readonly accountDrawdown: DrawdownInput;
}

export type LiveEntrySafetyVerdict =
  | { allowed: true; commandFingerprint: string }
  | { allowed: false; code: string; reason: string };

export type DrawdownVerdict =
  | { state: "HEALTHY"; lossMinor: bigint }
  | { state: "BREACHED"; lossMinor: bigint }
  | { state: "UNKNOWN"; reason: string };

export interface SafeResumeInput {
  readonly reconciliationHealthy: boolean;
  readonly protectionHealthy: boolean;
  readonly accountDrawdownState: "HEALTHY" | "BREACHED" | "UNKNOWN";
  readonly globalDrawdownState: "HEALTHY" | "BREACHED" | "UNKNOWN";
  readonly accountEquityFresh: boolean;
  readonly globalEquityFresh: boolean;
  readonly ownershipGeneration: number;
  readonly ownerClaimed: boolean;
  readonly activeKillSwitches: number;
  readonly operatorModeActive: boolean;
  readonly providerHealthy: boolean;
}

export type SafeResumeVerdict =
  | { allowed: true }
  | { allowed: false; code: string; reason: string };

/** Pure fail-closed prerequisite ordering for entry-capable resume. */
export function evaluateSafeResume(input: SafeResumeInput): SafeResumeVerdict {
  if (input.operatorModeActive) {
    return {
      allowed: false,
      code: "OPERATOR_MODE_ACTIVE",
      reason: "An operator-owned authority reduction cannot be auto-cleared",
    };
  }
  if (
    !Number.isInteger(input.ownershipGeneration) ||
    input.ownershipGeneration < 1 ||
    !input.ownerClaimed
  ) {
    return {
      allowed: false,
      code: "OWNERSHIP_INVALID",
      reason: "Execution ownership is not valid",
    };
  }
  if (!input.providerHealthy) {
    return {
      allowed: false,
      code: "PROVIDER_UNHEALTHY",
      reason: "Provider health is unavailable or unhealthy",
    };
  }
  if (!input.reconciliationHealthy) {
    return {
      allowed: false,
      code: "RECONCILIATION_UNHEALTHY",
      reason: "Reconciliation is incomplete",
    };
  }
  if (!input.protectionHealthy) {
    return {
      allowed: false,
      code: "PROTECTION_UNHEALTHY",
      reason: "Existing-position protection is not healthy",
    };
  }
  if (!input.accountEquityFresh || input.accountDrawdownState !== "HEALTHY") {
    return {
      allowed: false,
      code: "ACCOUNT_DRAWDOWN_UNHEALTHY",
      reason: "Account equity is stale, unknown, or breached",
    };
  }
  if (!input.globalEquityFresh || input.globalDrawdownState !== "HEALTHY") {
    return {
      allowed: false,
      code: "GLOBAL_DRAWDOWN_UNHEALTHY",
      reason: "Global equity is stale, unknown, or breached",
    };
  }
  if (input.activeKillSwitches > 0) {
    return {
      allowed: false,
      code: "KILL_SWITCH_ACTIVE",
      reason: "An active kill switch prevents safe resume",
    };
  }
  return { allowed: true };
}

/** Inclusive boundary comparison without binary floating point. */
export function evaluateDrawdown(input: DrawdownInput): DrawdownVerdict {
  if (
    !Number.isInteger(input.limitBps) ||
    input.limitBps < 1 ||
    input.limitBps > 10_000
  ) {
    return { state: "UNKNOWN", reason: "Drawdown limit is invalid" };
  }
  if (
    input.peakEquityMinor === null ||
    input.currentEquityMinor === null ||
    input.peakEquityMinor <= 0n ||
    input.currentEquityMinor < 0n
  ) {
    return {
      state: "UNKNOWN",
      reason: "Current or peak equity is unavailable",
    };
  }
  const lossMinor =
    input.currentEquityMinor >= input.peakEquityMinor
      ? 0n
      : input.peakEquityMinor - input.currentEquityMinor;
  const breached =
    lossMinor * 10_000n >= input.peakEquityMinor * BigInt(input.limitBps);
  return { state: breached ? "BREACHED" : "HEALTHY", lossMinor };
}

export function liveCommandFingerprint(command: LiveCommandIdentity): string {
  return createHash("sha256")
    .update(canonicalJson(command), "utf8")
    .digest("hex");
}

/** Final deterministic authority check immediately before a Live money call. */
export function evaluateLiveEntrySafety(
  input: LiveEntrySafetyInput,
): LiveEntrySafetyVerdict {
  if (!input.command) {
    return {
      allowed: false,
      code: "LIVE_COMMAND_IDENTITY_REQUIRED",
      reason:
        "Live execution requires decision, risk, plan, owner-generation, brain, and idempotency bindings",
    };
  }
  if (
    !input.command.decisionId ||
    !input.command.riskDecisionId ||
    !input.command.planFingerprint ||
    !input.command.brainVersion ||
    !input.command.idempotencyKey ||
    !Number.isInteger(input.command.ownershipGeneration) ||
    input.command.ownershipGeneration < 1
  ) {
    return {
      allowed: false,
      code: "LIVE_COMMAND_IDENTITY_INVALID",
      reason: "Live command identity is incomplete or invalid",
    };
  }
  if (input.command.ownershipGeneration !== input.expectedOwnershipGeneration) {
    return {
      allowed: false,
      code: "STALE_EXECUTION_OWNER",
      reason: "Live command ownership generation is stale",
    };
  }
  if (input.switches.length > 0) {
    const active = [...input.switches].sort((a, b) => {
      const scope =
        LIVE_KILL_SWITCH_SCOPES.indexOf(a.scope) -
        LIVE_KILL_SWITCH_SCOPES.indexOf(b.scope);
      return scope || a.scopeKey.localeCompare(b.scopeKey);
    })[0]!;
    return {
      allowed: false,
      code: `KILL_SWITCH_${active.scope}`,
      reason: `${active.scope} kill switch ${active.scopeKey} is active: ${active.reason}`,
    };
  }
  if (input.operatingMode !== "NORMAL") {
    return {
      allowed: false,
      code: `LIVE_MODE_${input.operatingMode}`,
      reason: `Live operating mode ${input.operatingMode} blocks new entries while exits remain available`,
    };
  }
  if (input.reconciliationState !== "HEALTHY") {
    return {
      allowed: false,
      code: `RECONCILIATION_${input.reconciliationState}`,
      reason: "Live reconciliation is not healthy",
    };
  }
  if (input.protectionState !== "HEALTHY") {
    return {
      allowed: false,
      code: `PROTECTION_${input.protectionState}`,
      reason: "Existing-position protection is not verified healthy",
    };
  }
  if (input.globalDrawdownState !== "HEALTHY") {
    return {
      allowed: false,
      code: `GLOBAL_DRAWDOWN_${input.globalDrawdownState}`,
      reason: "Global drawdown authority is not healthy",
    };
  }
  const accountDrawdown = evaluateDrawdown(input.accountDrawdown);
  if (accountDrawdown.state !== "HEALTHY") {
    return {
      allowed: false,
      code: `ACCOUNT_DRAWDOWN_${accountDrawdown.state}`,
      reason:
        accountDrawdown.state === "UNKNOWN"
          ? accountDrawdown.reason
          : "Account drawdown is at or beyond its configured limit",
    };
  }
  return {
    allowed: true,
    commandFingerprint: liveCommandFingerprint(input.command),
  };
}
