import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Strategy,
  StrategyConfig,
  TradePlan,
} from "../src/lib/strategies";
import { parseMarketState } from "../src/lib/intelligence/market-state/types";
import { DEFAULT_PORTFOLIO_POLICY } from "../src/lib/intelligence/portfolio";
import { buildPositionThesis } from "../src/lib/intelligence/position";
import {
  benjaminiHochberg,
  buildResearchScenarioConfigs,
  buildResearchScenarioFillCosts,
  buildPurgedWalkForwardPlan,
  buildResearchExperimentManifest,
  buildResearchMetrics,
  buildResearchPromotionReport,
  decisionStreamFingerprint,
  partitionForTimestamp,
  replayFullBrainFrame,
  shouldDropResearchFrame,
  validateGoldenDecisionStream,
  verifyPointInTimeObservation,
  type ResearchTradeOutcome,
} from "../src/lib/intelligence/research";

const observedAt = new Date("2026-07-15T12:00:01.000Z");
const marketState = parseMarketState({
  schemaVersion: "1.0.0",
  marketStateVersion: "market-state-v1",
  fingerprint: "a".repeat(64),
  symbol: "BTCUSDT",
  venue: "spot",
  provider: "fixture",
  dataTimestamp: "2026-07-15T12:00:00.000Z",
  observedAt: "2026-07-15T12:00:01.000Z",
  freshness: { status: "fresh", ageMs: 1_000, maximumAgeMs: 180_000 },
  dataQuality: { status: "healthy", issues: [] },
  observations: {
    lastPrice: 106,
    timeframes: ["1m", "3m", "5m", "15m", "1h"].map((timeframe, index) => ({
      timeframe,
      intervalMs: [60_000, 180_000, 300_000, 900_000, 3_600_000][index],
      candleCount: 100,
      lastClosedAt: "2026-07-15T12:00:00.000Z",
      lastClose: 106,
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
      atr: 2,
      atrPercent: 1.9,
      baselineAtrPercent: 1.5,
      ratioToBaseline: 1.27,
      phase: "normal",
    },
    momentum: {
      rsi5m: 62,
      macdHistogram3m: 1,
      longStructureScore: 88,
      shortStructureScore: 12,
    },
    liquidity: {
      volumeRatio: 1.4,
      proxyStatus: "elevated",
      disclaimer: "Volume is a liquidity proxy, not order-book depth.",
    },
    structure: {
      supports: [100],
      resistances: [115],
      nearestSupport: 100,
      nearestResistance: 115,
    },
  },
  inferences: {
    regime: "strong_trend",
    regimeConfidence: 0.9,
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
});

const strategy: Strategy = {
  strategyId: "trend_pullback",
  strategyName: "Trend Pullback",
  supportedRegimes: ["strong_trend"],
  indicators: ["fixture"],
  evaluate: () => null,
};

const config = {
  strategyId: strategy.strategyId,
  enabled: true,
  maxHoldingSeconds: 3_600,
  exitPriority: ["take_profit", "stop_loss"],
} as StrategyConfig;

const plan: TradePlan = {
  strategyId: strategy.strategyId,
  strategyName: strategy.strategyName,
  symbol: "BTCUSDT",
  side: "long",
  confidence: 95,
  entryPrice: 100,
  slPrice: 95,
  tpPrice: 115,
  qty: 1,
  leverage: 1,
  expectedHoldSeconds: 900,
  maxHoldSeconds: 3_600,
  regime: "strong_trend",
  netRewardRisk: 2.8,
  report: {
    summary: "Fixture trend thesis",
    marketView: ["Closed timeframes align bullish"],
    entryLogic: ["Pullback held support"],
    riskLogic: ["Stop is below invalidation"],
    exitLogic: ["Target is below resistance"],
    checks: [{ name: "fixture", passed: true, detail: "valid" }],
  },
};

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`✓ ${name}`);
}

const partitions = buildPurgedWalkForwardPlan({
  startInclusive: new Date("2026-06-01T00:00:00.000Z"),
  endExclusive: new Date("2026-08-01T00:00:00.000Z"),
  folds: 2,
  holdoutFraction: 0.2,
  purgeMs: 60 * 60 * 1000,
  embargoMs: 60 * 60 * 1000,
});

check("purged folds keep training strictly before validation", () => {
  for (const fold of partitions.folds) {
    assert.ok(
      Date.parse(fold.train.endExclusive) <
        Date.parse(fold.validation.startInclusive),
    );
  }
  assert.equal(partitions.folds.length, 2);
});

check(
  "untouched holdout is identified independently of validation folds",
  () => {
    assert.equal(
      partitionForTimestamp(partitions, "2026-07-25T00:00:00.000Z"),
      "untouched-holdout",
    );
  },
);

const cleanLeakage = verifyPointInTimeObservation("2026-07-15T12:00:01.000Z", {
  featureTimestamp: "2026-07-15T12:00:00.000Z",
  universeTimestamp: "2026-07-15T00:00:00.000Z",
  regimeTimestamp: "2026-07-15T12:00:00.000Z",
  evidenceAsOf: "2026-07-14T23:59:59.000Z",
  labelTimestamp: "2026-07-15T13:00:00.000Z",
});
check(
  "point-in-time checks accept only prior features and future labels",
  () => {
    assert.ok(cleanLeakage.every((item) => item.passed));
  },
);

check("future features are detected mechanically", () => {
  const result = verifyPointInTimeObservation("2026-07-15T12:00:01.000Z", {
    featureTimestamp: "2026-07-15T12:01:00.000Z",
  });
  assert.equal(
    result.find((item) => item.check === "feature-time")?.passed,
    false,
  );
});

check("Research modules have no Live executor or broker-client dependency", () => {
  const runnerSource = readFileSync(
    fileURLToPath(new URL("../src/lib/intelligence/research/runner.ts", import.meta.url)),
    "utf8",
  );
  const replaySource = readFileSync(
    fileURLToPath(new URL("../src/lib/intelligence/research/replay.ts", import.meta.url)),
    "utf8",
  );
  for (const source of [runnerSource, replaySource]) {
    assert.doesNotMatch(source, /botEngine|exchangeClient|binanceClient|oandaClient|orderExecutor|executionAdapter/);
  }
});

const manifest = buildResearchExperimentManifest({
  name: "Phase 8 deterministic fixture",
  controlManifestFingerprint: "b".repeat(64),
  candidateBrainVersion: "phase8-candidate-v1",
  candidateConfig: { threshold: 0.55 },
  candidateModel: { council: "deterministic-council-v1" },
  narrativeMode: "deterministic-only",
  provider: "fixture",
  marketType: "spot",
  symbols: ["BTCUSDT"],
  timeframe: "1m",
  startInclusive: new Date("2026-06-01T00:00:00.000Z"),
  endExclusive: new Date("2026-08-01T00:00:00.000Z"),
  asOf: new Date("2026-08-02T00:00:00.000Z"),
  dataFingerprint: "c".repeat(64),
  syntheticDataAllowed: true,
  partitions,
  costs: {
    feeRatePerLeg: 0.001,
    slippageRatePerLeg: 0.0005,
    spreadRate: 0,
    latencyMs: 0,
    fillModelVersion: "shared-fill-model-v1",
  },
  versions: {
    strategyCatalogVersion: "strategy-catalog-v1",
    marketStateVersion: "market-state-v1",
    specialistVersion: "specialist-council-v1",
    evidenceVersion: "evidence-v1",
    portfolioVersion: "shadow-portfolio-intelligence-v1",
    positionPolicyVersion: "phase7-bounded-management-v1",
  },
  sourceCode: { commit: "fixture" },
  deterministicSeed: 42,
  hypothesesDeclaredBeforeRun: 1,
  createdAt: new Date("2026-08-02T00:00:01.000Z"),
});

check("equivalent manifests fingerprint deterministically", () => {
  const replay = buildResearchExperimentManifest({
    name: "Display name may differ",
    controlManifestFingerprint: "b".repeat(64),
    candidateBrainVersion: "phase8-candidate-v1",
    candidateConfig: { threshold: 0.55 },
    candidateModel: { council: "deterministic-council-v1" },
    narrativeMode: "deterministic-only",
    provider: "fixture",
    marketType: "spot",
    symbols: ["BTCUSDT"],
    timeframe: "1m",
    startInclusive: new Date("2026-06-01T00:00:00.000Z"),
    endExclusive: new Date("2026-08-01T00:00:00.000Z"),
    asOf: new Date("2026-08-02T00:00:00.000Z"),
    dataFingerprint: "c".repeat(64),
    syntheticDataAllowed: true,
    partitions,
    costs: manifest.costs,
    versions: {
      strategyCatalogVersion: "strategy-catalog-v1",
      marketStateVersion: "market-state-v1",
      specialistVersion: "specialist-council-v1",
      evidenceVersion: "evidence-v1",
      portfolioVersion: "shadow-portfolio-intelligence-v1",
      positionPolicyVersion: "phase7-bounded-management-v1",
    },
    sourceCode: { commit: "fixture" },
    deterministicSeed: 42,
    hypothesesDeclaredBeforeRun: 1,
    createdAt: new Date("2026-08-03T00:00:00.000Z"),
  });
  assert.equal(replay.fingerprint, manifest.fingerprint);
  assert.equal(replay.experimentId, manifest.experimentId);
});

const thesis = buildPositionThesis({
  plan,
  marketState: {
    ...marketState,
    observations: { ...marketState.observations, lastPrice: 100 },
  } as typeof marketState,
  createdAt: new Date("2026-07-15T11:30:00.000Z"),
  thesisId: "11111111-1111-5111-8111-111111111111",
});

const replayInput = {
  experimentId: manifest.experimentId,
  partitionId: "fold-2",
  sequenceStart: 0,
  observedAt,
  maximumCandidateAgeMs: 15 * 60 * 1000,
  feeRatePerLeg: 0.001,
  slippageRatePerLeg: 0.0005,
  costModelVersion: "fixture-cost-v1",
  symbols: [
    {
      marketState,
      strategies: [strategy],
      configs: new Map([[strategy.strategyId, config]]),
      plans: [plan],
      rejections: [],
      historicalEvidence: {
        status: "unavailable" as const,
        ruleVersion: null,
        items: [],
        limitations: ["fixture"],
      },
    },
  ],
  portfolio: {
    currency: "USDT",
    equity: 1_000,
    availableBalance: 1_000,
    drawdownFraction: 0,
    initialReservedRisk: 0,
    positions: [],
    correlations: [],
    policy: {
      ...DEFAULT_PORTFOLIO_POLICY,
      riskPolicyVersion: "fixture-risk-v1",
    },
  },
  managedPositions: [
    {
      thesis,
      position: {
        tradeId: 1,
        symbol: "BTCUSDT",
        side: "long" as const,
        entryPrice: 100,
        currentStopPrice: 95,
        targetPrice: 115,
        remainingQuantity: 1,
        openedAt: new Date("2026-07-15T11:30:00.000Z"),
      },
      reductionAlreadyApplied: false,
    },
  ],
};
const replay = replayFullBrainFrame(replayInput);

check("stress costs and adverse ordering are explicit and deterministic", () => {
  const scenario = {
    scenarioId: "adverse",
    label: "fixture",
    feeMultiplier: 2,
    slippageMultiplier: 1.5,
    spreadMultiplier: 1,
    latencyMs: 30_000,
    missingDataFraction: 0.1,
    adverseIntrabarOrdering: true,
  };
  const costs = buildResearchScenarioFillCosts(
    { feeRate: 0.001, makerFeeRate: 0.0005, slippageRate: 0.0004, spreadRate: 0.0001 },
    scenario,
  );
  assert.equal(costs.feeRate, 0.002);
  assert.equal(costs.makerFeeRate, 0.001);
  assert.equal(costs.modeledSlippageRate, 0.0008);
  assert.equal(costs.spreadRate, 0.0001);
  assert.ok(Math.abs(costs.slippageRate - 0.0009) < Number.EPSILON);
  const stressed = buildResearchScenarioConfigs(new Map([[strategy.strategyId, config]]), scenario);
  assert.deepEqual(stressed.get(strategy.strategyId)?.exitPriority, [
    "stop_loss",
    "trailing_stop",
    "take_profit",
    "timeout",
  ]);
  assert.equal(
    shouldDropResearchFrame(scenario, manifest, "BTCUSDT", 1_786_000_000_000),
    shouldDropResearchFrame(scenario, manifest, "BTCUSDT", 1_786_000_000_000),
  );
});

check(
  "full-brain replay records control, specialists, council, portfolio, and management",
  () => {
    assert.equal(replay.decisions.length, 1);
    assert.equal(replay.decisions[0]!.control.action, "ENTER_NOW");
    assert.equal(replay.decisions[0]!.council.action, "ENTER_NOW");
    assert.equal(
      replay.decisions[0]!.portfolio.disposition,
      "SHADOW_ALLOCATED",
    );
    assert.equal(replay.management[0]!.proposedAction, "APPLY_TRAILING");
    assert.equal(replay.management[0]!.valid, true);
    assert.equal(replay.cannotExecute, true);
  },
);

check("full-brain frame replay is deterministic", () => {
  const repeated = replayFullBrainFrame(replayInput);
  assert.equal(repeated.fingerprint, replay.fingerprint);
  assert.equal(
    repeated.decisions[0]!.fingerprint,
    replay.decisions[0]!.fingerprint,
  );
  assert.equal(
    repeated.management[0]!.fingerprint,
    replay.management[0]!.fingerprint,
  );
});

check("crypto and forex replay preserve decisions under identical canonical inputs and costs", () => {
  const forex = replayFullBrainFrame({
    ...replayInput,
    symbols: replayInput.symbols.map((frame) => ({
      ...frame,
      marketState: { ...frame.marketState, venue: "forex" as const },
    })),
  });
  assert.equal(forex.decisions[0]!.council.action, replay.decisions[0]!.council.action);
  assert.equal(forex.decisions[0]!.portfolio.disposition, replay.decisions[0]!.portfolio.disposition);
});

check("golden decision streams fail closed on any changed fingerprint", () => {
  const fingerprint = decisionStreamFingerprint(
    replay.decisions,
    replay.management,
  );
  assert.equal(
    validateGoldenDecisionStream(
      fingerprint,
      replay.decisions,
      replay.management,
    ).reproducible,
    true,
  );
  assert.equal(
    validateGoldenDecisionStream(
      "d".repeat(64),
      replay.decisions,
      replay.management,
    ).reproducible,
    false,
  );
});

check("Benjamini-Hochberg correction is monotone and bounded", () => {
  const adjusted = benjaminiHochberg(
    [
      { id: "a", pValue: 0.001 },
      { id: "b", pValue: 0.02 },
      { id: "c", pValue: 0.8 },
    ],
    0.05,
  );
  assert.ok(adjusted[0]!.adjustedPValue <= adjusted[1]!.adjustedPValue);
  assert.equal(adjusted[0]!.discovery, true);
  assert.equal(adjusted[2]!.discovery, false);
});

const outcomes: ResearchTradeOutcome[] = Array.from(
  { length: 60 },
  (_, index) => ({
    tradeId: `trade-${index + 1}`,
    closedAt: new Date(
      Date.parse("2026-06-02T00:00:00.000Z") + index * 20 * 60 * 60 * 1000,
    ).toISOString(),
    regime: index % 2 === 0 ? "strong_trend" : "range",
    grossPnl: index % 3 === 0 ? -4 : 6,
    fees: 0.5,
    slippage: 0.25,
    spread: 0,
    financing: 0,
    plannedRisk: 5,
  }),
);
const controlMetrics = buildResearchMetrics({
  outcomes,
  eligibleDecisions: 250,
  abstentions: 100,
  startInclusive: "2026-06-01T00:00:00.000Z",
  endExclusive: "2026-08-01T00:00:00.000Z",
  startingEquity: 1_000,
  deterministicSeed: 42,
});
const candidateMetrics = buildResearchMetrics({
  outcomes,
  eligibleDecisions: 250,
  abstentions: 100,
  startInclusive: "2026-06-01T00:00:00.000Z",
  endExclusive: "2026-08-01T00:00:00.000Z",
  startingEquity: 1_000,
  deterministicSeed: 42,
});

check(
  "metrics keep gross, costs, net, drawdown, sample, and uncertainty together",
  () => {
    assert.equal(
      candidateMetrics.netPnl,
      candidateMetrics.grossPnl - candidateMetrics.costs,
    );
    assert.equal(candidateMetrics.closedTrades, 60);
    assert.equal(candidateMetrics.uncertainty.samples, 1_000);
    assert.ok(candidateMetrics.regimeMix.strong_trend! > 0);
  },
);

const streamFingerprint = decisionStreamFingerprint(
  replay.decisions,
  replay.management,
);
const report = buildResearchPromotionReport({
  manifest,
  control: controlMetrics,
  candidate: candidateMetrics,
  attribution: {
    perception: 0,
    selection: 0,
    evidence: 0,
    allocation: 0,
    executionCosts: 0,
    management: 0,
    unit: "net-pnl",
  },
  goldenStream: {
    expectedFingerprint: streamFingerprint,
    actualFingerprint: streamFingerprint,
    reproducible: true,
  },
  leakageChecks: cleanLeakage,
  hypotheses: [{ id: "candidate-non-inferiority", pValue: 0.01 }],
  noRiskPolicyViolations: true,
  holdoutEvaluated: true,
  allStressScenariosPassed: true,
  generatedAt: new Date("2026-08-02T01:00:00.000Z"),
});

check("passing evidence is only eligible for explicit human review", () => {
  assert.equal(report.recommendation, "ELIGIBLE_FOR_HUMAN_REVIEW");
  assert.equal(report.humanApprovalRequired, true);
  assert.match(report.limitations.at(-1) ?? "", /AI narrative/);
});

console.log(
  `\nPhase 8 research-validation harness passed: ${checks}/${checks}`,
);
