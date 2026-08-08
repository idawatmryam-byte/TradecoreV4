/** Phase 6 portfolio intelligence — pure ranking, allocation and reservation checks. */
import {
  buildPortfolioIntelligence,
  PORTFOLIO_POLICY_VERSION,
  type BuildPortfolioIntelligenceInput,
  type PortfolioOpportunityInput,
  type PortfolioPolicy,
} from "../src/lib/intelligence/portfolio";

let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (condition) console.log(`✓  ${name}`);
  else { failures++; console.error(`✗  ${name}${detail ? ` — ${detail}` : ""}`); }
}
function expectThrows(name: string, fn: () => unknown) {
  try { fn(); failures++; console.error(`✗  ${name} — did not throw`); }
  catch { console.log(`✓  ${name}`); }
}

const NOW = "2026-08-08T12:00:00.000Z";
const SCAN = "2026-08-08T11:59:30.000Z";
const DATA = "2026-08-08T11:59:00.000Z";
const EXPIRES = "2026-08-08T12:10:00.000Z";

const policy: PortfolioPolicy = {
  policyVersion: PORTFOLIO_POLICY_VERSION,
  riskPolicyVersion: "risk-fixture-v1",
  maxOpenPositions: 5,
  maxPortfolioRiskFraction: 0.10,
  maxSymbolNotionalFraction: 1,
  maxNetExposureFraction: 2,
  maxCorrelatedNotionalFraction: 2,
  maxStrategyRiskFraction: 0.5,
  correlationThreshold: 0.7,
  unknownCorrelationPolicy: "allow",
  drawdownDeRiskStartFraction: 0.05,
  drawdownHardFraction: 0.20,
  minimumAllocationFraction: 0.25,
};

function candidate(
  index: number,
  overrides: Partial<PortfolioOpportunityInput> = {},
): PortfolioOpportunityInput {
  const symbol = ["BTCUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT"][index] ?? `C${index}USDT`;
  return {
    decisionId: `00000000-0000-5000-8000-${String(index + 1).padStart(12, "0")}`,
    generatedAt: SCAN,
    dataTimestamp: DATA,
    expiresAt: EXPIRES,
    symbol,
    side: "long",
    action: "ENTER_NOW",
    strategyId: `strategy-${index}`,
    strategyName: `Strategy ${index}`,
    entryPrice: 100,
    stopPrice: 90,
    targetPrice: 120,
    quantity: 5,
    netRewardRisk: 2,
    uncertainty: 0.25,
    decisionStrength: 0.8 - index * 0.05,
    regimeSuitability: 0.8,
    costPenalty: 0.1,
    liquidityProxy: "normal",
    sourceFingerprint: String(index).padStart(64, "a"),
    ...overrides,
  };
}

function fixture(overrides: Partial<BuildPortfolioIntelligenceInput> = {}): BuildPortfolioIntelligenceInput {
  return {
    asOf: NOW,
    maximumCandidateAgeMs: 15 * 60_000,
    currency: "USDT",
    equity: 1000,
    availableBalance: 900,
    drawdownFraction: 0,
    initialReservedRisk: 0,
    positions: [],
    opportunities: [candidate(0)],
    correlations: [],
    policy,
    dataStatus: "healthy",
    dataIssues: [],
    ...overrides,
  };
}

{
  const projection = buildPortfolioIntelligence(fixture());
  expect("a healthy current opportunity receives a Shadow allocation",
    projection.opportunities[0]?.disposition === "SHADOW_ALLOCATED");
  expect("Shadow output is structurally unable to execute",
    projection.mode === "shadow" && projection.cannotExecute);
  expect("expected net R is not fabricated from confidence",
    projection.opportunities[0]?.estimatedNetR === null);
  expect("actual cash remains untouched in Shadow",
    projection.retainedCash.amount === 900 && projection.retainedCash.reasonCodes.includes("SHADOW_CANNOT_EXECUTE"));
  expect("context carries a deterministic fingerprint",
    /^[a-f0-9]{64}$/.test(projection.context.fingerprint));
}

{
  const a = buildPortfolioIntelligence(fixture());
  const b = buildPortfolioIntelligence(fixture());
  expect("identical inputs produce an identical projection fingerprint", a.fingerprint === b.fingerprint);
  expect("identical inputs produce an identical projection id", a.projectionId === b.projectionId);
}

{
  const sameStrategy = [
    candidate(0, { strategyId: "momentum" }),
    candidate(1, { strategyId: "momentum" }),
  ];
  const projection = buildPortfolioIntelligence(fixture({ opportunities: sameStrategy }));
  expect("the highest-ranked simultaneous candidate reserves its strategy budget",
    projection.opportunities[0]?.disposition === "SHADOW_ALLOCATED");
  expect("a later candidate cannot reuse the same strategy risk budget",
    projection.opportunities[1]?.disposition === "REJECTED"
      && projection.opportunities[1]?.reasonCodes.includes("STRATEGY_RISK_CAP"));
}

{
  const differentStrategies = [candidate(0), candidate(1), candidate(2)];
  const projection = buildPortfolioIntelligence(fixture({ opportunities: differentStrategies }));
  expect("two independent candidates can consume the portfolio risk budget",
    projection.opportunities.filter((item) => item.disposition === "SHADOW_ALLOCATED").length === 2);
  expect("the third candidate sees the same-cycle reservations and is refused",
    projection.opportunities[2]?.reasonCodes.includes("PORTFOLIO_RISK_CAP"));
  expect("reserved risk never exceeds the deterministic maximum",
    projection.riskUsage.shadowReservedRisk <= projection.riskUsage.maximumStopRisk);
}

{
  const strongerSecond = [
    candidate(0, { decisionStrength: 0.55 }),
    candidate(1, { decisionStrength: 0.95 }),
  ];
  const projection = buildPortfolioIntelligence(fixture({ opportunities: strongerSecond }));
  expect("ranking happens before allocation", projection.opportunities[0]?.symbol === "SOLUSDT");
  expect("rank numbers follow deterministic score order",
    projection.opportunities.map((item) => item.rank).join(",") === "1,2");
}

{
  const correlatedPolicy = { ...policy, maxCorrelatedNotionalFraction: 0.5, maxStrategyRiskFraction: 1 };
  const projection = buildPortfolioIntelligence(fixture({
    policy: correlatedPolicy,
    positions: [{
      symbol: "ETHUSDT", side: "long", strategyId: "trend",
      entryPrice: 100, stopPrice: 95, quantity: 3,
    }],
    opportunities: [candidate(0, { quantity: 3 })],
    correlations: [{ a: "BTCUSDT", b: "ETHUSDT", correlation: 0.9 }],
  }));
  const item = projection.opportunities[0]!;
  expect("correlated exposure is included in portfolio fit", item.reinforcingClusterSymbols.includes("ETHUSDT"));
  expect("correlation capacity reduces, rather than enlarges, an allocation",
    item.disposition === "SHADOW_ALLOCATED" && item.allocationFraction < 1);
  expect("the reduced allocation stays within its correlated-notional cap",
    300 + item.allocatedNotional <= 500.000001);
}

{
  const projection = buildPortfolioIntelligence(fixture({
    policy: { ...policy, unknownCorrelationPolicy: "block" },
    positions: [{
      symbol: "ETHUSDT", side: "long", strategyId: "trend",
      entryPrice: 100, stopPrice: 95, quantity: 1,
    }],
    correlations: [{ a: "BTCUSDT", b: "ETHUSDT", correlation: null }],
  }));
  expect("unknown correlation fails closed when policy says block",
    projection.opportunities[0]?.reasonCodes.includes("UNKNOWN_CORRELATION_BLOCKED"));
  expect("unknown is surfaced, never silently treated as zero",
    projection.opportunities[0]?.correlationUnknownWith.includes("ETHUSDT"));
}

{
  const projection = buildPortfolioIntelligence(fixture({ drawdownFraction: 0.20 }));
  expect("the hard drawdown boundary retains all risk",
    projection.opportunities[0]?.reasonCodes.includes("DRAWDOWN_HARD_STOP"));
  expect("drawdown scale is zero at the hard boundary", projection.riskUsage.drawdownScale === 0);
}

{
  const stale = candidate(0, {
    dataTimestamp: "2026-08-08T11:00:00.000Z",
    expiresAt: "2026-08-08T11:10:00.000Z",
  });
  const projection = buildPortfolioIntelligence(fixture({ opportunities: [stale] }));
  expect("stale opportunities cannot receive an allocation",
    projection.opportunities[0]?.reasonCodes.includes("STALE_DECISION"));
}

{
  const waiting = candidate(0, { action: "WAIT_FOR_TRIGGER" });
  const projection = buildPortfolioIntelligence(fixture({ opportunities: [waiting] }));
  expect("waiting is a first-class disposition, not a rejection",
    projection.opportunities[0]?.disposition === "WAIT_FOR_TRIGGER");
  expect("waiting reserves no risk", projection.riskUsage.shadowReservedRisk === 0);
}

{
  const projection = buildPortfolioIntelligence(fixture({
    opportunities: [
      candidate(0),
      candidate(1, { generatedAt: "2026-08-08T11:58:30.000Z" }),
    ],
  }));
  expect("mixed scan timestamps block allocation",
    projection.dataStatus === "blocked"
      && projection.opportunities.every((item) => item.disposition !== "SHADOW_ALLOCATED"));
}

{
  const projection = buildPortfolioIntelligence(fixture({
    positions: [{
      symbol: "ETHUSDT", side: "long", strategyId: "trend",
      entryPrice: 100, stopPrice: 95, quantity: 2,
    }],
  }));
  expect("current-stop risk is included in the point-in-time context",
    projection.context.remainingStopRisk === 10);
  expect("gross and net exposure remain distinct", projection.context.grossExposure === 200 && projection.context.netExposure === 200);
}

expectThrows("non-finite equity is refused", () =>
  buildPortfolioIntelligence(fixture({ equity: Number.NaN })));
{
  const protectedProfit = buildPortfolioIntelligence(fixture({
    positions: [{
      symbol: "ETHUSDT", side: "long", strategyId: null,
      entryPrice: 100, stopPrice: 105, quantity: 1,
    }],
  }));
  expect("a favorable trailing stop contributes zero remaining loss risk",
    protectedProfit.context.remainingStopRisk === 0);
}
expectThrows("an invalid negative stop is refused", () =>
  buildPortfolioIntelligence(fixture({
    positions: [{
      symbol: "ETHUSDT", side: "long", strategyId: null,
      entryPrice: 100, stopPrice: -1, quantity: 1,
    }],
  })));
expectThrows("conflicting pair correlations are refused", () =>
  buildPortfolioIntelligence(fixture({
    correlations: [
      { a: "BTCUSDT", b: "ETHUSDT", correlation: 0.5 },
      { a: "ETHUSDT", b: "BTCUSDT", correlation: 0.8 },
    ],
  })));

console.log(failures === 0 ? "\nportfolio-intelligence: all checks passed" : `\nportfolio-intelligence: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
