import { deepFreeze, sha256Fingerprint } from "../canonical";
import { classifyOutcome, profitFactor, realizedR, round2, round4 } from "../../metrics/kernel";
import { sessionOf, volatilityBucketOf, type TradeObservation } from "../../knowledge/cells";
import { benjaminiHochberg, binomialTest, DEFAULT_FDR, wilsonInterval, type Tested } from "../../knowledge/stats";
import type { PointInTimeView } from "../../knowledge/pointInTime";
import {
  DEFAULT_EVIDENCE_HALF_LIFE_DAYS,
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceDimension,
  type EvidenceDrift,
  type EvidenceOutcomeMetrics,
  type EvidenceRecord,
  type EvidenceScope,
  type EvidenceSnapshot,
  type NumericInterval,
} from "./types";

export const MIN_EVIDENCE_SAMPLES = 30;
export const MIN_DRIFT_WINDOW_SAMPLES = 20;
const DAY_MS = 86_400_000;

interface Bucket { scope: EvidenceScope; rows: TradeObservation[] }

interface EvidenceDraft {
  scope: EvidenceScope;
  rows: TradeObservation[];
  metrics: EvidenceOutcomeMetrics;
  pValue: number | null;
  qValue: number | null;
  significant: boolean;
}

const titleCase = (value: string): string => value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

function deterministicUuid(value: unknown): string {
  const chars = sha256Fingerprint(value).slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function meanInterval(values: readonly number[]): NumericInterval | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { lower: round4(mean - margin), upper: round4(mean + margin), confidenceLevel: 0.95 };
}

function confidenceBucket(confidence: number | null): string | null {
  if (confidence == null || !Number.isFinite(confidence)) return null;
  if (confidence < 50) return "below_50";
  if (confidence < 65) return "50_64";
  if (confidence < 80) return "65_79";
  return "80_plus";
}

function scopeFor(dimension: EvidenceDimension, row: TradeObservation): EvidenceScope | null {
  const base = {
    dimension, strategyId: null, regime: null, symbol: null, symbolClass: null,
    direction: null, volatility: null, session: null, confidenceBucket: null, managementPolicy: null,
  } as const;
  switch (dimension) {
    case "strategy_regime":
      if (!row.strategyId || !row.regime) return null;
      return { ...base, key: `${row.strategyId}|${row.regime}`, label: `${titleCase(row.strategyId)} · ${titleCase(row.regime)}`, strategyId: row.strategyId, regime: row.regime };
    case "symbol_strategy":
      if (!row.strategyId) return null;
      return { ...base, key: `${row.symbol}|${row.strategyId}`, label: `${row.symbol} · ${titleCase(row.strategyId)}`, symbol: row.symbol, strategyId: row.strategyId };
    case "symbol_class":
      if (!row.symbolClass) return null;
      return { ...base, key: row.symbolClass, label: titleCase(row.symbolClass), symbolClass: row.symbolClass };
    case "direction":
      if (!row.direction) return null;
      return { ...base, key: row.direction, label: `${titleCase(row.direction)} trades`, direction: row.direction };
    case "volatility": {
      const bucket = volatilityBucketOf(row.atrPercent);
      if (!bucket) return null;
      return { ...base, key: bucket, label: `${titleCase(bucket)} volatility`, volatility: bucket };
    }
    case "session": {
      const session = sessionOf(row.entryTime);
      return { ...base, key: session, label: `${titleCase(session)} session`, session };
    }
    case "confidence_bucket": {
      const bucket = confidenceBucket(row.confidence);
      if (!bucket) return null;
      return { ...base, key: bucket, label: `Confidence ${bucket.replace("_", "–")}`, confidenceBucket: bucket };
    }
    case "management_policy":
      if (!row.managementPolicy) return null;
      return { ...base, key: row.managementPolicy, label: titleCase(row.managementPolicy), managementPolicy: row.managementPolicy };
  }
}

function metricsOf(rows: readonly TradeObservation[], minimumSamples: number): EvidenceOutcomeMetrics {
  let wins = 0, losses = 0, scratches = 0, net = 0, grossProfit = 0, grossLoss = 0;
  const gross: number[] = [], fees: number[] = [], slippage: number[] = [], rValues: number[] = [];
  const mae: number[] = [], mfe: number[] = [], timeMae: number[] = [], timeMfe: number[] = [];
  const pnlValues: number[] = [];
  for (const row of rows) {
    const outcome = classifyOutcome(row.pnl, row.plannedRisk, row.exitReason);
    if (outcome === "win") wins++; else if (outcome === "loss") losses++; else scratches++;
    net += row.pnl;
    pnlValues.push(row.pnl);
    if (row.pnl > 0) grossProfit += row.pnl; else grossLoss += Math.abs(row.pnl);
    const grossValue = finite(row.grossPnlUsdt);
    if (grossValue != null) gross.push(grossValue);
    const feeValue = finite(row.feesUsdt);
    const slippageValue = finite(row.slippageUsdt);
    if (feeValue != null && slippageValue != null) { fees.push(feeValue); slippage.push(slippageValue); }
    const r = realizedR(row.pnl, row.plannedRisk);
    if (r != null) rValues.push(r);
    const maeValue = finite(row.maeUsdt), mfeValue = finite(row.mfeUsdt);
    if (maeValue != null && mfeValue != null) { mae.push(maeValue); mfe.push(mfeValue); }
    const tMae = finite(row.timeToMaeSeconds), tMfe = finite(row.timeToMfeSeconds);
    if (tMae != null && tMfe != null) { timeMae.push(tMae); timeMfe.push(tMfe); }
  }
  const gated = rows.length < minimumSamples;
  const decided = wins + losses;
  const interval = !gated ? wilsonInterval(wins, decided) : null;
  const average = (values: readonly number[]) => values.length ? round4(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  return {
    samples: rows.length, minimumSamples, gated, wins, losses, scratches,
    winRate: !gated && decided > 0 ? round4(wins / decided) : null,
    winRateInterval: interval ? { lower: round4(interval.low), upper: round4(interval.high), confidenceLevel: 0.95 } : null,
    grossPnlUsdt: gross.length === rows.length ? round2(gross.reduce((sum, value) => sum + value, 0)) : null,
    grossPnlCoverage: rows.length ? round4(gross.length / rows.length) : 0,
    feesUsdt: fees.length === rows.length ? round2(fees.reduce((sum, value) => sum + value, 0)) : null,
    slippageUsdt: slippage.length === rows.length ? round2(slippage.reduce((sum, value) => sum + value, 0)) : null,
    costCoverage: rows.length ? round4(fees.length / rows.length) : 0,
    netPnlUsdt: round2(net),
    expectancyUsdt: gated ? null : round4(net / Math.max(1, rows.length)),
    expectancyInterval: gated ? null : meanInterval(pnlValues),
    profitFactor: gated ? null : round4(profitFactor(grossProfit, grossLoss)),
    averageR: gated ? null : average(rValues),
    averageRInterval: gated ? null : meanInterval(rValues),
    averageMaeUsdt: gated ? null : average(mae),
    averageMfeUsdt: gated ? null : average(mfe),
    excursionCoverage: rows.length ? round4(mae.length / rows.length) : 0,
    averageTimeToMaeSeconds: gated ? null : average(timeMae),
    averageTimeToMfeSeconds: gated ? null : average(timeMfe),
    excursionTimingCoverage: rows.length ? round4(timeMae.length / rows.length) : 0,
  };
}

function driftOf(rows: readonly TradeObservation[]): EvidenceDrift {
  const split = Math.floor(rows.length * 0.7);
  const reference = rows.slice(0, split), recent = rows.slice(split);
  if (reference.length < MIN_DRIFT_WINDOW_SAMPLES || recent.length < MIN_DRIFT_WINDOW_SAMPLES) {
    return { status: "insufficient_data", referenceSamples: reference.length, recentSamples: recent.length, referenceWinRate: null, recentWinRate: null, absoluteShift: null, intervalsOverlap: null, reason: "Both reference and recent windows need at least 20 outcomes." };
  }
  const decided = (items: readonly TradeObservation[]) => items.map((row) => classifyOutcome(row.pnl, row.plannedRisk, row.exitReason)).filter((outcome) => outcome !== "scratch");
  const refOutcomes = decided(reference), recentOutcomes = decided(recent);
  const refWins = refOutcomes.filter((outcome) => outcome === "win").length;
  const recentWins = recentOutcomes.filter((outcome) => outcome === "win").length;
  if (!refOutcomes.length || !recentOutcomes.length) {
    return { status: "insufficient_data", referenceSamples: reference.length, recentSamples: recent.length, referenceWinRate: null, recentWinRate: null, absoluteShift: null, intervalsOverlap: null, reason: "The drift windows do not contain enough decided outcomes." };
  }
  const referenceWinRate = refWins / refOutcomes.length, recentWinRate = recentWins / recentOutcomes.length;
  const refInterval = wilsonInterval(refWins, refOutcomes.length)!, recentInterval = wilsonInterval(recentWins, recentOutcomes.length)!;
  const overlap = refInterval.low <= recentInterval.high && recentInterval.low <= refInterval.high;
  const shift = Math.abs(referenceWinRate - recentWinRate);
  const status = !overlap && shift >= 0.15 ? "degraded" : shift >= 0.15 ? "watch" : "stable";
  return {
    status, referenceSamples: reference.length, recentSamples: recent.length,
    referenceWinRate: round4(referenceWinRate), recentWinRate: round4(recentWinRate),
    absoluteShift: round4(shift), intervalsOverlap: overlap,
    reason: status === "stable" ? "Recent outcomes remain within the reference uncertainty band." : status === "watch" ? "The point estimate moved materially, but uncertainty bands still overlap." : "Recent outcomes moved materially outside the reference uncertainty band.",
  };
}

export interface BuildEvidenceOptions {
  readonly executionTarget: "demo" | "live";
  readonly generatedAt?: number;
  readonly minimumSamples?: number;
  readonly falseDiscoveryRate?: number;
  readonly halfLifeDays?: number;
  readonly dimensions?: readonly EvidenceDimension[];
}

const DEFAULT_DIMENSIONS: readonly EvidenceDimension[] = ["strategy_regime", "symbol_strategy", "symbol_class", "direction", "volatility", "session", "confidence_bucket", "management_policy"];

export function buildEvidenceSnapshot(view: PointInTimeView<TradeObservation>, options: BuildEvidenceOptions): EvidenceSnapshot {
  const minimumSamples = options.minimumSamples ?? MIN_EVIDENCE_SAMPLES;
  const fdr = options.falseDiscoveryRate ?? DEFAULT_FDR;
  const generatedAt = options.generatedAt ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_EVIDENCE_HALF_LIFE_DAYS;
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  const ordered = [...view.rows].sort((a, b) => a.closedAt - b.closedAt);
  const dataCutoffMs = ordered.at(-1)?.closedAt ?? view.asOf;
  const overall = metricsOf(ordered, minimumSamples);
  const baseline = overall.winRate;
  const buckets = new Map<string, Bucket>();
  for (const dimension of dimensions) for (const row of ordered) {
    const scope = scopeFor(dimension, row);
    if (!scope) continue;
    const id = `${dimension}:${scope.key}`;
    const bucket = buckets.get(id) ?? { scope, rows: [] };
    bucket.rows.push(row);
    buckets.set(id, bucket);
  }

  const drafts: EvidenceDraft[] = [];
  const family: Tested<EvidenceDraft>[] = [];
  for (const bucket of buckets.values()) {
    const metrics = metricsOf(bucket.rows, minimumSamples);
    const decided = metrics.wins + metrics.losses;
    const pValue = !metrics.gated && baseline != null && decided > 0 ? binomialTest(metrics.wins, decided, baseline) : null;
    const draft: EvidenceDraft = { scope: bucket.scope, rows: bucket.rows, metrics, pValue, qValue: null, significant: false };
    drafts.push(draft);
    if (pValue != null) family.push({ item: draft, pValue });
  }
  for (const adjusted of benjaminiHochberg(family, fdr)) {
    adjusted.item.qValue = round4(adjusted.qValue);
    adjusted.item.significant = adjusted.significant;
  }

  const records: EvidenceRecord[] = drafts.map((draft): EvidenceRecord => {
    const latest = draft.rows.at(-1)?.closedAt ?? null;
    const ageDays = latest == null ? 0 : Math.max(0, (generatedAt - latest) / DAY_MS);
    const decayWeight = Math.pow(0.5, ageDays / halfLifeDays);
    const effectDirection = baseline == null || draft.metrics.winRate == null ? "unknown" as const : !draft.significant ? "indistinguishable" as const : draft.metrics.winRate < baseline ? "worse" as const : "better" as const;
    const permission = effectDirection === "worse" && (draft.metrics.averageR ?? 0) < 0 ? "withhold" as const : "observe" as const;
    const lifecycle: EvidenceRecord["lifecycle"] = permission === "observe" ? "observational" : "shadow";
    const fingerprint = sha256Fingerprint({ schemaVersion: EVIDENCE_SCHEMA_VERSION, scope: draft.scope, metrics: draft.metrics, qValue: draft.qValue, dataCutoffMs });
    const learnedStatement = draft.metrics.gated
      ? `${draft.scope.label} has ${draft.metrics.samples} outcomes; ${minimumSamples} are required before estimating performance.`
      : effectDirection === "worse"
        ? `${draft.scope.label} underperformed the account baseline after multiple-testing correction.`
        : effectDirection === "better"
          ? `${draft.scope.label} outperformed the account baseline, but Phase 5 does not permit evidence to increase conviction.`
          : `${draft.scope.label} is not distinguishable from the account baseline after correction.`;
    return {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      evidenceId: deterministicUuid({ fingerprint, type: "evidence-record" }), fingerprint,
      lifecycle,
      scope: draft.scope, metrics: draft.metrics,
      statistics: { baselineWinRate: baseline, pValue: draft.pValue == null ? null : round4(draft.pValue), qValue: draft.qValue, falseDiscoveryRate: fdr, correction: "benjamini-hochberg" as const, significant: draft.significant, effectDirection },
      drift: driftOf(draft.rows), permission,
      learnedStatement,
      permittedBehavior: permission === "withhold" ? "May withhold a matching candidate only after validation and explicit approval." : "Display only; cannot change a decision.",
      dataCutoff: new Date(dataCutoffMs).toISOString(), latestOutcomeAt: latest == null ? null : new Date(latest).toISOString(),
      ageDays: round2(ageDays), halfLifeDays, decayWeight: round4(decayWeight),
    };
  }).sort((a, b) => {
    if (a.lifecycle !== b.lifecycle) return a.lifecycle === "shadow" ? -1 : 1;
    return (a.statistics.qValue ?? 1) - (b.statistics.qValue ?? 1) || b.metrics.samples - a.metrics.samples;
  });

  const fingerprint = sha256Fingerprint({ schemaVersion: EVIDENCE_SCHEMA_VERSION, executionTarget: options.executionTarget, dataCutoffMs, minimumSamples, fdr, recordFingerprints: records.map((record) => record.fingerprint) });
  return deepFreeze({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    snapshotVersion: `evidence-v1:${fingerprint.slice(0, 16)}`,
    fingerprint,
    executionTarget: options.executionTarget,
    generatedAt: new Date(generatedAt).toISOString(),
    dataCutoff: new Date(dataCutoffMs).toISOString(),
    totalOutcomes: ordered.length,
    minimumSamples,
    falseDiscoveryRate: fdr,
    cellsTested: family.length,
    records,
    limitations: [
      "Evidence is descriptive until a separate walk-forward validation and explicit approval promote a tightening-only rule set.",
      "Excursion timing remains unavailable for trades recorded before timestamp capture was introduced.",
      "Positive historical evidence is never allowed to increase conviction in Phase 5.",
    ],
  });
}
