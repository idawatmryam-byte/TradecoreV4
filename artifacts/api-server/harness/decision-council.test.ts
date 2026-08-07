
import { strict as assert } from "node:assert";
import type { Strategy, StrategyConfig, TradePlan } from "../src/lib/strategies/base";
import { parseMarketState } from "../src/lib/intelligence/market-state/types";
import { buildSpecialistCouncilSnapshot } from "../src/lib/intelligence/specialists";
import {
  CouncilReasoningGateway,
  DecisionCouncil,
  aggregateDecisionCouncil,
  type EvaluateDecisionCouncilInput,
  type ReasoningProvider,
} from "../src/lib/intelligence/council";

const marketState = parseMarketState({
  schemaVersion: "1.0.0",
  marketStateVersion: "market-state-v1",
  fingerprint: "b".repeat(64),
  symbol: "BTCUSDT",
  venue: "spot",
  provider: "fixture",
  dataTimestamp: "2026-08-07T12:00:00.000Z",
  observedAt: "2026-08-07T12:00:01.000Z",
  freshness: { status: "fresh", ageMs: 1000, maximumAgeMs: 180000 },
  dataQuality: { status: "healthy", issues: [] },
  observations: {
    lastPrice: 100,
    timeframes: ["1m", "3m", "5m", "15m", "1h"].map((timeframe, index) => ({
      timeframe,
      intervalMs: [60000, 180000, 300000, 900000, 3600000][index],
      candleCount: 100,
      lastClosedAt: "2026-08-07T12:00:00.000Z",
      lastClose: 100,
      excludedOpenCandles: 1,
    })),
    trend: { tf3m: "bullish", tf5m: "bullish", tf15m: "bullish", tf1h: "bullish", alignedTimeframes: 4 },
    volatility: { atr: 2, atrPercent: 2, baselineAtrPercent: 1.5, ratioToBaseline: 1.33, phase: "normal" },
    momentum: { rsi5m: 62, macdHistogram3m: 1, longStructureScore: 82, shortStructureScore: 18 },
    liquidity: { volumeRatio: 1.4, proxyStatus: "elevated", disclaimer: "Volume is a liquidity proxy, not order-book depth." },
    structure: { supports: [95], resistances: [110], nearestSupport: 95, nearestResistance: 110 },
  },
  inferences: {
    regime: "strong_trend",
    regimeConfidence: 0.95,
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

function strategy(strategyId: string): Strategy {
  return {
    strategyId,
    strategyName: strategyId,
    supportedRegimes: ["strong_trend"],
    indicators: ["fixture"],
    evaluate: () => null,
  };
}

function config(strategyId: string): StrategyConfig {
  return { strategyId, enabled: true, maxHoldingSeconds: 3600 } as StrategyConfig;
}

function plan(strategyId: string, side: "long" | "short", confidence = 95): TradePlan {
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
      marketView: ["Trend aligned across closed timeframes"],
      entryLogic: ["Closed-candle trigger confirmed"],
      riskLogic: ["Stop outside normal noise"],
      exitLogic: ["Target at structure"],
      checks: [{ name: "Fixture", passed: true, detail: "valid" }],
    },
  };
}

function input(plans: TradePlan[]): EvaluateDecisionCouncilInput {
  const strategies = plans.length > 0
    ? plans.map((item) => strategy(item.strategyId))
    : [strategy("trend_pullback")];
  const configs = new Map(strategies.map((item) => [item.strategyId, config(item.strategyId)]));
  const specialistCouncil = buildSpecialistCouncilSnapshot({
    marketState,
    strategies,
    configs,
    plans,
    rejections: [],
    generatedAt: new Date("2026-08-07T12:00:02.000Z"),
  });
  return {
    marketState,
    specialistCouncil,
    brainV0Plans: plans,
    executionCosts: {
      feeRatePerLeg: 0.001,
      slippageRatePerLeg: 0.0002,
      source: "engine-market-cost-model",
      version: "fixture-cost-v1",
    },
    portfolio: {
      status: "partial",
      currency: "USDT",
      availableBalance: 10_000,
      openPositionCount: null,
      observedAt: "2026-08-07T12:00:02.000Z",
      limitations: ["Position-level allocation is not available in Phase 4."],
    },
    historicalEvidence: {
      status: "unavailable",
      ruleVersion: null,
      items: [],
      limitations: ["Validated evidence influence begins in Phase 5."],
    },
    generatedAt: "2026-08-07T12:00:02.000Z",
  };
}

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`✓ ${name}`);
}

check("a strong cost-aware consensus produces a Shadow entry candidate", () => {
  const result = aggregateDecisionCouncil(input([plan("trend_pullback", "long")]));
  assert.equal(result.decision.action, "ENTER_NOW");
  assert.equal(result.decision.reasonCode, "SHADOW_COUNCIL_ENTRY_CANDIDATE");
  assert.ok(result.assessment.decisionStrength >= result.assessment.thresholds.enterNow);
});

check("all abstentions produce an explicit no-action decision", () => {
  const result = aggregateDecisionCouncil(input([]));
  assert.equal(result.decision.action, "OBSERVE");
  assert.equal(result.decision.reasonCode, "NO_ELIGIBLE_SPECIALIST_SETUP");
  assert.equal(result.decision.proposedTrade, null);
});

check("material specialist disagreement blocks directional action", () => {
  const result = aggregateDecisionCouncil(input([
    plan("mean_reversion", "long", 90),
    plan("vwap_reversion", "short", 90),
  ]));
  assert.equal(result.decision.action, "OBSERVE");
  assert.equal(result.decision.reasonCode, "MATERIAL_SPECIALIST_DISAGREEMENT");
});

check("spot short candidates are rejected before any executable vocabulary exists", () => {
  const result = aggregateDecisionCouncil(input([plan("trend_pullback", "short")]));
  assert.equal(result.decision.action, "REJECT");
  assert.equal(result.decision.reasonCode, "MARKET_SIDE_UNAVAILABLE");
  assert.equal(result.decision.proposedTrade, null);
});

check("costs that overwhelm the target move force rejection", () => {
  const expensive = input([plan("trend_pullback", "long")]);
  const result = aggregateDecisionCouncil({
    ...expensive,
    executionCosts: { ...expensive.executionCosts, feeRatePerLeg: 0.1, slippageRatePerLeg: 0.1 },
  });
  assert.equal(result.decision.action, "REJECT");
  assert.equal(result.decision.reasonCode, "COSTS_OVERWHELM_EXPECTED_MOVE");
});

check("the same immutable inputs produce the same decision fingerprint", () => {
  const fixture = input([plan("trend_pullback", "long")]);
  assert.equal(
    aggregateDecisionCouncil(fixture).decisionFingerprint,
    aggregateDecisionCouncil(fixture).decisionFingerprint,
  );
});

check("the decision payload has no broker, executor, or execution command path", () => {
  const serialized = JSON.stringify(aggregateDecisionCouncil(input([plan("trend_pullback", "long")])));
  assert.doesNotMatch(serialized, /broker|executor|authorizationReference|ExecutionCommand/);
});

const evidenceFixture = aggregateDecisionCouncil(input([plan("trend_pullback", "long")]));
const knownEvidenceId = evidenceFixture.knownEvidence[0]!.evidenceId;
const validatingProvider: ReasoningProvider = {
  providerId: "fixture-provider",
  modelVersion: "fixture-model-v1",
  async reason() {
    return {
      output: {
        summary: "Evidence review complete.",
        summaryEvidenceIds: [knownEvidenceId],
        claims: [
          { claim: "Supported", evidenceIds: [knownEvidenceId] },
          { claim: "Invented", evidenceIds: ["unknown-evidence"] },
        ],
        challenges: [],
        uncertaintyNotes: ["Uncalibrated support score"],
      },
      usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.001 },
    };
  },
};

const reviewed = await new CouncilReasoningGateway(validatingProvider).review(
  evidenceFixture.decision,
  evidenceFixture.knownEvidence,
);
check("unsupported provider claims are discarded and provider accounting is retained", () => {
  assert.equal(reviewed.status, "degraded");
  assert.equal(reviewed.claims.length, 1);
  assert.match(reviewed.validationFailures[0] ?? "", /UNKNOWN_EVIDENCE/);
  assert.equal(reviewed.usage.inputTokens, 120);
  assert.equal(reviewed.usage.costUsd, 0.001);
});

let providerCalls = 0;
const cachedProvider: ReasoningProvider = {
  ...validatingProvider,
  async reason(request, signal) {
    providerCalls++;
    return validatingProvider.reason(request, signal);
  },
};
const council = new DecisionCouncil(cachedProvider);
const cachedInput = input([plan("trend_pullback", "long")]);
const [first, second] = await Promise.all([council.evaluate(cachedInput), council.evaluate(cachedInput)]);
check("identical snapshots reuse one bounded provider review", () => {
  assert.equal(providerCalls, 1);
  assert.equal(first.runFingerprint, second.runFingerprint);
  assert.equal(first.mode, "shadow");
  assert.equal(first.cannotExecute, true);
});

const deterministicOnly = await new DecisionCouncil().evaluate(input([plan("trend_pullback", "long")]));
check("an unavailable AI provider falls back to the deterministic council", () => {
  assert.equal(deterministicOnly.reasoning.status, "not_configured");
  assert.equal(deterministicOnly.decision.action, "ENTER_NOW");
});

console.log(`Decision Council harness passed: ${checks}/${checks}`);

