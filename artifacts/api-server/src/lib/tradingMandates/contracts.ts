import { z } from "zod";
import { sha256Fingerprint } from "../intelligence/canonical";

export const TRADING_MANDATE_SCHEMA_VERSION =
  "phase12-trading-mandate-v1" as const;
export const MONEY_SCALE = 8 as const;

const AtomicAmountSchema = z.string().regex(/^[1-9][0-9]*$/);
const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/i);

export const TradingMandateStateSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
  "EXPIRED",
  "REPLACED",
  "RETIRED",
]);

export const TradingMandateWindowSchema = z
  .object({
    timezone: z.string().min(1).max(80),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .strict()
  .superRefine((window, ctx) => {
    if (window.endMinute <= window.startMinute) {
      ctx.addIssue({
        code: "custom",
        path: ["endMinute"],
        message:
          "must be after startMinute; split overnight hours into two windows",
      });
    }
    if (new Set(window.daysOfWeek).size !== window.daysOfWeek.length) {
      ctx.addIssue({
        code: "custom",
        path: ["daysOfWeek"],
        message: "days must be unique",
      });
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: window.timezone }).format(
        new Date(0),
      );
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["timezone"],
        message: "must be a supported IANA timezone",
      });
    }
  });

export const AutomaticSuspensionSchema = z
  .object({
    maximumSpreadBps: z.number().int().min(1).max(10_000),
    maximumSlippageBps: z.number().int().min(1).max(10_000),
    maximumFillLatencyMs: z.number().int().min(1).max(300_000),
    maximumProtectionFailures: z.number().int().min(0).max(100),
    maximumReconciliationAgeSeconds: z.number().int().min(1).max(3_600),
    maximumDecisionRatePerHour: z.number().int().min(1).max(10_000),
    maximumEntryRatePerHour: z.number().int().min(1).max(1_000),
    maximumLiveDemoDivergenceBps: z.number().int().min(1).max(10_000),
    maximumMarketDataAgeSeconds: z.number().int().min(1).max(300),
  })
  .strict();

const TermsFieldsSchema = z.object({
  brainVersionId: z.number().int().positive(),
  brainVersion: z.string().min(1).max(120),
  brainFingerprint: FingerprintSchema,
  accountIds: z.array(z.string().min(1).max(160)).min(1).max(20),
  exchanges: z
    .array(z.enum(["binance_spot_live", "binance_futures_live", "oanda_live"]))
    .min(1)
    .max(3),
  markets: z
    .array(z.enum(["spot", "futures", "forex"]))
    .min(1)
    .max(3),
  symbols: z.array(z.string().min(1).max(80)).min(1).max(50),
  strategies: z.record(z.string().min(1).max(120), z.string().min(1).max(160)),
  models: z.array(z.string().min(1).max(160)).min(1).max(20),
  settlementCurrency: z.enum(["USD", "USDT"]),
  monetaryScale: z.literal(MONEY_SCALE),
  maximumPerTradeRisk: AtomicAmountSchema,
  maximumPositionNotional: AtomicAmountSchema,
  maximumAggregateExposure: AtomicAmountSchema,
  maximumLeverageBps: z.number().int().min(10_000).max(1_250_000),
  maximumConcurrentPositions: z.number().int().min(1).max(1_000),
  maximumConcurrentOrders: z.number().int().min(1).max(1_000),
  dailyLossLimit: AtomicAmountSchema,
  weeklyLossLimit: AtomicAmountSchema,
  monthlyLossLimit: AtomicAmountSchema,
  maximumDrawdownBps: z.number().int().min(1).max(10_000),
  tradingHours: z.array(TradingMandateWindowSchema).min(1).max(32),
  effectiveAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  canaryAllocation: AtomicAmountSchema,
  automaticSuspension: AutomaticSuspensionSchema,
  fallbackPolicy: z.enum(["COPILOT_VALID_ONLY", "ABSTAIN"]),
});

function validateTerms(
  value: z.infer<typeof TermsFieldsSchema>,
  ctx: z.RefinementCtx,
): void {
  const effective = Date.parse(value.effectiveAt);
  const expiry = Date.parse(value.expiresAt);
  if (expiry <= effective) {
    ctx.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "must be after effectiveAt",
    });
  }
  if (expiry - effective > 30 * 24 * 60 * 60 * 1_000) {
    ctx.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Restricted Live authority may not exceed 30 days",
    });
  }
  if (Object.keys(value.strategies).length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["strategies"],
      message: "at least one exact strategy version is required",
    });
  }
  if (BigInt(value.canaryAllocation) > BigInt(value.maximumAggregateExposure)) {
    ctx.addIssue({
      code: "custom",
      path: ["canaryAllocation"],
      message: "may not exceed maximumAggregateExposure",
    });
  }
  if (
    value.markets.includes("forex") !== value.exchanges.includes("oanda_live")
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["markets"],
      message: "forex scope and oanda_live authority must be declared together",
    });
  }
  if (
    value.markets.includes("spot") !==
    value.exchanges.includes("binance_spot_live")
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["markets"],
      message:
        "spot scope and binance_spot_live authority must be declared together",
    });
  }
  if (
    value.markets.includes("futures") !==
    value.exchanges.includes("binance_futures_live")
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["markets"],
      message:
        "futures scope and binance_futures_live authority must be declared together",
    });
  }
}

export const TradingMandateTermsSchema =
  TermsFieldsSchema.strict().superRefine(validateTerms);

export const TradingMandateCoreSchema = z
  .object({
    schemaVersion: z.literal(TRADING_MANDATE_SCHEMA_VERSION),
    mandateKey: z.string().uuid(),
    revision: z.number().int().positive(),
    replacesMandateId: z.number().int().positive().nullable(),
    userId: z.number().int().positive(),
    tenantId: z.string().min(1).max(160),
    section: z.enum(["crypto", "forex"]),
    terms: TradingMandateTermsSchema,
    changeReason: z.string().min(12).max(1_000),
  })
  .strict();

export type TradingMandateTerms = z.infer<typeof TradingMandateTermsSchema>;
export type TradingMandateCore = z.infer<typeof TradingMandateCoreSchema>;
export type TradingMandateState = z.infer<typeof TradingMandateStateSchema>;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Canonicalize scope before hashing or persistence. Empty/duplicate input fails. */
export function canonicalizeTradingMandateTerms(
  input: TradingMandateTerms,
): TradingMandateTerms {
  const parsed = TradingMandateTermsSchema.parse(input);
  const canonical = {
    ...parsed,
    brainFingerprint: parsed.brainFingerprint.toLowerCase(),
    accountIds: sortedUnique(parsed.accountIds),
    exchanges: sortedUnique(
      parsed.exchanges,
    ) as TradingMandateTerms["exchanges"],
    markets: sortedUnique(parsed.markets) as TradingMandateTerms["markets"],
    symbols: sortedUnique(parsed.symbols.map((symbol) => symbol.toUpperCase())),
    strategies: Object.fromEntries(
      Object.entries(parsed.strategies)
        .map(([key, value]) => [key.trim(), value.trim()] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    models: sortedUnique(parsed.models),
    tradingHours: [...parsed.tradingHours]
      .map((window) => ({
        ...window,
        daysOfWeek: [...new Set(window.daysOfWeek)].sort((a, b) => a - b),
      }))
      .sort(
        (a, b) =>
          a.timezone.localeCompare(b.timezone) ||
          a.startMinute - b.startMinute ||
          a.endMinute - b.endMinute ||
          a.daysOfWeek.join(",").localeCompare(b.daysOfWeek.join(",")),
      ),
  };
  const result = TradingMandateTermsSchema.parse(canonical);
  if (
    result.accountIds.length !== parsed.accountIds.length ||
    result.exchanges.length !== parsed.exchanges.length ||
    result.markets.length !== parsed.markets.length ||
    result.symbols.length !== parsed.symbols.length ||
    result.models.length !== parsed.models.length
  ) {
    throw new Error("Mandate scope must not contain duplicates");
  }
  return result;
}

export function tradingMandateFingerprint(core: TradingMandateCore): string {
  const parsed = TradingMandateCoreSchema.parse({
    ...core,
    terms: canonicalizeTradingMandateTerms(core.terms),
  });
  return sha256Fingerprint(parsed);
}

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function isWithinMandateHours(
  now: Date,
  windows: TradingMandateTerms["tradingHours"],
): boolean {
  return windows.some((window) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: window.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    const day = WEEKDAY[values.weekday ?? ""];
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    if (
      day === undefined ||
      !Number.isInteger(hour) ||
      !Number.isInteger(minute)
    ) {
      return false;
    }
    const localMinute = hour * 60 + minute;
    return (
      window.daysOfWeek.includes(day) &&
      localMinute >= window.startMinute &&
      localMinute < window.endMinute
    );
  });
}

export interface RestrictedLiveEvidence {
  now: Date;
  lifecycleState: TradingMandateState;
  tenantId: string;
  userId: number;
  section: "crypto" | "forex";
  accountId: string | null;
  executionAuthority:
    | "binance_spot_live"
    | "binance_futures_live"
    | "oanda_live"
    | string;
  market: "spot" | "futures" | "forex";
  symbol: string;
  strategyId: string;
  strategyVersion: string;
  model: string;
  brainVersion: string;
  brainFingerprint: string;
  perTradeRisk: bigint | null;
  positionNotional: bigint | null;
  aggregateExposure: bigint | null;
  canaryUsed: bigint | null;
  leverageBps: number | null;
  openPositionCount: number | null;
  openOrderCount: number | null;
  dailyLoss: bigint | null;
  weeklyLoss: bigint | null;
  monthlyLoss: bigint | null;
  drawdownBps: number | null;
  decisionsLastHour: number | null;
  entriesLastHour: number | null;
  executedEntriesLastHour?: number | null;
  spreadBps: number | null;
  expectedSlippageBps: number | null;
  fillLatencyMs: number | null;
  protectionFailures: number | null;
  reconciliationAgeSeconds: number | null;
  liveDemoDivergenceBps: number | null;
  marketDataAgeSeconds: number | null;
  deterministicRiskPassed: boolean;
  currentStateRevalidated: boolean;
  phase11Healthy: boolean;
  killSwitchActive: boolean;
  blockingOperatingMode: boolean;
  decisionId: string | null;
  riskDecisionId: string | null;
  planFingerprint: string | null;
  configurationFingerprint: string | null;
  ownershipGeneration: number | null;
}

export interface MandateCheck {
  name: string;
  passed: boolean;
  reasonCode: string;
  detail: string;
  fallbackEligible: boolean;
}

export interface MandateEvaluation {
  allowed: boolean;
  reasonCode: string;
  reason: string;
  fallbackEligible: boolean;
  automaticSuspensionRequired: boolean;
  checks: MandateCheck[];
}

function within(actual: bigint | null, maximum: string): boolean {
  return actual !== null && actual <= BigInt(maximum);
}

function below(actual: bigint | null, limit: string): boolean {
  return actual !== null && actual < BigInt(limit);
}

function check(
  name: string,
  passed: boolean,
  reasonCode: string,
  detail: string,
  fallbackEligible = false,
): MandateCheck {
  return { name, passed, reasonCode, detail, fallbackEligible };
}

/**
 * Pure Phase 12 gate. Maximum risk/exposure/leverage/canary limits are
 * inclusive. Loss, drawdown, expiry, rate, and suspension thresholds block at
 * equality. Missing financial or safety evidence always fails closed.
 */
export function evaluateRestrictedLiveEntry(
  coreInput: TradingMandateCore,
  evidence: RestrictedLiveEvidence,
): MandateEvaluation {
  const core = TradingMandateCoreSchema.parse({
    ...coreInput,
    terms: canonicalizeTradingMandateTerms(coreInput.terms),
  });
  const terms = core.terms;
  const atOrBelow = (actual: number | null, limit: number) =>
    actual !== null && Number.isInteger(actual) && actual <= limit;
  const belowThreshold = (actual: number | null, limit: number) =>
    actual !== null && Number.isFinite(actual) && actual < limit;
  const validIdentity =
    Boolean(evidence.decisionId) &&
    Boolean(evidence.riskDecisionId) &&
    Boolean(evidence.planFingerprint) &&
    Boolean(evidence.configurationFingerprint) &&
    evidence.ownershipGeneration !== null &&
    Number.isInteger(evidence.ownershipGeneration) &&
    evidence.ownershipGeneration > 0;
  const executedEntriesLastHour =
    evidence.executedEntriesLastHour ?? evidence.entriesLastHour;
  const checks: MandateCheck[] = [
    check(
      "Lifecycle",
      evidence.lifecycleState === "ACTIVE",
      `MANDATE_${evidence.lifecycleState}`,
      `Mandate state is ${evidence.lifecycleState}`,
    ),
    check(
      "Effective time",
      evidence.now.getTime() >= Date.parse(terms.effectiveAt),
      "MANDATE_NOT_YET_EFFECTIVE",
      `Effective at ${terms.effectiveAt}`,
    ),
    check(
      "Hard expiry",
      evidence.now.getTime() < Date.parse(terms.expiresAt),
      "MANDATE_EXPIRED",
      `Expires exclusively at ${terms.expiresAt}`,
    ),
    check(
      "Tenant",
      evidence.tenantId === core.tenantId,
      "TENANT_SCOPE_MISMATCH",
      "Tenant binding must match",
    ),
    check(
      "User",
      evidence.userId === core.userId,
      "USER_SCOPE_MISMATCH",
      "User binding must match",
    ),
    check(
      "Section",
      evidence.section === core.section,
      "SECTION_SCOPE_MISMATCH",
      "Trading section must match",
    ),
    check(
      "Account",
      evidence.accountId !== null &&
        terms.accountIds.includes(evidence.accountId),
      "ACCOUNT_SCOPE_MISMATCH",
      `Account ${evidence.accountId ?? "UNKNOWN"} is outside scope`,
      true,
    ),
    check(
      "Exchange",
      terms.exchanges.includes(
        evidence.executionAuthority as TradingMandateTerms["exchanges"][number],
      ),
      "EXCHANGE_SCOPE_MISMATCH",
      `Authority ${evidence.executionAuthority} is outside scope`,
      true,
    ),
    check(
      "Market",
      terms.markets.includes(evidence.market),
      "MARKET_SCOPE_MISMATCH",
      `Market ${evidence.market} is outside scope`,
      true,
    ),
    check(
      "Symbol",
      terms.symbols.includes(evidence.symbol.toUpperCase()),
      "SYMBOL_SCOPE_MISMATCH",
      `Symbol ${evidence.symbol} is outside scope`,
      true,
    ),
    check(
      "Strategy",
      terms.strategies[evidence.strategyId] === evidence.strategyVersion,
      "STRATEGY_SCOPE_MISMATCH",
      `Strategy ${evidence.strategyId}/${evidence.strategyVersion} is outside scope`,
      true,
    ),
    check(
      "Model",
      terms.models.includes(evidence.model),
      "MODEL_SCOPE_MISMATCH",
      `Model ${evidence.model} is outside scope`,
      true,
    ),
    check(
      "Brain version",
      evidence.brainVersion === terms.brainVersion &&
        evidence.brainFingerprint.toLowerCase() ===
          terms.brainFingerprint.toLowerCase(),
      "BRAIN_IDENTITY_MISMATCH",
      "Exact approved brain version and fingerprint are required",
    ),
    check(
      "Trading hours",
      isWithinMandateHours(evidence.now, terms.tradingHours),
      "OUTSIDE_TRADING_HOURS",
      "Current local mandate window is closed",
      true,
    ),
    check(
      "Per-trade risk",
      within(evidence.perTradeRisk, terms.maximumPerTradeRisk),
      "PER_TRADE_RISK_EXCEEDED",
      "Per-trade risk is missing or above the inclusive limit",
    ),
    check(
      "Position notional",
      within(evidence.positionNotional, terms.maximumPositionNotional),
      "POSITION_NOTIONAL_EXCEEDED",
      "Position notional is missing or above the inclusive limit",
    ),
    check(
      "Aggregate exposure",
      within(evidence.aggregateExposure, terms.maximumAggregateExposure),
      "AGGREGATE_EXPOSURE_EXCEEDED",
      "Aggregate exposure is missing or above the inclusive limit",
    ),
    check(
      "Canary allocation",
      evidence.positionNotional !== null &&
        evidence.canaryUsed !== null &&
        evidence.canaryUsed + evidence.positionNotional <=
          BigInt(terms.canaryAllocation),
      "CANARY_ALLOCATION_EXHAUSTED",
      "Canary allocation would be exceeded",
    ),
    check(
      "Leverage",
      atOrBelow(evidence.leverageBps, terms.maximumLeverageBps),
      "LEVERAGE_EXCEEDED",
      "Leverage is missing or above the inclusive limit",
    ),
    check(
      "Concurrent positions",
      evidence.openPositionCount !== null &&
        evidence.openPositionCount < terms.maximumConcurrentPositions,
      "POSITION_CONCURRENCY_EXHAUSTED",
      "Position capacity is exhausted",
    ),
    check(
      "Concurrent orders",
      evidence.openOrderCount !== null &&
        evidence.openOrderCount < terms.maximumConcurrentOrders,
      "ORDER_CONCURRENCY_EXHAUSTED",
      "Order capacity is exhausted",
    ),
    check(
      "Daily loss",
      below(evidence.dailyLoss, terms.dailyLossLimit),
      "DAILY_LOSS_LIMIT_REACHED",
      "Daily loss is unavailable or at/beyond the hard limit",
    ),
    check(
      "Weekly loss",
      below(evidence.weeklyLoss, terms.weeklyLossLimit),
      "WEEKLY_LOSS_LIMIT_REACHED",
      "Weekly loss is unavailable or at/beyond the hard limit",
    ),
    check(
      "Monthly loss",
      below(evidence.monthlyLoss, terms.monthlyLossLimit),
      "MONTHLY_LOSS_LIMIT_REACHED",
      "Monthly loss is unavailable or at/beyond the hard limit",
    ),
    check(
      "Drawdown",
      evidence.drawdownBps !== null &&
        evidence.drawdownBps < terms.maximumDrawdownBps,
      "DRAWDOWN_LIMIT_REACHED",
      "Drawdown is unavailable or at/beyond the hard limit",
    ),
    check(
      "Current-state revalidation",
      evidence.currentStateRevalidated,
      "CURRENT_STATE_REVALIDATION_FAILED",
      "Current market, portfolio, risk, and configuration state must be revalidated",
    ),
    check(
      "Phase 11 safety",
      evidence.phase11Healthy,
      "PHASE11_SAFETY_UNHEALTHY",
      "Reconciliation and protection must be healthy",
    ),
    check(
      "Kill switches",
      !evidence.killSwitchActive,
      "KILL_SWITCH_ACTIVE",
      "An applicable kill switch is active",
    ),
    check(
      "Operating mode",
      !evidence.blockingOperatingMode,
      "OPERATING_MODE_BLOCKS_ENTRY",
      "The durable operating mode blocks entry",
    ),
    check(
      "Deterministic risk",
      evidence.deterministicRiskPassed,
      "DETERMINISTIC_RISK_REFUSED",
      "Deterministic risk refused the entry",
    ),
    check(
      "Command identity",
      validIdentity,
      "COMMAND_IDENTITY_INVALID",
      "Decision, risk, plan, configuration, and ownership identity is required",
    ),
    check(
      "Market freshness",
      atOrBelow(
        evidence.marketDataAgeSeconds,
        terms.automaticSuspension.maximumMarketDataAgeSeconds,
      ),
      "MARKET_DATA_STALE",
      "Market data is unavailable or stale",
    ),
    check(
      "Reconciliation freshness",
      belowThreshold(
        evidence.reconciliationAgeSeconds,
        terms.automaticSuspension.maximumReconciliationAgeSeconds,
      ),
      "RECONCILIATION_STALE",
      "Reconciliation is unavailable or stale",
    ),
    check(
      "Spread",
      belowThreshold(
        evidence.spreadBps,
        terms.automaticSuspension.maximumSpreadBps,
      ),
      "SPREAD_THRESHOLD_REACHED",
      "Spread is unavailable or at/beyond suspension threshold",
    ),
    check(
      "Expected slippage",
      belowThreshold(
        evidence.expectedSlippageBps,
        terms.automaticSuspension.maximumSlippageBps,
      ),
      "SLIPPAGE_THRESHOLD_REACHED",
      "Expected slippage is unavailable or at/beyond suspension threshold",
    ),
    check(
      "Fill latency",
      executedEntriesLastHour === 0 ||
        belowThreshold(
          evidence.fillLatencyMs,
          terms.automaticSuspension.maximumFillLatencyMs,
        ),
      "LATENCY_THRESHOLD_REACHED",
      executedEntriesLastHour === 0
        ? "No prior canary fill requires latency evidence"
        : "Fill latency is unavailable or at/beyond suspension threshold",
    ),
    check(
      "Protection failures",
      atOrBelow(
        evidence.protectionFailures,
        terms.automaticSuspension.maximumProtectionFailures,
      ),
      "PROTECTION_FAILURE_THRESHOLD_REACHED",
      "Protection failure threshold is exceeded",
    ),
    check(
      "Decision rate",
      evidence.decisionsLastHour !== null &&
        evidence.decisionsLastHour <
          terms.automaticSuspension.maximumDecisionRatePerHour,
      "DECISION_RATE_THRESHOLD_REACHED",
      "Decision-rate threshold is reached",
    ),
    check(
      "Entry rate",
      evidence.entriesLastHour !== null &&
        evidence.entriesLastHour <
          terms.automaticSuspension.maximumEntryRatePerHour,
      "ENTRY_RATE_THRESHOLD_REACHED",
      "Entry-rate threshold is reached",
    ),
    check(
      "Live/Demo divergence",
      executedEntriesLastHour === 0 ||
        belowThreshold(
          evidence.liveDemoDivergenceBps,
          terms.automaticSuspension.maximumLiveDemoDivergenceBps,
        ),
      "LIVE_DEMO_DIVERGENCE_THRESHOLD_REACHED",
      executedEntriesLastHour === 0
        ? "No prior canary fill requires divergence evidence"
        : "Live/Demo divergence is unavailable or at/beyond suspension threshold",
    ),
  ];
  const failed = checks.find((item) => !item.passed);
  if (!failed) {
    return {
      allowed: true,
      reasonCode: "RESTRICTED_LIVE_AUTHORIZED",
      reason: "Exact mandate and all deterministic Live gates passed",
      fallbackEligible: false,
      automaticSuspensionRequired: false,
      checks,
    };
  }
  const suspensionCodes = new Set([
    "MANDATE_EXPIRED",
    "BRAIN_IDENTITY_MISMATCH",
    "CANARY_ALLOCATION_EXHAUSTED",
    "DAILY_LOSS_LIMIT_REACHED",
    "WEEKLY_LOSS_LIMIT_REACHED",
    "MONTHLY_LOSS_LIMIT_REACHED",
    "DRAWDOWN_LIMIT_REACHED",
    "PHASE11_SAFETY_UNHEALTHY",
    "KILL_SWITCH_ACTIVE",
    "MARKET_DATA_STALE",
    "RECONCILIATION_STALE",
    "SPREAD_THRESHOLD_REACHED",
    "SLIPPAGE_THRESHOLD_REACHED",
    "LATENCY_THRESHOLD_REACHED",
    "PROTECTION_FAILURE_THRESHOLD_REACHED",
    "DECISION_RATE_THRESHOLD_REACHED",
    "ENTRY_RATE_THRESHOLD_REACHED",
    "LIVE_DEMO_DIVERGENCE_THRESHOLD_REACHED",
  ]);
  return {
    allowed: false,
    reasonCode: failed.reasonCode,
    reason: failed.detail,
    fallbackEligible:
      failed.fallbackEligible && terms.fallbackPolicy === "COPILOT_VALID_ONLY",
    automaticSuspensionRequired: suspensionCodes.has(failed.reasonCode),
    checks,
  };
}
