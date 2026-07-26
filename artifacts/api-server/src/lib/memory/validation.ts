/**
 * TradeCore Pro — walk-forward validation of memory influence
 *
 * The question that has to be answered before memory is allowed near real
 * money: on trades it never saw, would this have helped?
 *
 * The failure mode being defended against is not subtle, it is just easy. Fit
 * cells on the whole record, notice that the losing cells lose, "withhold"
 * them in hindsight, and report a transformed account. That result is
 * guaranteed and worth nothing — it is a restatement of the input, not a
 * prediction. So:
 *
 *   - Cells are built from the TRAIN window only, through P7's point-in-time
 *     view, which makes the exclusion of later data a type-level property
 *     rather than a promise.
 *   - The influence state built from them is then applied, unchanged, to the
 *     VALIDATION window it was never fitted to.
 *   - The comparison is against the same window with memory off, so both arms
 *     see identical trades and the delta is attributable to the rules alone.
 *
 * `no_better` is a first-class verdict, and the expected one on most accounts.
 * The autopsy runner (lib/autopsy) already established this shape for
 * parameter sweeps; this is the same discipline applied to memory.
 */
import { expectancyPerTrade, classifyOutcome, round2, round4, winRateOrNull } from "../metrics/kernel";
import { asOfView, chronologicalSplit, type PointInTimeView } from "../knowledge/pointInTime";
import { buildKnowledge, type TradeObservation } from "../knowledge/cells";
import {
  buildInfluenceState, evaluateInfluence, DEFAULT_MAX_DELTA,
  type InfluenceState,
} from "./influence";

/**
 * Minimum trades in the validation window before a verdict is possible.
 *
 * Same reasoning as everywhere else in the knowledge layer: a verdict from 12
 * trades is a coin flip wearing a lab coat, and this particular coin flip
 * unlocks live influence.
 */
export const MIN_VALIDATION_TRADES = 40;

/** Minimum trades memory must leave in the validation window. */
export const MIN_SURVIVING_FRACTION = 0.5;

export type Verdict = "improved" | "no_better" | "insufficient_data";

export interface ArmMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnlUsdt: number;
  expectancyUsdt: number;
}

export interface ValidationResult {
  verdict: Verdict;
  /** Human-readable, and the text the UI shows verbatim. */
  summary: string;
  trainTrades: number;
  validationTrades: number;
  /** Trades memory would have withheld in the validation window. */
  withheld: number;
  /** The state fitted on train and tested on validation. */
  state: InfluenceState;
  /** Every validation trade, memory off. */
  baseline: ArmMetrics;
  /** Validation trades memory would have allowed through. */
  withMemory: ArmMetrics;
  /** withMemory.expectancyUsdt − baseline.expectancyUsdt. */
  expectancyDelta: number;
  /** P&L of the trades memory withheld. Negative here is the point. */
  withheldPnlUsdt: number;
}

function metricsOf(trades: readonly TradeObservation[]): ArmMetrics {
  let wins = 0, losses = 0, net = 0;
  for (const t of trades) {
    const outcome = classifyOutcome(t.pnl, t.plannedRisk, t.exitReason);
    if (outcome === "win") wins++;
    else if (outcome === "loss") losses++;
    net += t.pnl;
  }
  const wr = winRateOrNull(wins, wins + losses);
  return {
    trades: trades.length,
    wins,
    losses,
    winRate: wr == null ? null : round4(wr),
    netPnlUsdt: round2(net),
    expectancyUsdt: round2(expectancyPerTrade(net, trades.length)),
  };
}

export interface ValidationOptions {
  maxDelta?: number;
  trainFraction?: number;
  minValidationTrades?: number;
  /** Per-strategy confidence bars, so the reference matches what ran live. */
  strategyThresholds?: Map<string, number>;
  /** Fallback bar for a strategy with no recorded config. */
  defaultThreshold?: number;
  now?: number;
}

/**
 * Fit on the past, test on the future, and refuse to claim an improvement
 * that isn't there.
 *
 * Returns the fitted state alongside the verdict: a caller that wants to
 * enable influence needs both the permission and the exact rules that earned
 * it, and re-fitting afterwards would enable something the validation never
 * examined.
 */
export function validateInfluence(
  view: PointInTimeView<TradeObservation>,
  opts: ValidationOptions = {},
): ValidationResult {
  const maxDelta = opts.maxDelta ?? DEFAULT_MAX_DELTA;
  const minValidation = opts.minValidationTrades ?? MIN_VALIDATION_TRADES;
  const defaultThreshold = opts.defaultThreshold ?? 65;
  const now = opts.now ?? Date.now();

  const { train, validation } = chronologicalSplit(view, opts.trainFraction ?? 0.7);

  // Cells are fitted on the train window, cut at the train window's own end.
  // Re-cutting rather than reusing `train` directly is belt-and-braces: it is
  // what makes the "never saw validation data" claim mechanical.
  const trainView = asOfView(train.rows, train.asOf);
  const report = buildKnowledge(trainView);
  const state = buildInfluenceState(report, { maxDelta, enabled: true, now });

  const baseline = metricsOf(validation.rows);

  const empty: ValidationResult = {
    verdict: "insufficient_data",
    summary: "",
    trainTrades: train.rows.length,
    validationTrades: validation.rows.length,
    withheld: 0,
    state,
    baseline,
    withMemory: baseline,
    expectancyDelta: 0,
    withheldPnlUsdt: 0,
  };

  if (validation.rows.length < minValidation) {
    return {
      ...empty,
      summary:
        `Not enough out-of-sample trades to judge: ${validation.rows.length} in the validation window, ` +
        `${minValidation} needed. Keep trading — this re-runs on demand.`,
    };
  }

  if (state.rules.length === 0) {
    return {
      ...empty,
      verdict: "no_better",
      summary:
        "No cell in the training window has both enough trades and evidence surviving " +
        "multiple-comparison correction, so memory would have withheld nothing. " +
        "Nothing to enable.",
    };
  }

  const allowed: TradeObservation[] = [];
  const withheldTrades: TradeObservation[] = [];

  for (const t of validation.rows) {
    // A trade with no attributed strategy cannot be matched to a
    // strategy-keyed cell and is never withheld — memory acts on evidence
    // about a known strategy, not on the absence of one.
    if (!t.strategyId || t.confidence == null) { allowed.push(t); continue; }

    const outcome = evaluateInfluence(state, {
      strategyId: t.strategyId,
      symbol: t.symbol,
      regime: t.regime,
      entryTime: t.entryTime,
      atrPercent: t.atrPercent,
      confidence: t.confidence,
      strategyThreshold: opts.strategyThresholds?.get(t.strategyId) ?? defaultThreshold,
    });

    if (outcome.admitted) allowed.push(t);
    else withheldTrades.push(t);
  }

  const withMemory = metricsOf(allowed);
  const withheldPnl = round2(withheldTrades.reduce((s, t) => s + t.pnl, 0));
  const expectancyDelta = round2(withMemory.expectancyUsdt - baseline.expectancyUsdt);

  const result: ValidationResult = {
    ...empty,
    state,
    baseline,
    withMemory,
    withheld: withheldTrades.length,
    withheldPnlUsdt: withheldPnl,
    expectancyDelta,
  };

  // Withholding almost everything can "improve" expectancy while destroying
  // the account's ability to trade at all. A rule set that leaves less than
  // half the flow is over-fitted to the training window whatever its
  // out-of-sample expectancy says.
  const survivingFraction = validation.rows.length > 0 ? allowed.length / validation.rows.length : 0;
  if (survivingFraction < MIN_SURVIVING_FRACTION) {
    return {
      ...result,
      verdict: "no_better",
      summary:
        `Memory would have withheld ${withheldTrades.length} of ${validation.rows.length} out-of-sample trades ` +
        `(${((1 - survivingFraction) * 100).toFixed(0)}%) — too much of the account's activity to be a filter ` +
        `rather than a shutdown. Not enabling.`,
    };
  }

  if (expectancyDelta <= 0) {
    return {
      ...result,
      verdict: "no_better",
      summary:
        `On ${validation.rows.length} out-of-sample trades, memory would have withheld ${withheldTrades.length} ` +
        `worth $${withheldPnl.toFixed(2)} and moved expectancy by $${expectancyDelta.toFixed(2)} per trade. ` +
        `That is not an improvement, so influence stays off.`,
    };
  }

  return {
    ...result,
    verdict: "improved",
    summary:
      `On ${validation.rows.length} out-of-sample trades it never saw, memory would have withheld ` +
      `${withheldTrades.length} worth $${withheldPnl.toFixed(2)}, lifting expectancy from ` +
      `$${baseline.expectancyUsdt.toFixed(2)} to $${withMemory.expectancyUsdt.toFixed(2)} per trade ` +
      `(+$${expectancyDelta.toFixed(2)}).`,
  };
}
