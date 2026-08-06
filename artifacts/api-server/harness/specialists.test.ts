import { strict as assert } from "node:assert";
import type { Strategy, StrategyConfig, TradePlan, TradeRejection } from "../src/lib/strategies/base";
import { parseMarketState } from "../src/lib/intelligence/market-state/types";
import { buildSpecialistCouncilSnapshot } from "../src/lib/intelligence/specialists";

const marketState = parseMarketState({
  schemaVersion: "1.0.0",
  marketStateVersion: "market-state-v1",
  fingerprint: "a".repeat(64),
  symbol: "BTCUSDT",
  venue: "spot",
  provider: "fixture",
  dataTimestamp: "2026-08-06T12:00:00.000Z",
  observedAt: "2026-08-06T12:00:01.000Z",
  freshness: { status: "fresh", ageMs: 1000, maximumAgeMs: 180000 },
  dataQuality: { status: "healthy", issues: [] },
  observations: {
    lastPrice: 100,
    timeframes: ["1m", "3m", "5m", "15m", "1h"].map((timeframe, index) => ({
      timeframe,
      intervalMs: [60000, 180000, 300000, 900000, 3600000][index],
      candleCount: 100,
      lastClosedAt: "2026-08-06T12:00:00.000Z",
      lastClose: 100,
      excludedOpenCandles: 1,
    })),
    trend: { tf3m: "bullish", tf5m: "bullish", tf15m: "bullish", tf1h: "bullish", alignedTimeframes: 4 },
    volatility: { atr: 2, atrPercent: 2, baselineAtrPercent: 1.5, ratioToBaseline: 1.33, phase: "normal" },
    momentum: { rsi5m: 62, macdHistogram3m: 1, longStructureScore: 78, shortStructureScore: 22 },
    liquidity: { volumeRatio: 1.4, proxyStatus: "elevated", disclaimer: "Volume is a liquidity proxy, not order-book depth." },
    structure: { supports: [95], resistances: [110], nearestSupport: 95, nearestResistance: 110 },
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
    correlation: { status: "unavailable", referenceSymbol: null, coefficient: null, sampleSize: 0 },
  },
});

function strategy(strategyId: string, regimes: string[] = ["strong_trend"]): Strategy {
  return {
    strategyId,
    strategyName: strategyId.replaceAll("_", " "),
    supportedRegimes: regimes as Strategy["supportedRegimes"],
    indicators: ["fixture"],
    evaluate: () => null,
  };
}

function config(strategyId: string, enabled = true): StrategyConfig {
  return {
    strategyId,
    enabled,
    maxHoldingSeconds: 3600,
  } as StrategyConfig;
}

function plan(strategyId: string, side: "long" | "short", confidence = 80): TradePlan {
  return {
    strategyId,
    strategyName: strategyId,
    symbol: "BTCUSDT",
    side,
    confidence,
    entryPrice: 100,
    slPrice: side === "long" ? 95 : 105,
    tpPrice: side === "long" ? 110 : 90,
    qty: 1,
    leverage: 1,
    expectedHoldSeconds: 900,
    maxHoldSeconds: 3600,
    regime: "strong_trend",
    netRewardRisk: 2,
    report: {
      summary: `${side} fixture thesis`,
      marketView: ["Trend aligned across timeframes"],
      entryLogic: ["Closed-candle trigger confirmed"],
      riskLogic: ["Stop outside normal noise"],
      exitLogic: ["Target at structure"],
      checks: [{ name: "Fixture", passed: true, detail: "valid" }],
    },
  };
}

function rejection(strategyId: string): TradeRejection {
  return {
    strategyId,
    strategyName: strategyId,
    symbol: "BTCUSDT",
    stage: "reward-risk",
    reason: "Net reward:risk is below the cost-aware floor",
    confidence: 70,
  };
}

function build(
  strategies: Strategy[],
  plans: TradePlan[] = [],
  rejections: TradeRejection[] = [],
  configs = new Map(strategies.map((item) => [item.strategyId, config(item.strategyId)])),
) {
  return buildSpecialistCouncilSnapshot({
    marketState,
    strategies,
    configs,
    plans,
    rejections,
    generatedAt: new Date("2026-08-06T12:00:02.000Z"),
  });
}

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`✓ ${name}`);
}

const trend = strategy("trend_pullback");
const noSetup = build([trend]);
check("eligible no-setup strategies produce explicit abstentions", () => {
  assert.equal(noSetup.opinions.length, 1);
  assert.equal(noSetup.opinions[0]!.opinion.stance, "abstain");
  assert.match(noSetup.opinions[0]!.opinion.abstentionReason ?? "", /No tradeable setup/);
});

const planned = build([trend], [plan("trend_pullback", "long", 82)]);
check("Brain V0 plans map to evidence-linked directional opinions", () => {
  const opinion = planned.opinions[0]!.opinion;
  assert.equal(opinion.stance, "long");
  assert.equal(opinion.strength, 0.82);
  assert.ok(opinion.supportingEvidence.length >= 2);
  assert.equal(opinion.marketStateFingerprint, marketState.fingerprint);
});

check("opinion identifiers are deterministic for replay", () => {
  const replay = build([trend], [plan("trend_pullback", "long", 82)]);
  assert.equal(replay.opinions[0]!.opinion.opinionId, planned.opinions[0]!.opinion.opinionId);
});

const rejected = build([trend], [], [rejection("trend_pullback")]);
check("reasoned rejections become opposing evidence and abstention", () => {
  const opinion = rejected.opinions[0]!.opinion;
  assert.equal(opinion.stance, "abstain");
  assert.equal(opinion.opposingEvidence.length, 1);
  assert.match(opinion.opposingEvidence[0]!.summary, /reward:risk/);
});

const correlated = build(
  [strategy("mean_reversion"), strategy("vwap_reversion")],
  [plan("mean_reversion", "long", 80), plan("vwap_reversion", "long", 70)],
);
check("correlated same-direction hypotheses receive diminishing weight", () => {
  const views = correlated.opinions.sort((a, b) => b.opinion.strength - a.opinion.strength);
  assert.equal(views[0]!.correlationDiscount, 1);
  assert.equal(views[1]!.correlationDiscount, 0.5);
  assert.equal(views[1]!.effectiveStrength, 0.35);
});

const disagreement = build(
  [strategy("mean_reversion"), strategy("vwap_reversion")],
  [plan("mean_reversion", "long", 80), plan("vwap_reversion", "short", 80)],
);
check("material long/short disagreement is explicit", () => {
  assert.equal(disagreement.consensus.stance, "mixed");
  assert.equal(disagreement.consensus.disagreement, true);
});

check("disabled strategies do not appear as current advisers", () => {
  const configs = new Map([["trend_pullback", config("trend_pullback", false)]]);
  assert.equal(build([trend], [], [], configs).opinions.length, 0);
});

check("regime-ineligible strategies do not fabricate opinions", () => {
  assert.equal(build([strategy("trend_pullback", ["range"])]).opinions.length, 0);
});

check("the council is immutable and structurally cannot execute", () => {
  assert.equal(planned.cannotExecute, true);
  assert.equal(planned.mode, "observational");
  assert.equal(Object.isFrozen(planned), true);
  assert.equal(Object.isFrozen(planned.opinions[0]!.opinion), true);
  const serialized = JSON.stringify(planned);
  assert.doesNotMatch(serialized, /broker|executor|authorizationReference|ExecutionCommand/);
});

check("opinion expiry is bounded to the observational window", () => {
  const expires = Date.parse(planned.opinions[0]!.opinion.expiresAt);
  const generated = Date.parse(planned.generatedAt);
  assert.equal(expires - generated, 15 * 60_000);
});

check("specialist role and applicable regimes remain inspectable", () => {
  const view = planned.opinions[0]!;
  assert.equal(view.role, "trend");
  assert.deepEqual(view.opinion.applicableRegimes, ["strong_trend"]);
});

console.log(`Specialist council harness passed: ${checks}/${checks}`);
