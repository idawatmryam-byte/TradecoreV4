import {
  BrainDecisionSchema,
  ExecutionCommandSchema,
  INTELLIGENCE_SCHEMA_VERSION,
  brainDecisionFingerprint,
  parseBrainDecision,
} from "../src/lib/intelligence/contracts";
import {
  brainDecisionFromV0TradePlan,
  v0TradePlanFromProposed,
} from "../src/lib/intelligence/trade-plan-adapter";
import type { TradePlan } from "../src/lib/strategies/base";

let failures = 0;
function expect(name: string, condition: boolean): void {
  if (condition) console.log("✓  " + name);
  else { failures++; console.error("✗  " + name); }
}

const plan: TradePlan = {
  strategyId: "fixture-strategy",
  strategyName: "Fixture Strategy",
  symbol: "BTCUSDT",
  side: "long",
  confidence: 72,
  entryPrice: 100,
  slPrice: 98,
  tpPrice: 104,
  qty: 2,
  leverage: 2,
  expectedHoldSeconds: 1800,
  maxHoldSeconds: 3600,
  regime: "strong_trend",
  netRewardRisk: 1.8,
  report: {
    summary: "Trend continuation fixture",
    marketView: ["5m trend is bullish"],
    entryLogic: ["breakout closed above resistance"],
    riskLogic: ["stop below invalidation"],
    exitLogic: ["target at 2R"],
    checks: [{ name: "Cost floor", passed: true, detail: "net reward:risk passes" }],
  },
};

const context = {
  marketStateFingerprint: "a".repeat(64),
  dataTimestamp: "2025-01-01T00:00:00.000Z",
  expiresAt: "2025-01-01T00:05:00.000Z",
  brainVersion: "brain-v0",
  strategyVersion: "fixture-v1",
  configVersion: "config-v1",
  marketStateVersion: "market-state-v1",
  decisionId: "00000000-0000-4000-8000-000000000001",
  thesisId: "00000000-0000-4000-8000-000000000002",
};

const decision = brainDecisionFromV0TradePlan(plan, context);
expect("Brain V0 adapter produces a valid ENTER_NOW decision", decision.action === "ENTER_NOW");
expect("decision is deeply immutable", Object.isFrozen(decision) && Object.isFrozen(decision.versions) && Object.isFrozen(decision.supportingEvidence));
expect("decision fingerprint is deterministic", brainDecisionFingerprint(decision) === brainDecisionFingerprint(decision));
expect("adapter preserves the complete TradePlan", JSON.stringify(v0TradePlanFromProposed(decision.proposedTrade!)) === JSON.stringify(plan));

const missingPlan = { ...decision, proposedTrade: null };
expect("ENTER_NOW without a plan is refused", !BrainDecisionSchema.safeParse(missingPlan).success);

const staleExpiry = { ...decision, expiresAt: decision.dataTimestamp };
expect("non-forward expiry is refused", !BrainDecisionSchema.safeParse(staleExpiry).success);

const contradictory = {
  ...decision,
  opposingEvidence: [decision.supportingEvidence[0]],
};
expect("evidence cannot support and oppose simultaneously", !BrainDecisionSchema.safeParse(contradictory).success);

const nonFinite = {
  ...decision,
  proposedTrade: { ...decision.proposedTrade!, quantity: Number.POSITIVE_INFINITY },
};
expect("non-finite trade numbers are refused", !BrainDecisionSchema.safeParse(nonFinite).success);

expect("unknown fields are refused", !BrainDecisionSchema.safeParse({ ...decision, invented: true }).success);

const parsed = parseBrainDecision(decision);
expect("schema version is explicit", parsed.schemaVersion === INTELLIGENCE_SCHEMA_VERSION);

expect("Live execution requires an authorization reference", !ExecutionCommandSchema.safeParse({
  schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
  commandId: "00000000-0000-4000-8000-000000000003",
  brainDecisionId: decision.decisionId,
  riskDecisionId: "00000000-0000-4000-8000-000000000004",
  planFingerprint: "b".repeat(64),
  target: "live",
  symbol: "BTCUSDT",
  side: "long",
  quantity: 2,
  maximumIntendedLoss: 4,
  authorizationReference: "",
  expiresAt: context.expiresAt,
  idempotencyKey: "fixture-idempotency-key",
}).success);

console.log(failures === 0 ? "\nAll unified-contract checks passed." : "\n" + failures + " FAILED");
process.exit(failures === 0 ? 0 : 1);
