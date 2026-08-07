/** Phase 5 evidence learning — pure point-in-time, statistics, drift and lifecycle gates. */
import { asOfView } from "../src/lib/knowledge/pointInTime";
import type { TradeObservation } from "../src/lib/knowledge/cells";
import {
  buildEvidenceSnapshot,
  MIN_EVIDENCE_SAMPLES,
  PROMOTION_CONFIRMATION,
  ROLLBACK_CONFIRMATION,
  promotionDecision,
  rollbackDecision,
} from "../src/lib/intelligence/evidence";
import { validateInfluence } from "../src/lib/memory/validation";

let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (condition) console.log(`✓  ${name}`);
  else { failures++; console.error(`✗  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2025-01-01T09:00:00Z");

function trade(index: number, overrides: Partial<TradeObservation> = {}): TradeObservation {
  const win = overrides.pnl == null ? index % 2 === 0 : overrides.pnl > 0;
  const pnl = overrides.pnl ?? (win ? 9 : -11);
  const entryTime = overrides.entryTime ?? T0 + index * DAY;
  return {
    tradeId: index,
    entryTime,
    closedAt: overrides.closedAt ?? entryTime + HOUR,
    symbol: "BTCUSDT",
    symbolClass: "crypto",
    direction: "long",
    managementPolicy: "fixed_sltp",
    strategyId: "momentum",
    regime: "trending_up",
    atrPercent: 0.8,
    pnl,
    grossPnlUsdt: pnl + 1,
    feesUsdt: 0.5,
    slippageUsdt: 0.5,
    maeUsdt: pnl > 0 ? -2 : -9,
    mfeUsdt: pnl > 0 ? 14 : 3,
    timeToMaeSeconds: null,
    timeToMfeSeconds: null,
    plannedRisk: 10,
    exitReason: pnl > 0 ? "take_profit" : "stop_loss",
    confidence: 70,
    features: null,
    ...overrides,
  };
}

function persistentCells(): TradeObservation[] {
  const rows: TradeObservation[] = [];
  for (let i = 0; i < 120; i++) {
    const eth = i % 2 === 1;
    const local = Math.floor(i / 2);
    const win = eth ? local < 6 : local < 54;
    rows.push(trade(i, {
      symbol: eth ? "ETHUSDT" : "BTCUSDT",
      pnl: win ? 9 : -11,
      exitReason: win ? "take_profit" : "stop_loss",
      grossPnlUsdt: win ? 10 : -10,
    }));
  }
  return rows;
}

{
  const rows = persistentCells();
  const cutoff = rows[89]!.closedAt;
  const snapshot = buildEvidenceSnapshot(asOfView(rows, cutoff), {
    executionTarget: "demo",
    generatedAt: cutoff + DAY,
  });
  expect("future outcomes are excluded mechanically", snapshot.totalOutcomes === 90, String(snapshot.totalOutcomes));
  expect("all Phase 5 conditioning dimensions are present", new Set(snapshot.records.map((record) => record.scope.dimension)).size === 8);
  const eth = snapshot.records.find((record) => record.scope.key === "ETHUSDT|momentum")!;
  const btc = snapshot.records.find((record) => record.scope.key === "BTCUSDT|momentum")!;
  expect("the persistent drag survives multiple-testing correction", eth.statistics.significant && eth.statistics.qValue != null && eth.statistics.qValue <= snapshot.falseDiscoveryRate);
  expect("negative evidence is Shadow and may only withhold", eth.lifecycle === "shadow" && eth.permission === "withhold");
  expect("positive evidence remains observation-only", btc.permission === "observe" && btc.permittedBehavior.includes("cannot change"));
  expect("uncertainty is attached to reported win rate", eth.metrics.winRateInterval != null && eth.metrics.winRateInterval.lower < eth.metrics.winRateInterval.upper);
  expect("gross, costs and net are kept separate", eth.metrics.grossPnlUsdt != null && eth.metrics.feesUsdt != null && eth.metrics.slippageUsdt != null && Number.isFinite(eth.metrics.netPnlUsdt));
  expect("MAE/MFE coverage is reported", eth.metrics.excursionCoverage === 1 && eth.metrics.averageMaeUsdt != null && eth.metrics.averageMfeUsdt != null);
  expect("missing excursion timing is explicit, never fabricated", eth.metrics.excursionTimingCoverage === 0 && eth.metrics.averageTimeToMaeSeconds === null);

  const same = buildEvidenceSnapshot(asOfView(rows, cutoff), { executionTarget: "demo", generatedAt: cutoff + 30 * DAY });
  expect("the same data cut has the same version despite display-time decay", snapshot.snapshotVersion === same.snapshotVersion);
  expect("decay changes as evidence ages without changing historical metrics", same.records.find((record) => record.evidenceId === eth.evidenceId)!.decayWeight < eth.decayWeight);
}

{
  const thin = buildEvidenceSnapshot(asOfView(Array.from({ length: MIN_EVIDENCE_SAMPLES - 1 }, (_, i) => trade(i)), T0 + 100 * DAY), { executionTarget: "demo" });
  expect("thin evidence exposes its count but no estimate", thin.records.every((record) => record.metrics.gated && record.metrics.winRate === null));
  expect("thin evidence never receives behavior authority", thin.records.every((record) => record.permission === "observe"));
}

{
  const shifted = [
    ...Array.from({ length: 70 }, (_, i) => trade(i, { pnl: 10, exitReason: "take_profit" })),
    ...Array.from({ length: 30 }, (_, i) => trade(70 + i, { pnl: -10, exitReason: "stop_loss" })),
  ];
  const snapshot = buildEvidenceSnapshot(asOfView(shifted, T0 + 200 * DAY), { executionTarget: "demo" });
  const direction = snapshot.records.find((record) => record.scope.dimension === "direction")!;
  expect("material non-overlapping recent shift is degraded drift", direction.drift.status === "degraded", direction.drift.reason);
}

{
  const base = {
    status: "shadow" as const,
    verdict: "improved" as const,
    permits: "withhold" as const,
    driftStatus: "stable" as const,
    validationTrades: 60,
    minimumValidationTrades: 40,
  };
  expect("validation alone cannot activate", !promotionDecision(base, "").allowed);
  expect("exact human confirmation permits a valid Shadow version", promotionDecision(base, PROMOTION_CONFIRMATION).allowed);
  expect("no-better evidence cannot be promoted", !promotionDecision({ ...base, verdict: "no_better" }, PROMOTION_CONFIRMATION).allowed);
  expect("degraded evidence cannot be promoted", !promotionDecision({ ...base, driftStatus: "degraded" }, PROMOTION_CONFIRMATION).allowed);
  expect("under-sampled validation cannot be promoted", !promotionDecision({ ...base, validationTrades: 39 }, PROMOTION_CONFIRMATION).allowed);
  expect("rollback requires a prior inert version and its own confirmation", rollbackDecision({ ...base, status: "suspended" }, ROLLBACK_CONFIRMATION).allowed);
  expect("rollback refuses an active version", !rollbackDecision({ ...base, status: "active" }, ROLLBACK_CONFIRMATION).allowed);
}

{
  const rows = Array.from({ length: 100 }, (_, i) => trade(i));
  const validation = validateInfluence(asOfView(rows, T0 + 200 * DAY), {
    embargoMs: 2 * DAY,
    minValidationTrades: 1,
  });
  expect("the chronological validation split applies the embargo", validation.embargoedTrades === 1, String(validation.embargoedTrades));
  expect("the embargo is recorded in the result", validation.embargoMs === 2 * DAY);
  expect("train and validation ranges are explicit", validation.trainTo != null && validation.validationFrom != null && Date.parse(validation.validationFrom) > Date.parse(validation.trainTo));
}

console.log(failures === 0 ? "\nevidence-learning: all checks passed" : `\nevidence-learning: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
