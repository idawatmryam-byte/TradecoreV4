import type { TradePlan } from "../src/lib/strategies";
import {
  parseMarketState,
  type MarketState,
} from "../src/lib/intelligence/market-state/types";
import {
  buildPositionThesis,
  evaluatePositionThesis,
  parsePositionManagementAction,
  proposePositionAction,
  resolveManagementAuthority,
  validatePositionAction,
  type PositionSnapshot,
} from "../src/lib/intelligence/position";

let failures = 0;
function expect(name: string, condition: boolean): void {
  if (condition) console.log(`✓  ${name}`);
  else {
    failures++;
    console.error(`✗  ${name}`);
  }
}

const now = new Date("2026-08-09T12:00:00.000Z");
const plan: TradePlan = {
  strategyId: "phase7-fixture",
  strategyName: "Phase 7 Fixture",
  symbol: "BTCUSDT",
  side: "long",
  confidence: 75,
  entryPrice: 100,
  slPrice: 98,
  tpPrice: 104,
  qty: 2,
  leverage: 1,
  expectedHoldSeconds: 1800,
  maxHoldSeconds: 3600,
  regime: "strong_trend",
  netRewardRisk: 1.8,
  report: {
    summary: "Bullish continuation",
    marketView: ["Trend is aligned"],
    entryLogic: ["Closed breakout"],
    riskLogic: ["Stop below structure"],
    exitLogic: ["Target at two R"],
    checks: [{ name: "risk", passed: true, detail: "risk accepted" }],
  },
};

function market(overrides: Partial<MarketState> = {}): MarketState {
  const base = {
    schemaVersion: "1.0.0",
    marketStateVersion: "market-state-v1",
    fingerprint: "a".repeat(64),
    symbol: "BTCUSDT",
    venue: "spot",
    provider: "fixture",
    dataTimestamp: "2026-08-09T11:59:00.000Z",
    observedAt: now.toISOString(),
    freshness: { status: "fresh", ageMs: 60_000, maximumAgeMs: 180_000 },
    dataQuality: { status: "healthy", issues: [] },
    observations: {
      lastPrice: 101,
      timeframes: [
        ["1m", 60_000],
        ["3m", 180_000],
        ["5m", 300_000],
        ["15m", 900_000],
        ["1h", 3_600_000],
      ].map(([timeframe, intervalMs]) => ({
        timeframe,
        intervalMs,
        candleCount: 60,
        lastClosedAt: "2026-08-09T11:59:00.000Z",
        lastClose: 101,
        excludedOpenCandles: 1,
      })),
      trend: {
        tf3m: "bullish",
        tf5m: "bullish",
        tf15m: "bullish",
        tf1h: "bullish",
        alignedTimeframes: 4,
      },
      volatility: {
        atr: 0.5,
        atrPercent: 0.5,
        baselineAtrPercent: 0.4,
        ratioToBaseline: 1.25,
        phase: "normal",
      },
      momentum: {
        rsi5m: 60,
        macdHistogram3m: 1,
        longStructureScore: 75,
        shortStructureScore: 25,
      },
      liquidity: {
        volumeRatio: 1.2,
        proxyStatus: "normal",
        disclaimer: "Volume is a liquidity proxy, not order-book depth.",
      },
      structure: {
        supports: [99],
        resistances: [103],
        nearestSupport: 99,
        nearestResistance: 103,
      },
    },
    inferences: {
      regime: "strong_trend",
      regimeConfidence: 0.8,
      dominantDirection: "bullish",
      session: "europe_us_overlap",
      anomaly: { detected: false, reasonCodes: [] },
    },
    context: {
      breadth: { status: "unavailable", bullishFraction: null, sampleSize: 0 },
      leadership: { status: "unavailable", leader: null, score: null },
      correlation: {
        status: "unavailable",
        referenceSymbol: null,
        coefficient: null,
        sampleSize: 0,
      },
    },
  };
  return parseMarketState({ ...base, ...overrides });
}

const thesis = buildPositionThesis({
  plan,
  marketState: market(),
  createdAt: now,
  thesisId: "00000000-0000-4000-8000-000000000701",
});
const position: PositionSnapshot = {
  tradeId: 7,
  symbol: "BTCUSDT",
  side: "long",
  entryPrice: 100,
  currentStopPrice: 98,
  targetPrice: 104,
  remainingQuantity: 2,
  openedAt: new Date("2026-08-09T11:50:00.000Z"),
};

expect(
  "Demo active assigns Phase 7 as the sole owner",
  resolveManagementAuthority({
    requestedMode: "phase7_active",
    executionTarget: "demo",
    testnet: false,
    tradingMode: "autopilot",
  }).authority === "phase7",
);
expect(
  "Binance testnet/OANDA practice active assigns Phase 7",
  resolveManagementAuthority({
    requestedMode: "phase7_active",
    executionTarget: "live",
    testnet: true,
    tradingMode: "autopilot",
  }).phase7MayMutate,
);
expect(
  "real Live defensively downgrades active Phase 7 to fixed/Shadow",
  resolveManagementAuthority({
    requestedMode: "phase7_active",
    executionTarget: "live",
    testnet: false,
    tradingMode: "autopilot",
  }).effectiveMode === "phase7_shadow",
);
expect(
  "Shadow keeps fixed as the mutating owner",
  resolveManagementAuthority({
    requestedMode: "phase7_shadow",
    executionTarget: "demo",
    testnet: true,
    tradingMode: "autopilot",
  }).authority === "fixed",
);

const valid = evaluatePositionThesis({
  thesis,
  position,
  marketState: market(),
  evaluatedAt: now,
});
expect("healthy aligned state is VALID", valid.state === "VALID");
expect(
  "evaluation fingerprint is deterministic",
  valid.fingerprint ===
    evaluatePositionThesis({
      thesis,
      position,
      marketState: market(),
      evaluatedAt: now,
    }).fingerprint,
);
const hold = proposePositionAction({
  thesis,
  evaluation: valid,
  position,
  marketState: market(),
  reductionAlreadyApplied: false,
  proposedAt: now,
});
expect(
  "valid thesis below the trailing threshold proposes HOLD",
  hold.type === "HOLD",
);
const repeatedHold = proposePositionAction({
  thesis,
  evaluation: valid,
  position,
  marketState: market(),
  reductionAlreadyApplied: false,
  proposedAt: now,
  actionId: "00000000-0000-4000-8000-000000000703",
});
expect(
  "equivalent proposals share an idempotency fingerprint",
  hold.fingerprint === repeatedHold.fingerprint,
);

const trendingMarket = market({
  observations: { ...market().observations, lastPrice: 102.5 },
});
const trending = evaluatePositionThesis({
  thesis,
  position,
  marketState: trendingMarket,
  evaluatedAt: now,
});
const trail = proposePositionAction({
  thesis,
  evaluation: trending,
  position,
  marketState: trendingMarket,
  reductionAlreadyApplied: false,
  proposedAt: now,
});
expect(
  "a valid thesis above one R proposes the approved ATR trail",
  trail.type === "APPLY_TRAILING" && trail.trailingMode === "atr",
);
expect(
  "the approved ATR trail passes deterministic validation",
  validatePositionAction(trail, thesis, position, 102.5, now).valid,
);

const weakeningMarket = market({
  observations: {
    ...market().observations,
    lastPrice: 100.6,
    trend: { ...market().observations.trend, alignedTimeframes: 1 },
  },
  inferences: { ...market().inferences, dominantDirection: "bearish" },
});
const weakening = evaluatePositionThesis({
  thesis,
  position,
  marketState: weakeningMarket,
  evaluatedAt: now,
});
const tighten = proposePositionAction({
  thesis,
  evaluation: weakening,
  position,
  marketState: weakeningMarket,
  reductionAlreadyApplied: false,
  proposedAt: now,
});
expect(
  "a progressing but weakening thesis tightens to break-even",
  weakening.state === "WEAKENING" &&
    tighten.type === "TIGHTEN_STOP" &&
    tighten.proposedStopPrice === 100,
);
expect(
  "break-even tightening passes deterministic validation",
  validatePositionAction(tighten, thesis, position, 100.6, now).valid,
);

const stale = evaluatePositionThesis({
  thesis,
  position,
  marketState: market({
    freshness: { status: "stale", ageMs: 999_999, maximumAgeMs: 180_000 },
  }),
  evaluatedAt: now,
});
expect("stale data produces DATA_UNCERTAIN", stale.state === "DATA_UNCERTAIN");
const freeze = proposePositionAction({
  thesis,
  evaluation: stale,
  position,
  marketState: null,
  reductionAlreadyApplied: false,
  proposedAt: now,
});
expect("uncertain data proposes FREEZE", freeze.type === "FREEZE");
expect(
  "FREEZE remains valid without a trusted current price",
  validatePositionAction(freeze, thesis, position, Number.NaN, now).valid,
);

const opposedMarket = market({
  observations: {
    ...market().observations,
    trend: {
      tf3m: "bearish",
      tf5m: "bearish",
      tf15m: "bearish",
      tf1h: "bearish",
      alignedTimeframes: 4,
    },
  },
  inferences: { ...market().inferences, dominantDirection: "bearish" },
});
const invalidated = evaluatePositionThesis({
  thesis,
  position,
  marketState: opposedMarket,
  evaluatedAt: now,
});
const exit = proposePositionAction({
  thesis,
  evaluation: invalidated,
  position,
  marketState: opposedMarket,
  reductionAlreadyApplied: false,
  proposedAt: now,
});
expect(
  "strong opposition invalidates the thesis",
  invalidated.state === "INVALIDATED",
);
expect("invalidation proposes EXIT", exit.type === "EXIT");
expect(
  "deterministic validation permits an invalidation exit",
  validatePositionAction(exit, thesis, position, 101, now).valid,
);

const degradedAt = new Date("2026-08-09T12:25:00.000Z");
const flatMarket = market({
  observations: { ...market().observations, lastPrice: 100.1 },
});
const degraded = evaluatePositionThesis({
  thesis,
  position,
  marketState: flatMarket,
  evaluatedAt: degradedAt,
});
const reduce = proposePositionAction({
  thesis,
  evaluation: degraded,
  position,
  marketState: flatMarket,
  reductionAlreadyApplied: false,
  proposedAt: degradedAt,
});
expect(
  "late, non-progressing target is TARGET_DEGRADED",
  degraded.state === "TARGET_DEGRADED",
);
expect(
  "target degradation proposes one bounded reduction",
  reduce.type === "REDUCE" && reduce.reductionFraction === 0.5,
);
expect(
  "reduction cannot increase maximum loss",
  validatePositionAction(reduce, thesis, position, 100.1, degradedAt)
    .proposedMaximumLoss <=
    validatePositionAction(reduce, thesis, position, 100.1, degradedAt)
      .currentMaximumLoss,
);
expect(
  "an already-reduced position cannot be reduced again",
  proposePositionAction({
    thesis,
    evaluation: degraded,
    position,
    marketState: flatMarket,
    reductionAlreadyApplied: true,
    proposedAt: degradedAt,
  }).type === "HOLD",
);

const widening = parsePositionManagementAction({
  ...reduce,
  type: "TIGHTEN_STOP",
  reductionFraction: null,
  proposedStopPrice: 97,
  fingerprint: "b".repeat(64),
});
expect(
  "a long stop widening is refused",
  !validatePositionAction(widening, thesis, position, 101, now).valid,
);

const shortPlan = {
  ...plan,
  side: "short" as const,
  slPrice: 102,
  tpPrice: 96,
};
const shortThesis = buildPositionThesis({
  plan: shortPlan,
  marketState: market(),
  createdAt: now,
  thesisId: "00000000-0000-4000-8000-000000000702",
});
const shortPosition = {
  ...position,
  side: "short" as const,
  currentStopPrice: 102,
};
const shortWidening = parsePositionManagementAction({
  ...reduce,
  thesisId: shortThesis.thesisId,
  type: "TIGHTEN_STOP",
  reductionFraction: null,
  proposedStopPrice: 103,
  fingerprint: "c".repeat(64),
});
expect(
  "a short stop widening is refused",
  !validatePositionAction(shortWidening, shortThesis, shortPosition, 99, now)
    .valid,
);

console.log(
  failures === 0
    ? "\nAll Phase 7 position-management checks passed."
    : `\n${failures} Phase 7 check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
