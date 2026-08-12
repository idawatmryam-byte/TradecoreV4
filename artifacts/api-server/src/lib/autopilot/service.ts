import type { BotConfig } from "@workspace/db";
import type { RiskCheck } from "../decisionTrace";
import type { ExecutionAuthority } from "../execution/authority";
import type { AutopilotExecutionContext } from "../execution/executor";
import { BRAIN_V0_VERSION } from "../intelligence/baseline";
import { brainDecisionFingerprint } from "../intelligence/contracts";
import type { MarketState } from "../intelligence/market-state/types";
import { brainDecisionFromV0TradePlan } from "../intelligence/trade-plan-adapter";
import type { StrategyConfig, TradePlan } from "../strategies";
import {
  evaluateAutopilotEntry,
  type AutopilotEvaluation,
} from "./contracts";
import {
  autopilotConfigFingerprint,
  autonomousIdempotencyKey,
  riskDecisionFingerprint,
  strategyConfigVersion,
} from "./fingerprints";
import {
  claimAutonomousDecision,
  completeAutonomousDecision,
  getAutopilotSnapshot,
  globalAutopilotSuspended,
  recordAutonomousRefusal,
  setAutopilotState,
  updateEquityWatermark,
} from "./store";

export interface AuthorizeAutopilotInput {
  userId: number;
  section: "crypto" | "forex";
  config: BotConfig;
  executionAuthority: ExecutionAuthority;
  providerConfigurationValid: boolean;
  reconciliationState: "HEALTHY" | "UNHEALTHY" | "UNKNOWN";
  killSwitchActive: boolean;
  marketState: MarketState | null;
  unifiedBrainEvidenceAvailable: boolean;
  plan: TradePlan;
  strategyConfig?: StrategyConfig;
  riskChecks: readonly RiskCheck[];
  balanceUsdt: number | null;
  dailyPnlUsdt: number | null;
  openPositionCount: number | null;
  portfolioRiskPercent: number | null;
  symbolExposurePercent: number | null;
  netExposurePercent: number | null;
  correlatedExposurePercent: number | null;
  now: Date;
}

export type AuthorizeAutopilotResult =
  | { allowed: true; context: AutopilotExecutionContext; evaluation: AutopilotEvaluation }
  | { allowed: false; reasonCode: string; reason: string; evaluation?: AutopilotEvaluation };

const AUTO_BLOCK_CODES = new Set([
  "MANDATE_MISSING",
  "MANDATE_NOT_YET_VALID",
  "MANDATE_EXPIRED",
  "MANDATE_REVOKED",
  "MANDATE_NOT_ACTIVE",
  "GLOBAL_SUSPENSION_ACTIVE",
  "BRAIN_VERSION_NOT_DEMO_APPROVED",
  "BRAIN_VERSION_MISMATCH",
  "CONFIGURATION_CHANGED",
  "AUTHORITY_NOT_APPROVED_DEMO",
  "MARKET_TYPE_NOT_ELIGIBLE",
  "PROVIDER_CONFIGURATION_INVALID",
  "RECONCILIATION_UNKNOWN",
  "RECONCILIATION_UNHEALTHY",
  "MARKET_DATA_UNAVAILABLE",
  "MARKET_DATA_STALE",
  "KILL_SWITCH_ACTIVE",
  "POSITION_SIZE_LIMIT_EXCEEDED",
  "LEVERAGE_LIMIT_EXCEEDED",
  "PORTFOLIO_RISK_LIMIT_EXCEEDED",
  "SYMBOL_EXPOSURE_LIMIT_EXCEEDED",
  "NET_EXPOSURE_LIMIT_EXCEEDED",
  "CORRELATED_EXPOSURE_LIMIT_EXCEEDED",
  "DAILY_LOSS_LIMIT_EXCEEDED",
  "DRAWDOWN_LIMIT_EXCEEDED",
  "CONCURRENT_POSITION_LIMIT_EXCEEDED",
  "DETERMINISTIC_RISK_REFUSED",
  "REQUIRED_EVIDENCE_UNAVAILABLE",
]);

export async function authorizeAutopilotEntry(input: AuthorizeAutopilotInput): Promise<AuthorizeAutopilotResult> {
  const snapshot = await getAutopilotSnapshot(input.userId, input.section);
  const configFingerprint = autopilotConfigFingerprint(input.config);
  const strategyVersion = strategyConfigVersion(input.plan.strategyId, input.strategyConfig);
  const dataTimestamp = input.marketState?.dataTimestamp ?? input.now.toISOString();
  const maximumAgeSeconds = snapshot.mandate?.maximumMarketDataAgeSeconds ?? 1;
  const expiresAt = new Date(Date.parse(dataTimestamp) + maximumAgeSeconds * 1000).toISOString();
  const decision = brainDecisionFromV0TradePlan(input.plan, {
    marketStateFingerprint: input.marketState?.fingerprint ?? "0".repeat(64),
    dataTimestamp,
    expiresAt: Date.parse(expiresAt) > Date.parse(dataTimestamp) ? expiresAt : new Date(Date.parse(dataTimestamp) + 1).toISOString(),
    brainVersion: BRAIN_V0_VERSION,
    strategyVersion,
    configVersion: configFingerprint,
    marketStateVersion: input.marketState?.marketStateVersion ?? "market-state-unavailable",
  });
  const decisionFingerprint = brainDecisionFingerprint(decision);

  if (!snapshot.mandate || !snapshot.brainVersion || !snapshot.mandateState) {
    const reason = "No immutable Demo Autopilot mandate is active for this configuration";
    await setAutopilotState({
      userId: input.userId, section: input.section, state: "AUTOPILOT_BLOCKED",
      reasonCode: "MANDATE_MISSING", reason, actor: { actorType: "system" },
      globalSuspended: globalAutopilotSuspended(),
      configSuspended: true,
    });
    await recordAutonomousRefusal({
      userId: input.userId, section: input.section, decisionFingerprint,
      reasonCode: "MANDATE_MISSING", reason, checks: [],
    });
    return { allowed: false, reasonCode: "MANDATE_MISSING", reason };
  }

  const watermark = await updateEquityWatermark({
    userId: input.userId,
    section: input.section,
    now: input.now,
    equityUsdt: input.balanceUsdt,
  });
  const globalSuspended = globalAutopilotSuspended();
  const evaluation = evaluateAutopilotEntry(snapshot.mandate, {
    now: input.now,
    state: snapshot.control.state as "AUTOPILOT_ENABLED" | "AUTOPILOT_PAUSED" | "AUTOPILOT_BLOCKED",
    stateReason: snapshot.control.reason,
    globalSuspended,
    configSuspended: snapshot.control.configSuspended,
    brainVersionState: snapshot.brainVersion.state as import("./contracts").BrainVersionState,
    mandateState: snapshot.mandateState.state as "INACTIVE" | "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED",
    brainVersion: BRAIN_V0_VERSION,
    userId: input.userId,
    section: input.section,
    botConfigId: input.config.id,
    configFingerprint,
    configuredMode: input.config.mode,
    executionAuthority: input.executionAuthority,
    marketType: input.config.marketType as "spot" | "futures" | "forex",
    providerConfigurationValid: input.providerConfigurationValid,
    reconciliationState: input.reconciliationState,
    marketState: {
      available: input.marketState !== null,
      healthy: input.marketState?.freshness.status === "fresh" && input.marketState.dataQuality.status === "healthy",
      dataTimestamp: input.marketState ? new Date(input.marketState.dataTimestamp) : null,
      fingerprint: input.marketState?.fingerprint ?? null,
    },
    killSwitchActive: input.killSwitchActive || globalSuspended,
    symbol: input.plan.symbol,
    strategyId: input.plan.strategyId,
    strategyVersion,
    positionNotionalUsdt: input.plan.entryPrice * input.plan.qty,
    leverage: Math.max(1, input.plan.leverage),
    portfolioRiskPercent: input.portfolioRiskPercent,
    symbolExposurePercent: input.symbolExposurePercent,
    netExposurePercent: input.netExposurePercent,
    correlatedExposurePercent: input.correlatedExposurePercent,
    dailyPnlUsdt: input.dailyPnlUsdt,
    drawdownPercent: watermark.drawdownPercent,
    openPositionCount: input.openPositionCount,
    deterministicRiskPassed: input.riskChecks.every((check) => check.passed),
    requiredEvidenceAvailable: input.marketState !== null && input.unifiedBrainEvidenceAvailable,
  });

  if (!evaluation.allowed) {
    await recordAutonomousRefusal({
      userId: input.userId, section: input.section, mandateId: snapshot.mandate.id,
      mandateFingerprint: snapshot.mandate.fingerprint,
      decisionFingerprint, reasonCode: evaluation.reasonCode, reason: evaluation.reason,
      checks: evaluation.checks,
    });
    if (snapshot.control.state === "AUTOPILOT_ENABLED" && AUTO_BLOCK_CODES.has(evaluation.reasonCode)) {
      await setAutopilotState({
        userId: input.userId, section: input.section, state: "AUTOPILOT_BLOCKED",
        reasonCode: evaluation.reasonCode, reason: evaluation.reason,
        actor: { actorType: "system" }, mandateId: snapshot.mandate.id,
        globalSuspended,
        configSuspended: true,
      });
    }
    return { allowed: false, reasonCode: evaluation.reasonCode, reason: evaluation.reason, evaluation };
  }

  const riskFingerprint = riskDecisionFingerprint({
    plan: input.plan,
    checks: input.riskChecks,
    portfolioRiskPercent: input.portfolioRiskPercent!,
    symbolExposurePercent: input.symbolExposurePercent!,
    netExposurePercent: input.netExposurePercent!,
    correlatedExposurePercent: input.correlatedExposurePercent!,
  });
  const idempotencyKey = autonomousIdempotencyKey({
    userId: input.userId,
    section: input.section,
    mandateFingerprint: snapshot.mandate.fingerprint,
    decisionFingerprint,
  });
  const claim = await claimAutonomousDecision({
    userId: input.userId,
    section: input.section,
    mandateId: snapshot.mandate.id,
    mandateFingerprint: snapshot.mandate.fingerprint,
    brainVersion: snapshot.mandate.brainVersion,
    decisionFingerprint,
    riskFingerprint,
    idempotencyKey,
  });
  if (!claim) {
    return {
      allowed: false,
      reasonCode: "DUPLICATE_AUTONOMOUS_DECISION",
      reason: "This exact decision and mandate were already claimed; no second order was submitted",
      evaluation,
    };
  }
  return {
    allowed: true,
    evaluation,
    context: {
      claimId: claim.id,
      mandateId: snapshot.mandate.id,
      mandateFingerprint: snapshot.mandate.fingerprint,
      brainVersion: snapshot.mandate.brainVersion,
      decisionFingerprint,
      riskFingerprint,
      idempotencyKey,
      permittedPhase7Actions: snapshot.mandate.permittedPhase7Actions,
    },
  };
}

export async function recordAutopilotExecutionOutcome(input: {
  context: AutopilotExecutionContext;
  userId: number;
  section: "crypto" | "forex";
  entered: boolean;
  reason: string;
  tradeId?: number;
  executionIntentId?: number;
}): Promise<void> {
  // Reduce authority first. If outcome persistence subsequently fails, the
  // system remains blocked instead of accepting another autonomous decision.
  if (!input.entered) {
    await setAutopilotState({
      userId: input.userId,
      section: input.section,
      state: "AUTOPILOT_BLOCKED",
      reasonCode: "AUTONOMOUS_EXECUTION_FAILED",
      reason: input.reason,
      actor: { actorType: "system" },
      mandateId: input.context.mandateId,
      configSuspended: true,
    });
  }
  await completeAutonomousDecision({
    claimId: input.context.claimId,
    userId: input.userId,
    section: input.section,
    status: input.entered ? "EXECUTED" : "FAILED",
    reasonCode: input.entered ? "AUTONOMOUS_EXECUTION_SUCCEEDED" : "AUTONOMOUS_EXECUTION_FAILED",
    reason: input.reason,
    ...(input.tradeId != null && { tradeId: input.tradeId }),
    ...(input.executionIntentId != null && { executionIntentId: input.executionIntentId }),
  });
}

export async function suspendAutopilotForSafetyViolation(input: {
  userId: number;
  section: "crypto" | "forex";
  reasonCode: string;
  reason: string;
}): Promise<void> {
  const snapshot = await getAutopilotSnapshot(input.userId, input.section);
  if (!snapshot.mandate || snapshot.control.state !== "AUTOPILOT_ENABLED") return;
  await setAutopilotState({
    userId: input.userId,
    section: input.section,
    state: "AUTOPILOT_BLOCKED",
    reasonCode: input.reasonCode,
    reason: input.reason,
    actor: { actorType: "system" },
    mandateId: snapshot.mandate.id,
    configSuspended: true,
  });
}
