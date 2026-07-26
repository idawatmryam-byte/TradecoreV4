/**
 * TradeCore Pro — probability calibration
 *
 * A strategy's confidence is a 0–100 score assembled from weighted indicator
 * votes. It is an ordering, not a probability: nothing in its construction
 * makes "confidence 70" mean "wins 70% of the time", and presenting it as
 * though it did is the single most misleading thing a trading UI can do.
 *
 * This module answers the empirical question — when this account's engine said
 * 70, what actually happened? — and produces a mapping from score to observed
 * frequency, with the diagnostics needed to say whether that mapping is worth
 * anything.
 *
 * Three commitments:
 *
 *  1. OUT-OF-SAMPLE OR NOTHING. The mapping is fitted on an earlier slice and
 *     scored on a later one (chronologically, never shuffled). An isotonic fit
 *     scored on its own training data reports a near-perfect calibration curve
 *     no matter how meaningless the underlying signal is.
 *
 *  2. BEATEN BY CLIMATOLOGY MEANS UNUSABLE. Every score is compared against
 *     the trivial model that ignores confidence entirely and predicts the base
 *     rate for everything. A calibration that cannot beat that is reported as
 *     not beating it, in the payload, rather than shown as a curve.
 *
 *  3. THE OUTPUT IS PRESENTATION DATA. Calibrated probability is deliberately
 *     kept OUT of the hashed TradePlan payload. If it entered the fingerprint,
 *     a weekly refit would silently change the fingerprint of an unchanged
 *     decision and destroy the replay guarantee P0 exists to provide.
 */
import { round4 } from "../metrics/kernel";
import { classifyOutcome } from "../metrics/kernel";
import { chronologicalSplit, type Observable, type PointInTimeView } from "./pointInTime";
import type { TradeObservation } from "./cells";

/**
 * Minimum VALIDATION-set size before any calibration figure is reported.
 *
 * The gate is on the validation set, not the total, because every number this
 * module publishes is measured there — gating on the total would let a 30-trade
 * account report a Brier score computed from nine trades. With the default 70/30
 * split that means roughly 100 closed trades before anything appears. That is a
 * demanding gate, and it is the correct one: a calibration curve is a promise
 * about future frequencies, and there is no such thing as a provisional promise.
 */
export const MIN_CALIBRATION_SAMPLES = 30;

/** Default share of the record used for fitting; the rest scores the fit. */
export const DEFAULT_TRAIN_FRACTION = 0.7;

export interface CalibrationPoint extends Observable {
  readonly closedAt: number;
  /** The forecast, mapped to 0–1. */
  readonly predicted: number;
  /** What happened: 1 win, 0 loss. */
  readonly actual: 0 | 1;
}

/**
 * Reduce closed trades to forecast/outcome pairs.
 *
 * Scratches are dropped rather than counted either way. Calibration is a
 * statement about a binary event, and a break-even wash is genuinely neither
 * outcome — forcing it to 0 would make every strategy look overconfident by
 * construction, and forcing it to 1 the reverse.
 */
export function toCalibrationPoints(view: PointInTimeView<TradeObservation>): PointInTimeView<CalibrationPoint> {
  const rows: CalibrationPoint[] = [];
  for (const t of view.rows) {
    if (t.confidence == null || !Number.isFinite(t.confidence)) continue;
    const outcome = classifyOutcome(t.pnl, t.plannedRisk, t.exitReason);
    if (outcome === "scratch") continue;
    rows.push({
      closedAt: t.closedAt,
      predicted: Math.min(1, Math.max(0, t.confidence / 100)),
      actual: outcome === "win" ? 1 : 0,
    });
  }
  return { asOf: view.asOf, rows };
}

// ---------------------------------------------------------------------------
// Scoring rules
// ---------------------------------------------------------------------------

/** Mean squared error of the forecasts. Lower is better; 0.25 is a coin flip. */
export function brierScore(points: readonly CalibrationPoint[]): number | null {
  if (points.length === 0) return null;
  let sum = 0;
  for (const p of points) sum += (p.predicted - p.actual) ** 2;
  return sum / points.length;
}

/**
 * Mean negative log likelihood. Clamped away from 0 and 1 — an unclamped
 * confident miss is infinite, and one such trade would swallow the metric.
 */
export function logLoss(points: readonly CalibrationPoint[], eps = 1e-6): number | null {
  if (points.length === 0) return null;
  let sum = 0;
  for (const p of points) {
    const q = Math.min(1 - eps, Math.max(eps, p.predicted));
    sum += p.actual === 1 ? -Math.log(q) : -Math.log(1 - q);
  }
  return sum / points.length;
}

export interface ReliabilityBin {
  /** Bin bounds on the forecast axis, [low, high). */
  low: number;
  high: number;
  count: number;
  /** Mean forecast in the bin — where the dot sits horizontally. */
  meanPredicted: number | null;
  /** Observed win frequency — where it sits vertically. Perfect = the diagonal. */
  observedRate: number | null;
}

/** Equal-width reliability bins across [0, 1]. Empty bins are kept, as gaps are informative. */
export function reliabilityBins(points: readonly CalibrationPoint[], binCount = 10): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  for (let i = 0; i < binCount; i++) {
    bins.push({ low: i / binCount, high: (i + 1) / binCount, count: 0, meanPredicted: null, observedRate: null });
  }
  const sums = new Array(binCount).fill(0);
  const hits = new Array(binCount).fill(0);

  for (const p of points) {
    // The top bin is closed at 1 so a forecast of exactly 1.0 has a home.
    const idx = Math.min(binCount - 1, Math.floor(p.predicted * binCount));
    bins[idx]!.count++;
    sums[idx] += p.predicted;
    hits[idx] += p.actual;
  }

  bins.forEach((b, i) => {
    if (b.count > 0) {
      b.meanPredicted = round4(sums[i] / b.count);
      b.observedRate = round4(hits[i] / b.count);
    }
  });
  return bins;
}

/**
 * Expected Calibration Error: the sample-weighted average gap between what was
 * promised and what occurred. 0 is perfect; 0.1 means the forecasts are off by
 * ten percentage points on average where the data actually lives.
 */
export function expectedCalibrationError(points: readonly CalibrationPoint[], binCount = 10): number | null {
  if (points.length === 0) return null;
  let weighted = 0;
  for (const b of reliabilityBins(points, binCount)) {
    if (b.count === 0 || b.meanPredicted == null || b.observedRate == null) continue;
    weighted += (b.count / points.length) * Math.abs(b.observedRate - b.meanPredicted);
  }
  return weighted;
}

// ---------------------------------------------------------------------------
// Isotonic regression (pool-adjacent-violators)
// ---------------------------------------------------------------------------

export interface IsotonicKnot {
  /** Upper bound of the pooled block on the forecast axis. */
  x: number;
  /** Fitted probability for that block. */
  y: number;
}

export interface CalibrationModel {
  knots: IsotonicKnot[];
  /** Base rate of the training window — the fallback for an empty model. */
  baseRate: number;
  trainedOn: number;
}

/**
 * Fit a monotone non-decreasing mapping from forecast to observed frequency.
 *
 * Isotonic rather than Platt scaling (a logistic fit): the relationship between
 * an indicator-vote score and a win probability has no reason to be sigmoid,
 * and isotonic assumes only what we genuinely believe — that a higher score
 * should not mean a lower win rate. It is also the reason a non-monotone patch
 * of the raw data gets pooled flat instead of being reported as a real dip.
 */
export function fitIsotonic(points: readonly CalibrationPoint[]): CalibrationModel {
  const n = points.length;
  const baseRate = n > 0 ? points.reduce((s, p) => s + p.actual, 0) / n : 0.5;
  if (n === 0) return { knots: [], baseRate, trainedOn: 0 };

  const sorted = [...points].sort((a, b) => a.predicted - b.predicted);

  // Each block: total outcome weight, count, and the largest x it covers.
  const sum: number[] = [];
  const cnt: number[] = [];
  const maxX: number[] = [];

  for (const p of sorted) {
    sum.push(p.actual);
    cnt.push(1);
    maxX.push(p.predicted);
    // Pool backwards while the previous block promises more than this one.
    while (sum.length > 1) {
      const last = sum.length - 1;
      if (sum[last - 1]! / cnt[last - 1]! <= sum[last]! / cnt[last]!) break;
      sum[last - 1] = sum[last - 1]! + sum[last]!;
      cnt[last - 1] = cnt[last - 1]! + cnt[last]!;
      maxX[last - 1] = maxX[last]!;
      sum.pop(); cnt.pop(); maxX.pop();
    }
  }

  const knots = sum.map((s, i) => ({ x: round4(maxX[i]!), y: round4(s / cnt[i]!) }));
  return { knots, baseRate: round4(baseRate), trainedOn: n };
}

/**
 * Map a raw forecast through the fitted curve.
 *
 * Linear interpolation between knots, flat extrapolation outside them — the
 * model saw no evidence past its range, so it extends its last honest estimate
 * rather than projecting a trend it never observed.
 */
export function applyCalibration(model: CalibrationModel, predicted: number): number {
  const { knots } = model;
  if (knots.length === 0) return model.baseRate;
  const x = Math.min(1, Math.max(0, predicted));
  if (x <= knots[0]!.x) return knots[0]!.y;
  if (x >= knots[knots.length - 1]!.x) return knots[knots.length - 1]!.y;

  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1]!;
    const b = knots[i]!;
    if (x <= b.x) {
      const span = b.x - a.x;
      if (span <= 0) return b.y;
      return round4(a.y + ((x - a.x) / span) * (b.y - a.y));
    }
  }
  return knots[knots.length - 1]!.y;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface CalibrationScores {
  brier: number | null;
  logLoss: number | null;
  ece: number | null;
}

export interface CalibrationReport {
  asOf: number;
  /** True when the validation set is below the gate — every score is null. */
  gated: boolean;
  minSamples: number;
  /** Usable forecast/outcome pairs available at the cut (scratches excluded). */
  totalSamples: number;
  trainSamples: number;
  validationSamples: number;
  /** Additional validation-set trades needed to clear the gate; 0 once open. */
  samplesNeeded: number;

  /** How the engine's raw confidence scored, untouched. */
  raw: CalibrationScores;
  /** How it scored after the fitted mapping. */
  calibrated: CalibrationScores;
  /**
   * The do-nothing model: predict the training base rate for every trade.
   * If `calibrated.brier` is not below this, confidence carries no usable
   * information on this account's record and the curve should not be trusted.
   */
  climatologyBrier: number | null;
  /** calibrated.brier < climatologyBrier — stated, not left to the reader. */
  beatsClimatology: boolean;

  /** Reliability curve of the validation set under the raw forecasts. */
  bins: ReliabilityBin[];
  /** Null when gated — no curve is published that could be read as a promise. */
  model: CalibrationModel | null;
}

export interface CalibrationOptions {
  minSamples?: number;
  trainFraction?: number;
  binCount?: number;
}

/**
 * Fit and score the confidence→probability mapping for one account.
 *
 * Read-only and derived: nothing here writes, and nothing here is allowed to
 * reach a decision. Below the gate it returns the counts and nulls — which is
 * a genuinely useful answer ("14 more closed trades and this opens"), unlike a
 * Brier score computed from nine.
 */
export function calibrationReport(
  view: PointInTimeView<TradeObservation>,
  opts: CalibrationOptions = {},
): CalibrationReport {
  const minSamples = opts.minSamples ?? MIN_CALIBRATION_SAMPLES;
  const binCount = opts.binCount ?? 10;
  const points = toCalibrationPoints(view);
  const { train, validation } = chronologicalSplit(points, opts.trainFraction ?? DEFAULT_TRAIN_FRACTION);

  const base: CalibrationReport = {
    asOf: view.asOf,
    gated: validation.rows.length < minSamples,
    minSamples,
    totalSamples: points.rows.length,
    trainSamples: train.rows.length,
    validationSamples: validation.rows.length,
    samplesNeeded: Math.max(0, minSamples - validation.rows.length),
    raw: { brier: null, logLoss: null, ece: null },
    calibrated: { brier: null, logLoss: null, ece: null },
    climatologyBrier: null,
    beatsClimatology: false,
    bins: [],
    model: null,
  };
  if (base.gated) return base;

  const model = fitIsotonic(train.rows);
  const mapped: CalibrationPoint[] = validation.rows.map((p) => ({
    closedAt: p.closedAt, predicted: applyCalibration(model, p.predicted), actual: p.actual,
  }));
  const climatology: CalibrationPoint[] = validation.rows.map((p) => ({
    closedAt: p.closedAt, predicted: model.baseRate, actual: p.actual,
  }));

  const round = (n: number | null) => (n == null ? null : round4(n));
  const calibratedBrier = round(brierScore(mapped));
  const climatologyBrier = round(brierScore(climatology));

  return {
    ...base,
    raw: {
      brier: round(brierScore(validation.rows)),
      logLoss: round(logLoss(validation.rows)),
      ece: round(expectedCalibrationError(validation.rows, binCount)),
    },
    calibrated: {
      brier: calibratedBrier,
      logLoss: round(logLoss(mapped)),
      ece: round(expectedCalibrationError(mapped, binCount)),
    },
    climatologyBrier,
    beatsClimatology:
      calibratedBrier != null && climatologyBrier != null && calibratedBrier < climatologyBrier,
    bins: reliabilityBins(validation.rows, binCount),
    model,
  };
}
