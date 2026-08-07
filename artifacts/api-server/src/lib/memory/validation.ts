/**
 * Walk-forward validation for tightening-only memory influence.
 *
 * Rules are fitted on the chronological training window, an explicit embargo
 * removes outcomes too close to that cut, and the immutable state is evaluated
 * on later outcomes it never saw. Validation is evidence, not authorization.
 */
import { expectancyPerTrade, classifyOutcome, round2, round4, winRateOrNull } from "../metrics/kernel";
import { asOfView, chronologicalSplit, type PointInTimeView } from "../knowledge/pointInTime";
import { buildKnowledge, type TradeObservation } from "../knowledge/cells";
import {
  buildInfluenceState, evaluateInfluence, DEFAULT_MAX_DELTA,
  type InfluenceState,
} from "./influence";

export const MIN_VALIDATION_TRADES = 40;
export const MIN_SURVIVING_FRACTION = 0.5;
export const DEFAULT_EMBARGO_MS = 24 * 60 * 60 * 1000;

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
  summary: string;
  trainTrades: number;
  validationTrades: number;
  embargoedTrades: number;
  embargoMs: number;
  dataCutoff: string;
  trainFrom: string | null;
  trainTo: string | null;
  validationFrom: string | null;
  validationTo: string | null;
  correction: "benjamini-hochberg";
  withheld: number;
  state: InfluenceState;
  baseline: ArmMetrics;
  withMemory: ArmMetrics;
  expectancyDelta: number;
  withheldPnlUsdt: number;
}

function metricsOf(trades: readonly TradeObservation[]): ArmMetrics {
  let wins = 0, losses = 0, net = 0;
  for (const trade of trades) {
    const outcome = classifyOutcome(trade.pnl, trade.plannedRisk, trade.exitReason);
    if (outcome === "win") wins++;
    else if (outcome === "loss") losses++;
    net += trade.pnl;
  }
  const winRate = winRateOrNull(wins, wins + losses);
  return {
    trades: trades.length,
    wins,
    losses,
    winRate: winRate == null ? null : round4(winRate),
    netPnlUsdt: round2(net),
    expectancyUsdt: round2(expectancyPerTrade(net, trades.length)),
  };
}

export interface ValidationOptions {
  maxDelta?: number;
  trainFraction?: number;
  minValidationTrades?: number;
  embargoMs?: number;
  strategyThresholds?: Map<string, number>;
  defaultThreshold?: number;
  now?: number;
}

const iso = (value: number | undefined): string | null => value == null ? null : new Date(value).toISOString();

export function validateInfluence(
  view: PointInTimeView<TradeObservation>,
  opts: ValidationOptions = {},
): ValidationResult {
  const maxDelta = opts.maxDelta ?? DEFAULT_MAX_DELTA;
  const minValidation = opts.minValidationTrades ?? MIN_VALIDATION_TRADES;
  const defaultThreshold = opts.defaultThreshold ?? 65;
  const embargoMs = Math.max(0, opts.embargoMs ?? DEFAULT_EMBARGO_MS);
  const now = opts.now ?? Date.now();

  const split = chronologicalSplit(view, opts.trainFraction ?? 0.7);
  const trainView = asOfView(split.train.rows, split.train.asOf);
  const embargoCutoff = split.train.rows.length ? split.train.asOf + embargoMs : view.asOf;
  // The embargo is half-open: an outcome exactly at the boundary is eligible.\n  const validationRows = split.validation.rows.filter((row) => row.closedAt >= embargoCutoff);
  const validation = asOfView(validationRows, split.validation.asOf);
  const embargoedTrades = split.validation.rows.length - validation.rows.length;

  const report = buildKnowledge(trainView);
  const state = buildInfluenceState(report, { maxDelta, enabled: true, now });
  const baseline = metricsOf(validation.rows);
  const range = (rows: readonly TradeObservation[]) => ({
    from: iso(rows[0]?.closedAt),
    to: iso(rows.at(-1)?.closedAt),
  });
  const trainRange = range(trainView.rows);
  const validationRange = range(validation.rows);

  const empty: ValidationResult = {
    verdict: "insufficient_data",
    summary: "",
    trainTrades: trainView.rows.length,
    validationTrades: validation.rows.length,
    embargoedTrades,
    embargoMs,
    dataCutoff: new Date(view.asOf).toISOString(),
    trainFrom: trainRange.from,
    trainTo: trainRange.to,
    validationFrom: validationRange.from,
    validationTo: validationRange.to,
    correction: "benjamini-hochberg",
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
      summary: `Not enough embargoed out-of-sample trades to judge: ${validation.rows.length} available, ${minValidation} needed.`,
    };
  }

  if (state.rules.length === 0) {
    return {
      ...empty,
      verdict: "no_better",
      summary: "No training cell cleared the sample gate and multiple-comparison correction, so the fitted state would change nothing.",
    };
  }

  const allowed: TradeObservation[] = [];
  const withheldTrades: TradeObservation[] = [];
  for (const trade of validation.rows) {
    if (!trade.strategyId || trade.confidence == null) {
      allowed.push(trade);
      continue;
    }
    const outcome = evaluateInfluence(state, {
      strategyId: trade.strategyId,
      symbol: trade.symbol,
      regime: trade.regime,
      entryTime: trade.entryTime,
      atrPercent: trade.atrPercent,
      confidence: trade.confidence,
      strategyThreshold: opts.strategyThresholds?.get(trade.strategyId) ?? defaultThreshold,
    });
    if (outcome.admitted) allowed.push(trade);
    else withheldTrades.push(trade);
  }

  const withMemory = metricsOf(allowed);
  const withheldPnlUsdt = round2(withheldTrades.reduce((sum, trade) => sum + trade.pnl, 0));
  const expectancyDelta = round2(withMemory.expectancyUsdt - baseline.expectancyUsdt);
  const result: ValidationResult = {
    ...empty,
    baseline,
    withMemory,
    withheld: withheldTrades.length,
    withheldPnlUsdt,
    expectancyDelta,
  };

  const survivingFraction = validation.rows.length ? allowed.length / validation.rows.length : 0;
  if (survivingFraction < MIN_SURVIVING_FRACTION) {
    return {
      ...result,
      verdict: "no_better",
      summary: `The state would withhold ${withheldTrades.length} of ${validation.rows.length} out-of-sample trades; that is a shutdown, not a bounded filter.`,
    };
  }

  if (expectancyDelta <= 0) {
    return {
      ...result,
      verdict: "no_better",
      summary: `On ${validation.rows.length} embargoed out-of-sample trades, expectancy changed by $${expectancyDelta.toFixed(2)} per trade. That is not an improvement.`,
    };
  }

  return {
    ...result,
    verdict: "improved",
    summary: `On ${validation.rows.length} embargoed out-of-sample trades, the frozen state withheld ${withheldTrades.length} trades worth $${withheldPnlUsdt.toFixed(2)} and moved expectancy from $${baseline.expectancyUsdt.toFixed(2)} to $${withMemory.expectancyUsdt.toFixed(2)} per trade. It remains Shadow until explicitly approved.`,
  };
}
