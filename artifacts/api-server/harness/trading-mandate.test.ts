import {
  TradingMandateCoreSchema,
  TradingMandateTermsSchema,
  canonicalizeTradingMandateTerms,
  evaluateRestrictedLiveEntry,
  isWithinMandateHours,
  tradingMandateFingerprint,
  type RestrictedLiveEvidence,
  type TradingMandateCore,
  type TradingMandateState,
  type TradingMandateTerms,
} from "../src/lib/tradingMandates/contracts";
import { verifyFinancialRequestOrigin } from "../src/middleware/financialRequest";
import type { Request } from "express";

let failures = 0;
function expect(name: string, condition: boolean): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

const terms: TradingMandateTerms = {
  brainVersionId: 7,
  brainVersion: "brain-v0.12",
  brainFingerprint: "a".repeat(64),
  accountIds: ["account-a"],
  exchanges: ["binance_futures_live"],
  markets: ["futures"],
  symbols: ["BTCUSDT", "ETHUSDT"],
  strategies: { momentum: "strategy-v3" },
  models: ["brain-v0-control"],
  settlementCurrency: "USDT",
  monetaryScale: 8,
  maximumPerTradeRisk: "100",
  maximumPositionNotional: "1000",
  maximumAggregateExposure: "5000",
  maximumLeverageBps: 50_000,
  maximumConcurrentPositions: 3,
  maximumConcurrentOrders: 6,
  dailyLossLimit: "200",
  weeklyLossLimit: "500",
  monthlyLossLimit: "1000",
  maximumDrawdownBps: 500,
  tradingHours: [
    {
      timezone: "UTC",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 0,
      endMinute: 1440,
    },
  ],
  effectiveAt: "2026-08-24T00:00:00.000Z",
  expiresAt: "2026-08-31T00:00:00.000Z",
  canaryAllocation: "2000",
  automaticSuspension: {
    maximumSpreadBps: 50,
    maximumSlippageBps: 40,
    maximumFillLatencyMs: 5000,
    maximumProtectionFailures: 0,
    maximumReconciliationAgeSeconds: 60,
    maximumDecisionRatePerHour: 30,
    maximumEntryRatePerHour: 5,
    maximumLiveDemoDivergenceBps: 75,
    maximumMarketDataAgeSeconds: 30,
  },
  fallbackPolicy: "COPILOT_VALID_ONLY",
};
const core: TradingMandateCore = {
  schemaVersion: "phase12-trading-mandate-v1",
  mandateKey: "00000000-0000-4000-8000-000000000012",
  revision: 1,
  replacesMandateId: null,
  userId: 42,
  tenantId: "user:42",
  section: "crypto",
  terms,
  changeReason: "Initial conservative Restricted Live canary",
};
const evidence: RestrictedLiveEvidence = {
  now: new Date("2026-08-25T12:00:00.000Z"),
  lifecycleState: "ACTIVE",
  tenantId: "user:42",
  userId: 42,
  section: "crypto",
  accountId: "account-a",
  executionAuthority: "binance_futures_live",
  market: "futures",
  symbol: "BTCUSDT",
  strategyId: "momentum",
  strategyVersion: "strategy-v3",
  model: "brain-v0-control",
  brainVersion: "brain-v0.12",
  brainFingerprint: "a".repeat(64),
  perTradeRisk: 100n,
  positionNotional: 1000n,
  aggregateExposure: 5000n,
  canaryUsed: 1000n,
  leverageBps: 50_000,
  openPositionCount: 2,
  openOrderCount: 5,
  dailyLoss: 199n,
  weeklyLoss: 499n,
  monthlyLoss: 999n,
  drawdownBps: 499,
  decisionsLastHour: 29,
  entriesLastHour: 0,
  spreadBps: 49,
  expectedSlippageBps: 39,
  fillLatencyMs: null,
  protectionFailures: 0,
  reconciliationAgeSeconds: 59,
  liveDemoDivergenceBps: null,
  marketDataAgeSeconds: 30,
  deterministicRiskPassed: true,
  currentStateRevalidated: true,
  phase11Healthy: true,
  killSwitchActive: false,
  blockingOperatingMode: false,
  decisionId: "decision-1",
  riskDecisionId: "risk-1",
  planFingerprint: "plan-1",
  configurationFingerprint: "config-1",
  ownershipGeneration: 9,
};
function verdict(
  patch: Partial<RestrictedLiveEvidence> = {},
  termsPatch: Partial<TradingMandateTerms> = {},
) {
  return evaluateRestrictedLiveEntry(
    { ...core, terms: { ...terms, ...termsPatch } },
    { ...evidence, ...patch },
  );
}

expect(
  "canonical valid mandate is accepted",
  TradingMandateCoreSchema.safeParse(core).success,
);
expect("healthy exact-boundary command is authorized", verdict().allowed);
const shuffled = { ...terms, symbols: ["ethusdt", "BTCUSDT"] };
expect(
  "canonicalization normalizes and sorts symbols",
  canonicalizeTradingMandateTerms(shuffled).symbols.join(",") ===
    "BTCUSDT,ETHUSDT",
);
expect(
  "fingerprint is stable across order and case",
  tradingMandateFingerprint(core) ===
    tradingMandateFingerprint({ ...core, terms: shuffled }),
);
expect(
  "mandate tampering changes fingerprint",
  tradingMandateFingerprint(core) !==
    tradingMandateFingerprint({
      ...core,
      terms: { ...terms, maximumPerTradeRisk: "101" },
    }),
);
expect(
  "unknown client financial state is rejected",
  !TradingMandateTermsSchema.safeParse({ ...terms, clientExposure: "0" })
    .success,
);
expect(
  "duplicate scope is rejected",
  (() => {
    try {
      canonicalizeTradingMandateTerms({
        ...terms,
        symbols: ["BTCUSDT", "btcusdt"],
      });
      return false;
    } catch {
      return true;
    }
  })(),
);
expect(
  "invalid timezone is rejected",
  !TradingMandateTermsSchema.safeParse({
    ...terms,
    tradingHours: [
      {
        timezone: "Mars/Olympus",
        daysOfWeek: [1],
        startMinute: 0,
        endMinute: 60,
      },
    ],
  }).success,
);
expect(
  "authority longer than 30 days is rejected",
  !TradingMandateTermsSchema.safeParse({
    ...terms,
    expiresAt: "2026-10-01T00:00:00.000Z",
  }).success,
);

for (const state of [
  "DRAFT",
  "PENDING_APPROVAL",
  "SUSPENDED",
  "REVOKED",
  "EXPIRED",
  "REPLACED",
  "RETIRED",
] as TradingMandateState[]) {
  expect(
    `${state} has no entry authority`,
    verdict({ lifecycleState: state }).reasonCode === `MANDATE_${state}`,
  );
}
expect(
  "effective boundary is inclusive",
  verdict({ now: new Date(terms.effectiveAt) }).allowed,
);
expect(
  "before effective time blocks",
  verdict({ now: new Date(Date.parse(terms.effectiveAt) - 1) }).reasonCode ===
    "MANDATE_NOT_YET_EFFECTIVE",
);
expect(
  "expiry boundary is exclusive",
  verdict({ now: new Date(terms.expiresAt) }).reasonCode === "MANDATE_EXPIRED",
);
expect(
  "just before expiry is valid",
  verdict({ now: new Date(Date.parse(terms.expiresAt) - 1) }).allowed,
);
const localWindow = [
  {
    timezone: "Asia/Baghdad",
    daysOfWeek: [1],
    startMinute: 750,
    endMinute: 810,
  },
];
expect(
  "IANA local start is inclusive",
  isWithinMandateHours(new Date("2026-08-24T09:30:00.000Z"), localWindow),
);
expect(
  "IANA local end is exclusive",
  !isWithinMandateHours(new Date("2026-08-24T10:30:00.000Z"), localWindow),
);

for (const [name, patch, code, fallback] of [
  ["tenant", { tenantId: "user:41" }, "TENANT_SCOPE_MISMATCH", false],
  ["user", { userId: 41 }, "USER_SCOPE_MISMATCH", false],
  ["section", { section: "forex" }, "SECTION_SCOPE_MISMATCH", false],
  ["account", { accountId: "account-b" }, "ACCOUNT_SCOPE_MISMATCH", true],
  [
    "exchange",
    { executionAuthority: "binance_spot_live" },
    "EXCHANGE_SCOPE_MISMATCH",
    true,
  ],
  ["market", { market: "spot" }, "MARKET_SCOPE_MISMATCH", true],
  ["symbol", { symbol: "SOLUSDT" }, "SYMBOL_SCOPE_MISMATCH", true],
  [
    "strategy",
    { strategyVersion: "strategy-v4" },
    "STRATEGY_SCOPE_MISMATCH",
    true,
  ],
  ["model", { model: "other" }, "MODEL_SCOPE_MISMATCH", true],
] as const) {
  const result = verdict(patch as Partial<RestrictedLiveEvidence>);
  expect(`wrong ${name} is refused`, result.reasonCode === code);
  expect(
    `wrong ${name} fallback is safe`,
    result.fallbackEligible === fallback,
  );
}
expect(
  "brain mismatch is never fallback",
  !verdict({ brainVersion: "brain-v1" }).fallbackEligible,
);

for (const [name, key, limit, code] of [
  ["risk", "perTradeRisk", 100n, "PER_TRADE_RISK_EXCEEDED"],
  ["notional", "positionNotional", 1000n, "POSITION_NOTIONAL_EXCEEDED"],
  ["exposure", "aggregateExposure", 5000n, "AGGREGATE_EXPOSURE_EXCEEDED"],
  ["leverage", "leverageBps", 50_000, "LEVERAGE_EXCEEDED"],
] as const) {
  const below = typeof limit === "bigint" ? limit - 1n : limit - 1;
  const above = typeof limit === "bigint" ? limit + 1n : limit + 1;
  expect(`${name} below maximum passes`, verdict({ [key]: below }).allowed);
  expect(
    `${name} at inclusive maximum passes`,
    verdict({ [key]: limit }).allowed,
  );
  expect(
    `${name} above maximum blocks`,
    verdict({ [key]: above }).reasonCode === code,
  );
}
expect(
  "canary exact projected ceiling passes",
  verdict({ canaryUsed: 1000n }).allowed,
);
expect(
  "canary above projected ceiling blocks",
  verdict({ canaryUsed: 1001n }).reasonCode === "CANARY_ALLOCATION_EXHAUSTED",
);
expect(
  "positions at cap block",
  verdict({ openPositionCount: 3 }).reasonCode ===
    "POSITION_CONCURRENCY_EXHAUSTED",
);
expect(
  "orders at cap block",
  verdict({ openOrderCount: 6 }).reasonCode === "ORDER_CONCURRENCY_EXHAUSTED",
);

for (const [name, key, limit, code] of [
  ["daily loss", "dailyLoss", 200n, "DAILY_LOSS_LIMIT_REACHED"],
  ["weekly loss", "weeklyLoss", 500n, "WEEKLY_LOSS_LIMIT_REACHED"],
  ["monthly loss", "monthlyLoss", 1000n, "MONTHLY_LOSS_LIMIT_REACHED"],
  ["drawdown", "drawdownBps", 500, "DRAWDOWN_LIMIT_REACHED"],
  ["spread", "spreadBps", 50, "SPREAD_THRESHOLD_REACHED"],
  ["slippage", "expectedSlippageBps", 40, "SLIPPAGE_THRESHOLD_REACHED"],
  ["reconciliation", "reconciliationAgeSeconds", 60, "RECONCILIATION_STALE"],
  ["decision rate", "decisionsLastHour", 30, "DECISION_RATE_THRESHOLD_REACHED"],
] as const) {
  const below = typeof limit === "bigint" ? limit - 1n : limit - 1;
  const above = typeof limit === "bigint" ? limit + 1n : limit + 1;
  expect(`${name} below threshold passes`, verdict({ [key]: below }).allowed);
  expect(
    `${name} at threshold blocks`,
    verdict({ [key]: limit }).reasonCode === code,
  );
  expect(
    `${name} above threshold blocks`,
    verdict({ [key]: above }).reasonCode === code,
  );
}
expect(
  "market age at inclusive maximum passes",
  verdict({ marketDataAgeSeconds: 30 }).allowed,
);
expect(
  "market age above maximum blocks",
  verdict({ marketDataAgeSeconds: 31 }).reasonCode === "MARKET_DATA_STALE",
);
expect(
  "cold start does not invent latency",
  verdict({
    entriesLastHour: 0,
    fillLatencyMs: null,
    liveDemoDivergenceBps: null,
  }).allowed,
);
expect(
  "missing later latency fails closed",
  verdict({ entriesLastHour: 1, fillLatencyMs: null, liveDemoDivergenceBps: 0 })
    .reasonCode === "LATENCY_THRESHOLD_REACHED",
);
expect(
  "latency at threshold suspends",
  verdict({ entriesLastHour: 1, fillLatencyMs: 5000, liveDemoDivergenceBps: 0 })
    .automaticSuspensionRequired,
);
expect(
  "divergence at threshold suspends",
  verdict({ entriesLastHour: 1, fillLatencyMs: 1, liveDemoDivergenceBps: 75 })
    .reasonCode === "LIVE_DEMO_DIVERGENCE_THRESHOLD_REACHED",
);
expect(
  "kill switch precedence is deterministic",
  verdict({ killSwitchActive: true, deterministicRiskPassed: false })
    .reasonCode === "KILL_SWITCH_ACTIVE",
);
expect(
  "degraded mode blocks",
  verdict({ blockingOperatingMode: true }).reasonCode ===
    "OPERATING_MODE_BLOCKS_ENTRY",
);
expect(
  "Phase 11 unhealthy blocks",
  verdict({ phase11Healthy: false }).reasonCode === "PHASE11_SAFETY_UNHEALTHY",
);
expect(
  "risk rejection cannot fallback",
  !verdict({ deterministicRiskPassed: false }).fallbackEligible,
);
expect(
  "missing command identity blocks",
  verdict({ decisionId: null }).reasonCode === "COMMAND_IDENTITY_INVALID",
);
expect(
  "missing server exposure fails closed",
  verdict({ aggregateExposure: null }).reasonCode ===
    "AGGREGATE_EXPOSURE_EXCEEDED",
);
expect(
  "valid scope refusal is fallback-only",
  (() => {
    const result = verdict({ symbol: "SOLUSDT" });
    return !result.allowed && result.fallbackEligible;
  })(),
);
expect(
  "ABSTAIN disables scope fallback",
  !verdict({ symbol: "SOLUSDT" }, { fallbackPolicy: "ABSTAIN" })
    .fallbackEligible,
);
const request = (
  headers: Record<string, string>,
  authMethod: "cookie" | "basic" = "cookie",
) =>
  ({
    authMethod,
    get: (name: string) => headers[name.toLowerCase()],
  }) as Request;
expect(
  "same-origin cookie financial request passes CSRF gate",
  verifyFinancialRequestOrigin(
    request({
      origin: "https://tradecore.example",
      host: "tradecore.example",
      "sec-fetch-site": "same-origin",
    }),
  ).ok,
);
expect(
  "cross-site cookie financial request fails CSRF gate",
  !verifyFinancialRequestOrigin(
    request({
      origin: "https://evil.example",
      host: "tradecore.example",
      "sec-fetch-site": "cross-site",
    }),
  ).ok,
);
expect(
  "missing Origin fails closed for cookie authority",
  !verifyFinancialRequestOrigin(request({ host: "tradecore.example" })).ok,
);
expect(
  "fresh Basic reauthentication does not depend on browser Origin",
  verifyFinancialRequestOrigin(request({}, "basic")).ok,
);

if (failures) {
  console.error(`\n${failures} Phase 12 test(s) failed`);
  process.exit(1);
}
console.log("\nAll Phase 12 TradingMandate tests passed");
