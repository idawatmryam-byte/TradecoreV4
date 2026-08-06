/**
 * Brain V0 — immutable control-baseline contracts.
 *
 * This module records how an evaluation was produced. It does not participate
 * in strategy selection, risk evaluation, or execution, so introducing Phase 0
 * cannot change a trading decision.
 */
import { createHash } from "node:crypto";

export const BRAIN_V0_VERSION = "brain-v0" as const;
export const BRAIN_V0_CONTROL_COMMIT = "07cd8b10fa9d102a4ad99e1534662a3a0a1ee1ef" as const;
export const BASELINE_SCHEMA_VERSION = 1 as const;

export type BaselineMarketType = "spot" | "futures" | "forex";
export type BaselineExecutionTarget = "research" | "demo" | "live";

export interface BaselineCandleRange {
  timeframe: string;
  startInclusive: string;
  endExclusive: string;
}

export interface BrainV0BaselineManifest {
  schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  brainVersion: typeof BRAIN_V0_VERSION;
  role: "control";
  source: {
    gitCommit: string;
  };
  strategy: {
    catalogVersion: string;
    configHash: string;
  };
  risk: {
    policyVersion: string;
    configHash: string;
  };
  marketData: {
    provider: string;
    marketType: BaselineMarketType;
    symbols: readonly string[];
    universeHash: string;
    candleRanges: readonly BaselineCandleRange[];
    featureVersion: string;
  };
  costs: {
    feeModelVersion: string;
    slippageModelVersion: string;
  };
  execution: {
    target: BaselineExecutionTarget;
    fillModelVersion: string;
  };
}

export interface BaselineMetricDefinition {
  key: string;
  label: string;
  unit: "currency" | "ratio" | "fraction" | "R" | "count";
  direction: "higher" | "lower" | "context";
  definition: string;
  requiredContext: readonly string[];
}

export const BASELINE_METRICS = [
  {
    key: "grossPnl",
    label: "Gross P&L",
    unit: "currency",
    direction: "higher",
    definition: "Realized P&L before all modeled fees, spread, slippage, and financing costs.",
    requiredContext: ["currency", "sampleSize", "period"],
  },
  {
    key: "costs",
    label: "Trading costs",
    unit: "currency",
    direction: "lower",
    definition: "All modeled or realized fees, spread, slippage, and financing costs.",
    requiredContext: ["currency", "sampleSize", "costModelVersion"],
  },
  {
    key: "netPnl",
    label: "Net P&L",
    unit: "currency",
    direction: "higher",
    definition: "Gross P&L minus trading costs.",
    requiredContext: ["currency", "sampleSize", "period"],
  },
  {
    key: "netExpectancyR",
    label: "Net expectancy",
    unit: "R",
    direction: "higher",
    definition: "Mean realized net P&L divided by the planned risk of each measurable trade.",
    requiredContext: ["sampleSize", "confidenceInterval", "unmeasurableRiskCount"],
  },
  {
    key: "profitFactor",
    label: "Profit factor",
    unit: "ratio",
    direction: "higher",
    definition: "Gross winning net P&L divided by the absolute gross losing net P&L.",
    requiredContext: ["sampleSize", "noLossSentinelPolicy"],
  },
  {
    key: "maxDrawdown",
    label: "Maximum drawdown",
    unit: "fraction",
    direction: "lower",
    definition: "Largest peak-to-trough decline as a fraction of the running equity peak.",
    requiredContext: ["startingEquity", "period", "sampleSize"],
  },
  {
    key: "expectedShortfallR",
    label: "Expected shortfall",
    unit: "R",
    direction: "lower",
    definition: "Mean realized R in the worst five percent of measurable trade outcomes.",
    requiredContext: ["tailProbability", "sampleSize", "confidenceInterval"],
  },
  {
    key: "averageWinLossR",
    label: "Average win/loss",
    unit: "ratio",
    direction: "higher",
    definition: "Mean winning R divided by the absolute mean losing R.",
    requiredContext: ["wins", "losses", "scratches"],
  },
  {
    key: "turnover",
    label: "Turnover",
    unit: "ratio",
    direction: "context",
    definition: "Gross traded notional divided by average equity over the evaluation period.",
    requiredContext: ["period", "averageEquity", "sampleSize"],
  },
  {
    key: "costRatio",
    label: "Cost ratio",
    unit: "fraction",
    direction: "lower",
    definition: "Trading costs divided by absolute gross P&L; undefined when gross P&L is zero.",
    requiredContext: ["grossPnl", "costs", "sampleSize"],
  },
  {
    key: "calibrationError",
    label: "Calibration error",
    unit: "fraction",
    direction: "lower",
    definition: "Weighted absolute gap between predicted outcome frequency and observed frequency.",
    requiredContext: ["bins", "sampleSize", "confidenceInterval"],
  },
  {
    key: "abstentionRate",
    label: "Abstention rate",
    unit: "fraction",
    direction: "context",
    definition: "Eligible decision snapshots ending without an entry divided by all eligible snapshots.",
    requiredContext: ["eligibleDecisions", "abstentions", "reasonCodes"],
  },
  {
    key: "regimeStability",
    label: "Regime stability",
    unit: "ratio",
    direction: "higher",
    definition: "Share of evaluated regimes in which candidate performance is non-inferior to control.",
    requiredContext: ["regimeCounts", "nonInferiorityMargin", "confidenceInterval"],
  },
  {
    key: "liveBacktestDrift",
    label: "Forward/backtest drift",
    unit: "fraction",
    direction: "lower",
    definition: "Normalized difference between forward and matched backtest metric values.",
    requiredContext: ["metricKey", "forwardWindow", "matchedBacktestWindow", "sampleSize"],
  },
] as const satisfies readonly BaselineMetricDefinition[];

export type PromotionStage = "research" | "shadow" | "copilot" | "demo" | "live-restricted";

export interface PromotionGate {
  stage: PromotionStage;
  minimumEligibleDecisions: number;
  minimumClosedTrades: number;
  minimumCalendarDays: number;
  requirements: readonly string[];
  humanApprovalRequired: boolean;
}

export const PROMOTION_GATES: readonly PromotionGate[] = [
  {
    stage: "research",
    minimumEligibleDecisions: 0,
    minimumClosedTrades: 0,
    minimumCalendarDays: 0,
    requirements: [
      "Manifest validates and fingerprints deterministically.",
      "Point-in-time replay produces the same decision stream.",
      "Costs, sample sizes, and uncertainty accompany every headline result.",
    ],
    humanApprovalRequired: true,
  },
  {
    stage: "shadow",
    minimumEligibleDecisions: 200,
    minimumClosedTrades: 50,
    minimumCalendarDays: 28,
    requirements: [
      "No look-ahead, contract, or risk-policy violation.",
      "Candidate is evaluated beside Brain V0 on identical snapshots.",
      "Net expectancy is not materially inferior to Brain V0 within the approved uncertainty bound.",
    ],
    humanApprovalRequired: true,
  },
  {
    stage: "copilot",
    minimumEligibleDecisions: 500,
    minimumClosedTrades: 100,
    minimumCalendarDays: 56,
    requirements: [
      "Shadow decision and abstention calibration are reported by regime.",
      "Maximum drawdown is within the approved non-inferiority margin.",
      "Every recommendation is expiring, reproducible, and non-executable without approval.",
    ],
    humanApprovalRequired: true,
  },
  {
    stage: "demo",
    minimumEligibleDecisions: 1000,
    minimumClosedTrades: 200,
    minimumCalendarDays: 84,
    requirements: [
      "Co-Pilot revalidation, idempotency, and stale-plan refusal pass.",
      "Forward costs and fills remain within approved drift limits.",
      "Parameters remain frozen for the complete evaluation window.",
    ],
    humanApprovalRequired: true,
  },
  {
    stage: "live-restricted",
    minimumEligibleDecisions: 2000,
    minimumClosedTrades: 400,
    minimumCalendarDays: 112,
    requirements: [
      "Live safety, reconciliation, protection, kill-switch, and recovery controls pass.",
      "Demo results remain non-inferior to Brain V0 after costs and uncertainty.",
      "A versioned, revocable, time-bounded trading mandate is approved.",
    ],
    humanApprovalRequired: true,
  },
];

export interface RollbackCondition {
  key: string;
  severity: "immediate" | "threshold";
  condition: string;
  response: string;
}

export const ROLLBACK_CONDITIONS: readonly RollbackCondition[] = [
  { key: "contract-invalid", severity: "immediate", condition: "A decision or baseline contract fails runtime validation.", response: "Suspend the candidate and return to the last approved stage." },
  { key: "risk-policy-violation", severity: "immediate", condition: "Any proposed or executed action exceeds deterministic risk authority.", response: "Stop new entries, preserve protection, and require incident review." },
  { key: "data-quality", severity: "immediate", condition: "Required point-in-time data is stale, missing, contradictory, or non-finite.", response: "Block new decisions until data health is restored." },
  { key: "execution-ambiguity", severity: "immediate", condition: "An order, position, or protection state cannot be reconciled.", response: "Enter exit-only mode and reconcile before resuming." },
  { key: "drawdown", severity: "threshold", condition: "Drawdown exceeds the approved stage or mandate limit.", response: "Suspend the candidate and compare the decision stream with Brain V0." },
  { key: "model-drift", severity: "threshold", condition: "Calibration, regime distribution, or realized outcomes cross an approved drift boundary.", response: "Return the candidate to Shadow and open a versioned investigation." },
  { key: "execution-drift", severity: "threshold", condition: "Forward fees, spread, slippage, latency, or fill rate materially diverge from the matched simulation.", response: "Stop promotion or reduce the operating stage until parity is restored." },
];

const SHA256 = /^[a-f0-9]{64}$/i;
const GIT_SHA = /^[a-f0-9]{40}$/i;

function sortedCopy(manifest: BrainV0BaselineManifest): BrainV0BaselineManifest {
  return {
    ...manifest,
    marketData: {
      ...manifest.marketData,
      symbols: [...manifest.marketData.symbols].sort(),
      candleRanges: [...manifest.marketData.candleRanges].sort((a, b) =>
        a.timeframe.localeCompare(b.timeframe) ||
        a.startInclusive.localeCompare(b.startInclusive) ||
        a.endExclusive.localeCompare(b.endExclusive),
      ),
    },
  };
}

export function validateBaselineManifest(manifest: BrainV0BaselineManifest): readonly string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== BASELINE_SCHEMA_VERSION) errors.push("unsupported schemaVersion");
  if (manifest.brainVersion !== BRAIN_V0_VERSION) errors.push("brainVersion must be brain-v0");
  if (manifest.role !== "control") errors.push("role must be control");
  if (!GIT_SHA.test(manifest.source.gitCommit)) errors.push("source.gitCommit must be a 40-character Git SHA");
  if (!SHA256.test(manifest.strategy.configHash)) errors.push("strategy.configHash must be SHA-256");
  if (!SHA256.test(manifest.risk.configHash)) errors.push("risk.configHash must be SHA-256");
  if (!SHA256.test(manifest.marketData.universeHash)) errors.push("marketData.universeHash must be SHA-256");
  if (manifest.marketData.symbols.length === 0) errors.push("marketData.symbols must not be empty");
  if (new Set(manifest.marketData.symbols).size !== manifest.marketData.symbols.length) errors.push("marketData.symbols must be unique");
  if (manifest.marketData.candleRanges.length === 0) errors.push("marketData.candleRanges must not be empty");
  for (const [index, range] of manifest.marketData.candleRanges.entries()) {
    const start = Date.parse(range.startInclusive);
    const end = Date.parse(range.endExclusive);
    if (!range.timeframe.trim()) errors.push("candleRanges[" + index + "].timeframe is required");
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) errors.push("candleRanges[" + index + "] must be a valid half-open interval");
  }
  const requiredStrings: Array<[string, string]> = [
    ["strategy.catalogVersion", manifest.strategy.catalogVersion],
    ["risk.policyVersion", manifest.risk.policyVersion],
    ["marketData.provider", manifest.marketData.provider],
    ["marketData.featureVersion", manifest.marketData.featureVersion],
    ["costs.feeModelVersion", manifest.costs.feeModelVersion],
    ["costs.slippageModelVersion", manifest.costs.slippageModelVersion],
    ["execution.fillModelVersion", manifest.execution.fillModelVersion],
  ];
  for (const [path, value] of requiredStrings) if (!value.trim()) errors.push(path + " is required");
  return errors;
}

export function canonicalManifestJson(manifest: BrainV0BaselineManifest): string {
  const errors = validateBaselineManifest(manifest);
  if (errors.length) throw new Error("Invalid Brain V0 baseline manifest: " + errors.join("; "));
  return JSON.stringify(sortedCopy(manifest));
}

export function baselineManifestFingerprint(manifest: BrainV0BaselineManifest): string {
  return createHash("sha256").update(canonicalManifestJson(manifest), "utf8").digest("hex");
}
