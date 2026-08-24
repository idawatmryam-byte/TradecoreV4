import { and, count, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import {
  brainVersionsTable,
  db,
  executionIntentsTable,
  tradesTable,
  tradingMandateDecisionClaimsTable,
} from "@workspace/db";
import type { BotConfig } from "@workspace/db";
import type { RiskCheck } from "../decisionTrace";
import type { ExecutionAuthority } from "../execution/authority";
import {
  evaluatePersistedLiveSafety,
  getLiveExecutionHealth,
} from "../execution/liveSafetyStore";
import type { LiveCommandIdentity } from "../execution/liveSafety";
import { getBinanceCredentials } from "../binanceCredentials";
import { getOandaCredentials } from "../oandaCredentials";
import { brainDecisionFingerprint } from "../intelligence/contracts";
import { sha256Fingerprint } from "../intelligence/canonical";
import type { MarketState } from "../intelligence/market-state/types";
import { brainDecisionFromV0TradePlan } from "../intelligence/trade-plan-adapter";
import type { StrategyConfig, TradePlan } from "../strategies";
import {
  autopilotConfigFingerprint,
  riskDecisionFingerprint,
  strategyConfigVersion,
} from "../autopilot/fingerprints";
import { plannedRiskDollars } from "../metrics/kernel";
import {
  evaluateAndClaimRestrictedLiveDecision,
  getActiveTradingMandate,
  transitionTradingMandate,
  type RestrictedLiveClaimIdentity,
} from "./store";
import type { RestrictedLiveEvidence } from "./contracts";

export interface RestrictedLiveExecutionContext {
  readonly claimId: number;
  readonly mandateId: number;
  readonly mandateRevision: number;
  readonly mandateFingerprint: string;
  readonly brainVersion: string;
  readonly brainFingerprint: string;
  readonly decisionFingerprint: string;
  readonly riskFingerprint: string;
  readonly configurationFingerprint: string;
  readonly idempotencyKey: string;
}

export interface AuthorizeRestrictedLiveInput {
  userId: number;
  section: "crypto" | "forex";
  config: BotConfig;
  executionAuthority: ExecutionAuthority;
  plan: TradePlan;
  strategyConfig?: StrategyConfig;
  riskChecks: readonly RiskCheck[];
  marketState: MarketState | null;
  unifiedBrainEvidenceAvailable: boolean;
  balanceUsdt: number | null;
  aggregateExposureUsdt: number | null;
  portfolioRiskPercent: number | null;
  symbolExposurePercent: number | null;
  netExposurePercent: number | null;
  correlatedExposurePercent: number | null;
  openPositionCount: number | null;
  ownershipGeneration: number;
  spreadBps: number | null;
  expectedSlippageBps: number | null;
  now: Date;
}

export type AuthorizeRestrictedLiveResult =
  | {
      allowed: true;
      context: RestrictedLiveExecutionContext;
      liveCommand: LiveCommandIdentity;
    }
  | {
      allowed: false;
      reasonCode: string;
      reason: string;
      fallbackEligible: boolean;
      automaticallySuspended: boolean;
    };

function deterministicUuid(value: unknown): string {
  const hash = sha256Fingerprint(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Convert the exact decimal representation to 10^-8 units, rounding usage up. */
export function decimalToAtomicCeil(value: number): bigint | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0);
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  const decimalPosition = whole.length + exponent;
  const atomicPosition = decimalPosition + 8;
  if (atomicPosition <= 0) return BigInt(/[1-9]/.test(digits) ? 1 : 0);
  if (atomicPosition >= digits.length) {
    return BigInt(digits.padEnd(atomicPosition, "0") || "0");
  }
  const kept = digits.slice(0, atomicPosition) || "0";
  const discarded = digits.slice(atomicPosition);
  return BigInt(kept) + (/[1-9]/.test(discarded) ? 1n : 0n);
}

function signedDecimalToAtomic(value: string): bigint {
  const negative = value.trim().startsWith("-");
  const absolute = value.trim().replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = absolute.split(".");
  const atomic = BigInt(
    `${whole || "0"}${fraction.padEnd(8, "0").slice(0, 8)}`,
  );
  return negative ? -atomic : atomic;
}

function lossFromNetAtomic(net: string): bigint {
  const value = signedDecimalToAtomic(net);
  return value < 0n ? -value : 0n;
}

export async function resolveEligibleTradingAccounts(
  userId: number,
  section: "crypto" | "forex",
): Promise<Array<{ accountId: string; authorities: ExecutionAuthority[] }>> {
  if (section === "forex") {
    const credentials = await getOandaCredentials(userId);
    if (!credentials) return [];
    const digest = sha256Fingerprint({
      provider: "oanda",
      accountId: credentials.accountId,
    });
    return [
      {
        accountId: `oanda:${digest.slice(0, 32)}`,
        authorities: ["oanda_live"],
      },
    ];
  }
  const credentials = await getBinanceCredentials(userId);
  if (!credentials) return [];
  const digest = sha256Fingerprint({
    provider: "binance",
    apiKey: credentials.apiKey,
  });
  return [
    {
      accountId: `binance:${digest.slice(0, 32)}`,
      authorities: ["binance_spot_live", "binance_futures_live"],
    },
  ];
}

async function realizedLosses(
  userId: number,
  section: "crypto" | "forex",
  now: Date,
): Promise<{ daily: bigint; weekly: bigint; monthly: bigint }> {
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const week = new Date(day);
  const mondayOffset = (week.getUTCDay() + 6) % 7;
  week.setUTCDate(week.getUTCDate() - mondayOffset);
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const query = async (start: Date) => {
    const [row] = await db
      .select({
        net: sql<string>`coalesce(sum(${tradesTable.pnl}::numeric), 0)::text`,
      })
      .from(tradesTable)
      .where(
        and(
          eq(tradesTable.userId, userId),
          eq(tradesTable.section, section),
          eq(tradesTable.executionTarget, "live"),
          ne(tradesTable.status, "open"),
          gte(tradesTable.exitTime, start),
        ),
      );
    return lossFromNetAtomic(row?.net ?? "0");
  };
  const [daily, weekly, monthly] = await Promise.all([
    query(day),
    query(week),
    query(month),
  ]);
  return { daily, weekly, monthly };
}

async function recentMandateMetrics(mandateId: number, now: Date) {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1_000);
  const [[counts], [lifetime]] = await Promise.all([
    db
      .select({
        decisions: count(),
        entries: sql<number>`count(*) filter (where ${tradingMandateDecisionClaimsTable.status} = 'EXECUTED')::int`,
        fillLatencyMs: sql<
          number | null
        >`max(${tradingMandateDecisionClaimsTable.fillLatencyMs})::int`,
        liveDemoDivergenceBps: sql<
          number | null
        >`max(abs(${tradingMandateDecisionClaimsTable.liveDemoDivergenceBps}))::int`,
      })
      .from(tradingMandateDecisionClaimsTable)
      .where(
        and(
          eq(tradingMandateDecisionClaimsTable.mandateId, mandateId),
          gte(tradingMandateDecisionClaimsTable.createdAt, hourAgo),
        ),
      ),
    db
      .select({
        canaryUsed: sql<string>`coalesce(sum(case when ${tradingMandateDecisionClaimsTable.status} in ('CLAIMED','BOUNDARY_AUTHORIZED','EXECUTED','OUTCOME_UNKNOWN') then ${tradingMandateDecisionClaimsTable.reservedNotional}::numeric else 0 end), 0)::text`,
      })
      .from(tradingMandateDecisionClaimsTable)
      .where(eq(tradingMandateDecisionClaimsTable.mandateId, mandateId)),
  ]);
  return {
    decisions: Number(counts?.decisions ?? 0),
    entries: Number(counts?.entries ?? 0),
    fillLatencyMs: counts?.fillLatencyMs ?? null,
    liveDemoDivergenceBps: counts?.liveDemoDivergenceBps ?? null,
    canaryUsed: BigInt(lifetime?.canaryUsed ?? "0"),
  };
}

function drawdownBps(
  peak: string | null,
  current: string | null,
): number | null {
  if (peak === null || current === null) return null;
  const peakValue = BigInt(peak);
  const currentValue = BigInt(current);
  if (peakValue <= 0n || currentValue < 0n) return null;
  const loss = currentValue >= peakValue ? 0n : peakValue - currentValue;
  return Number((loss * 10_000n + peakValue - 1n) / peakValue);
}

export async function authorizeRestrictedLiveEntry(
  input: AuthorizeRestrictedLiveInput,
): Promise<AuthorizeRestrictedLiveResult> {
  const active = await getActiveTradingMandate({
    userId: input.userId,
    section: input.section,
  });
  if (!active) {
    return {
      allowed: false,
      reasonCode: "MANDATE_MISSING",
      reason: "No active Restricted Live mandate exists",
      fallbackEligible: false,
      automaticallySuspended: false,
    };
  }
  const [brain] = await db
    .select()
    .from(brainVersionsTable)
    .where(
      and(
        eq(brainVersionsTable.id, active.core.terms.brainVersionId),
        eq(brainVersionsTable.userId, input.userId),
        eq(brainVersionsTable.section, input.section),
      ),
    )
    .limit(1);
  const accounts = await resolveEligibleTradingAccounts(
    input.userId,
    input.section,
  );
  const accountId =
    accounts.find((account) =>
      account.authorities.includes(input.executionAuthority),
    )?.accountId ?? null;
  const configFingerprint = autopilotConfigFingerprint(input.config);
  const strategyVersion = strategyConfigVersion(
    input.plan.strategyId,
    input.strategyConfig,
  );
  const marketTimestamp =
    input.marketState?.dataTimestamp ?? input.now.toISOString();
  const decisionId = deterministicUuid({
    type: "phase12-restricted-live-decision",
    userId: input.userId,
    section: input.section,
    mandateFingerprint: active.view.fingerprint,
    plan: input.plan,
    marketFingerprint: input.marketState?.fingerprint ?? null,
    marketTimestamp,
    configFingerprint,
    strategyVersion,
  });
  const decision = brainDecisionFromV0TradePlan(input.plan, {
    marketStateFingerprint: input.marketState?.fingerprint ?? "0".repeat(64),
    dataTimestamp: marketTimestamp,
    expiresAt: new Date(Date.parse(marketTimestamp) + 1_000).toISOString(),
    brainVersion: active.core.terms.brainVersion,
    strategyVersion,
    configVersion: configFingerprint,
    marketStateVersion:
      input.marketState?.marketStateVersion ?? "market-state-unavailable",
    decisionId,
    thesisId: deterministicUuid({ type: "phase12-thesis", decisionId }),
  });
  const decisionFingerprint = brainDecisionFingerprint(decision);
  const riskFingerprint = riskDecisionFingerprint({
    plan: input.plan,
    checks: input.riskChecks,
    portfolioRiskPercent: input.portfolioRiskPercent ?? -1,
    symbolExposurePercent: input.symbolExposurePercent ?? -1,
    netExposurePercent: input.netExposurePercent ?? -1,
    correlatedExposurePercent: input.correlatedExposurePercent ?? -1,
  });
  const planFingerprint = sha256Fingerprint({
    userId: input.userId,
    plan: input.plan,
  });
  const riskDecisionId = deterministicUuid({
    type: "phase12-risk-decision",
    decisionFingerprint,
    riskFingerprint,
  });
  const idempotencyKey = sha256Fingerprint({
    type: "phase12-restricted-live-command",
    userId: input.userId,
    section: input.section,
    mandateFingerprint: active.view.fingerprint,
    decisionFingerprint,
  });
  const liveCommand: LiveCommandIdentity = {
    decisionId,
    riskDecisionId,
    planFingerprint,
    ownershipGeneration: input.ownershipGeneration,
    brainVersion: active.core.terms.brainVersion,
    idempotencyKey,
  };
  const [health, safety, losses, recent] = await Promise.all([
    getLiveExecutionHealth(input.userId, input.section),
    evaluatePersistedLiveSafety({
      userId: input.userId,
      section: input.section,
      executionAuthority: input.executionAuthority,
      marketType: input.config.marketType,
      symbol: input.plan.symbol,
      strategyId: input.plan.strategyId,
      autopilot: true,
      command: liveCommand,
    }),
    realizedLosses(input.userId, input.section, input.now),
    recentMandateMetrics(active.view.id, input.now),
  ]);
  const perTradeRisk = decimalToAtomicCeil(
    plannedRiskDollars(
      input.plan.entryPrice,
      input.plan.slPrice,
      input.plan.qty,
    ) ?? Number.NaN,
  );
  const positionNotional = decimalToAtomicCeil(
    input.plan.entryPrice * input.plan.qty,
  );
  const aggregateExposure =
    input.aggregateExposureUsdt === null
      ? null
      : decimalToAtomicCeil(input.aggregateExposureUsdt);
  const marketDataAgeSeconds = input.marketState
    ? Math.max(
        0,
        Math.ceil(
          (input.now.getTime() - Date.parse(input.marketState.dataTimestamp)) /
            1_000,
        ),
      )
    : null;
  const reconciliationAgeSeconds = health.state.lastReconciledAt
    ? Math.max(
        0,
        Math.ceil(
          (input.now.getTime() - health.state.lastReconciledAt.getTime()) /
            1_000,
        ),
      )
    : null;
  const evidence: RestrictedLiveEvidence = {
    now: input.now,
    lifecycleState: active.view.lifecycleState,
    tenantId: `user:${input.userId}`,
    userId: input.userId,
    section: input.section,
    accountId,
    executionAuthority: input.executionAuthority,
    market: input.config.marketType as "spot" | "futures" | "forex",
    symbol: input.plan.symbol,
    strategyId: input.plan.strategyId,
    strategyVersion,
    model: brain?.implementation ?? "UNKNOWN",
    brainVersion: brain?.version ?? "UNKNOWN",
    brainFingerprint: brain?.fingerprint ?? "0".repeat(64),
    perTradeRisk,
    positionNotional,
    aggregateExposure,
    canaryUsed: recent.canaryUsed,
    leverageBps: Number.isFinite(input.plan.leverage)
      ? Math.ceil(Math.max(1, input.plan.leverage) * 10_000)
      : null,
    openPositionCount: input.openPositionCount,
    openOrderCount: health.unresolvedIntents.length,
    dailyLoss: losses.daily,
    weeklyLoss: losses.weekly,
    monthlyLoss: losses.monthly,
    drawdownBps: drawdownBps(
      health.state.peakEquityMinor,
      health.state.currentEquityMinor,
    ),
    decisionsLastHour: recent.decisions,
    entriesLastHour: recent.entries,
    spreadBps: input.spreadBps,
    expectedSlippageBps: input.expectedSlippageBps,
    fillLatencyMs: recent.fillLatencyMs,
    protectionFailures: health.state.protectionState === "HEALTHY" ? 0 : 1,
    reconciliationAgeSeconds,
    liveDemoDivergenceBps: recent.liveDemoDivergenceBps,
    marketDataAgeSeconds,
    deterministicRiskPassed: input.riskChecks.every((item) => item.passed),
    currentStateRevalidated:
      input.marketState !== null &&
      input.unifiedBrainEvidenceAvailable &&
      input.balanceUsdt !== null,
    phase11Healthy: safety.allowed,
    killSwitchActive: health.switches.length > 0,
    blockingOperatingMode: health.state.operatingMode !== "NORMAL",
    decisionId,
    riskDecisionId,
    planFingerprint,
    configurationFingerprint: configFingerprint,
    ownershipGeneration: input.ownershipGeneration,
  };
  const identity: RestrictedLiveClaimIdentity = {
    decisionId,
    decisionFingerprint,
    riskDecisionId,
    riskFingerprint,
    planFingerprint,
    configurationFingerprint: configFingerprint,
    ownershipGeneration: input.ownershipGeneration,
    idempotencyKey,
  };
  const claim = await evaluateAndClaimRestrictedLiveDecision({
    mandateId: active.view.id,
    mandateFingerprint: active.view.fingerprint,
    userId: input.userId,
    section: input.section,
    evidence,
    identity,
  });
  if (!claim.allowed) {
    let automaticallySuspended = false;
    if (
      claim.evaluation.automaticSuspensionRequired &&
      active.view.lifecycleState === "ACTIVE"
    ) {
      await transitionTradingMandate({
        mandateId: active.view.id,
        userId: input.userId,
        section: input.section,
        expectedRevision: active.view.revision,
        clientRequestId: deterministicUuid({
          type: "phase12-automatic-suspension",
          mandateId: active.view.id,
          decisionFingerprint,
          reasonCode: claim.evaluation.reasonCode,
        }),
        reason: claim.evaluation.reason,
        actorType: "SYSTEM",
        action: "SUSPEND",
        reasonCode: claim.evaluation.reasonCode,
      });
      automaticallySuspended = true;
    }
    return {
      allowed: false,
      reasonCode: claim.evaluation.reasonCode,
      reason: claim.evaluation.reason,
      fallbackEligible: claim.evaluation.fallbackEligible,
      automaticallySuspended,
    };
  }
  return {
    allowed: true,
    liveCommand,
    context: {
      claimId: claim.claimId,
      mandateId: active.view.id,
      mandateRevision: active.view.revision,
      mandateFingerprint: active.view.fingerprint,
      brainVersion: active.core.terms.brainVersion,
      brainFingerprint: active.core.terms.brainFingerprint,
      decisionFingerprint,
      riskFingerprint,
      configurationFingerprint: configFingerprint,
      idempotencyKey,
    },
  };
}
