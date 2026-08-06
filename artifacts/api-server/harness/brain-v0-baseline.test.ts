/**
 * Brain V0 baseline contract checks. Pure: no database, clock, or network.
 *
 * Run: tsx harness/brain-v0-baseline.test.ts
 */
import {
  BASELINE_METRICS,
  BRAIN_V0_CONTROL_COMMIT,
  PROMOTION_GATES,
  ROLLBACK_CONDITIONS,
  baselineManifestFingerprint,
  canonicalManifestJson,
  validateBaselineManifest,
  type BrainV0BaselineManifest,
} from "../src/lib/intelligence/baseline";

let failures = 0;
function expect(name: string, condition: boolean): void {
  if (condition) console.log("✓  " + name);
  else {
    failures++;
    console.error("✗  " + name);
  }
}

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

function fixture(): BrainV0BaselineManifest {
  return {
    schemaVersion: 1,
    brainVersion: "brain-v0",
    role: "control",
    source: { gitCommit: BRAIN_V0_CONTROL_COMMIT },
    strategy: { catalogVersion: "builtin-catalog-v0", configHash: hashA },
    risk: { policyVersion: "risk-policy-v0", configHash: hashB },
    marketData: {
      provider: "fixture",
      marketType: "futures",
      symbols: ["ETH/USDT", "BTC/USDT"],
      universeHash: hashC,
      candleRanges: [
        { timeframe: "15m", startInclusive: "2025-01-01T00:00:00.000Z", endExclusive: "2025-02-01T00:00:00.000Z" },
        { timeframe: "1m", startInclusive: "2025-01-01T00:00:00.000Z", endExclusive: "2025-02-01T00:00:00.000Z" },
      ],
      featureVersion: "signal-row-v0",
    },
    costs: { feeModelVersion: "trading-costs-v0", slippageModelVersion: "fill-model-v0" },
    execution: { target: "research", fillModelVersion: "fill-model-v0" },
  };
}

const original = fixture();
const reordered = fixture();
reordered.marketData.symbols = ["BTC/USDT", "ETH/USDT"];
reordered.marketData.candleRanges = [...reordered.marketData.candleRanges].reverse();

expect("valid fixture has no validation errors", validateBaselineManifest(original).length === 0);
expect("canonical JSON is independent of symbol and candle ordering", canonicalManifestJson(original) === canonicalManifestJson(reordered));
expect("fingerprint is deterministic", baselineManifestFingerprint(original) === baselineManifestFingerprint(original));
expect("equivalent manifests share a fingerprint", baselineManifestFingerprint(original) === baselineManifestFingerprint(reordered));
const reorderedKeys = {
  execution: original.execution,
  costs: original.costs,
  marketData: original.marketData,
  risk: original.risk,
  strategy: original.strategy,
  source: original.source,
  role: original.role,
  brainVersion: original.brainVersion,
  schemaVersion: original.schemaVersion,
} as BrainV0BaselineManifest;
expect("fingerprint is independent of object key insertion order", baselineManifestFingerprint(original) === baselineManifestFingerprint(reorderedKeys));
expect("fingerprint is SHA-256", /^[a-f0-9]{64}$/.test(baselineManifestFingerprint(original)));

const badHash = fixture();
badHash.strategy.configHash = "not-a-hash";
expect("invalid configuration hashes are rejected", validateBaselineManifest(badHash).some((error) => error.includes("strategy.configHash")));

const duplicateSymbol = fixture();
duplicateSymbol.marketData.symbols = ["BTC/USDT", "BTC/USDT"];
expect("duplicate symbols are rejected", validateBaselineManifest(duplicateSymbol).some((error) => error.includes("unique")));

const invalidRange = fixture();
invalidRange.marketData.candleRanges = [{ timeframe: "1m", startInclusive: "2025-02-01T00:00:00.000Z", endExclusive: "2025-01-01T00:00:00.000Z" }];
expect("invalid point-in-time ranges are rejected", validateBaselineManifest(invalidRange).some((error) => error.includes("half-open interval")));

const metricKeys = new Set(BASELINE_METRICS.map((metric) => metric.key));
expect("metric keys are unique", metricKeys.size === BASELINE_METRICS.length);
expect("headline P&L is split into gross, costs, and net", ["grossPnl", "costs", "netPnl"].every((key) => metricKeys.has(key)));
expect("every metric requires sample context", BASELINE_METRICS.every((metric) => metric.requiredContext.includes("sampleSize") || metric.key === "liveBacktestDrift"));

expect("promotion stages are ordered from research to restricted live", PROMOTION_GATES.map((gate) => gate.stage).join(",") === "research,shadow,copilot,demo,live-restricted");
expect("every promotion requires human approval", PROMOTION_GATES.every((gate) => gate.humanApprovalRequired));
expect("promotion evidence requirements increase monotonically", PROMOTION_GATES.every((gate, index) => index === 0 || (
  gate.minimumEligibleDecisions >= PROMOTION_GATES[index - 1]!.minimumEligibleDecisions &&
  gate.minimumClosedTrades >= PROMOTION_GATES[index - 1]!.minimumClosedTrades &&
  gate.minimumCalendarDays >= PROMOTION_GATES[index - 1]!.minimumCalendarDays
)));
expect("critical rollback classes are present", ["risk-policy-violation", "data-quality", "execution-ambiguity"].every((key) => ROLLBACK_CONDITIONS.some((condition) => condition.key === key && condition.severity === "immediate")));

console.log(failures === 0 ? "\nAll Brain V0 baseline checks passed." : "\n" + failures + " FAILED");
process.exit(failures === 0 ? 0 : 1);
