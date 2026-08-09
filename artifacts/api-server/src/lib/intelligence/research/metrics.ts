import { ResearchMetricsSchema, type ResearchMetrics } from "./types";

export interface ResearchTradeOutcome {
  tradeId: string;
  closedAt: string;
  regime: string;
  grossPnl: number;
  fees: number;
  slippage: number;
  spread: number;
  financing: number;
  plannedRisk: number | null;
}

export interface BuildResearchMetricsInput {
  outcomes: readonly ResearchTradeOutcome[];
  eligibleDecisions: number;
  abstentions: number;
  startInclusive: string;
  endExclusive: string;
  startingEquity: number;
  deterministicSeed: number;
  bootstrapSamples?: number;
  confidenceLevel?: number;
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function quantile(
  sorted: readonly number[],
  probability: number,
): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(probability * sorted.length)),
  );
  return sorted[index]!;
}

function bootstrapMeanInterval(
  values: readonly number[],
  samples: number,
  confidenceLevel: number,
  seed: number,
): { lower: number | null; upper: number | null } {
  if (values.length === 0 || samples === 0) return { lower: null, upper: null };
  const random = xorshift32(seed);
  const means = new Array<number>(samples);
  for (let sample = 0; sample < samples; sample++) {
    let sum = 0;
    for (let index = 0; index < values.length; index++) {
      sum += values[Math.floor(random() * values.length)]!;
    }
    means[sample] = sum / values.length;
  }
  means.sort((a, b) => a - b);
  const tail = (1 - confidenceLevel) / 2;
  return { lower: quantile(means, tail), upper: quantile(means, 1 - tail) };
}

export function buildResearchMetrics(
  input: BuildResearchMetricsInput,
): ResearchMetrics {
  const start = Date.parse(input.startInclusive);
  const end = Date.parse(input.endExclusive);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("Research metric period is invalid");
  }
  if (!Number.isFinite(input.startingEquity) || input.startingEquity <= 0) {
    throw new Error("Research starting equity must be positive");
  }
  if (
    !Number.isInteger(input.eligibleDecisions) ||
    input.eligibleDecisions < 0
  ) {
    throw new Error("Eligible decision count must be a non-negative integer");
  }
  if (
    !Number.isInteger(input.abstentions) ||
    input.abstentions < 0 ||
    input.abstentions > input.eligibleDecisions
  ) {
    throw new Error("Abstention count is invalid");
  }

  const outcomes = [...input.outcomes].sort(
    (a, b) =>
      Date.parse(a.closedAt) - Date.parse(b.closedAt) ||
      a.tradeId.localeCompare(b.tradeId),
  );
  const ids = new Set<string>();
  for (const outcome of outcomes) {
    if (!outcome.tradeId.trim() || ids.has(outcome.tradeId))
      throw new Error("Research trade identifiers must be unique");
    ids.add(outcome.tradeId);
    const closed = Date.parse(outcome.closedAt);
    const values = [
      outcome.grossPnl,
      outcome.fees,
      outcome.slippage,
      outcome.spread,
      outcome.financing,
    ];
    if (
      !Number.isFinite(closed) ||
      closed < start ||
      closed >= end ||
      values.some((value) => !Number.isFinite(value))
    ) {
      throw new Error(
        `Research trade ${outcome.tradeId} is outside the period or non-finite`,
      );
    }
    if (
      outcome.fees < 0 ||
      outcome.slippage < 0 ||
      outcome.spread < 0 ||
      outcome.financing < 0
    ) {
      throw new Error(
        `Research trade ${outcome.tradeId} has a negative modeled cost`,
      );
    }
    if (
      outcome.plannedRisk !== null &&
      (!Number.isFinite(outcome.plannedRisk) || outcome.plannedRisk <= 0)
    ) {
      throw new Error(
        `Research trade ${outcome.tradeId} has invalid planned risk`,
      );
    }
  }

  const netValues = outcomes.map(
    (outcome) =>
      outcome.grossPnl -
      outcome.fees -
      outcome.slippage -
      outcome.spread -
      outcome.financing,
  );
  const rValues = outcomes.flatMap((outcome, index) =>
    outcome.plannedRisk === null
      ? []
      : [netValues[index]! / outcome.plannedRisk],
  );
  const grossPnl = outcomes.reduce((sum, outcome) => sum + outcome.grossPnl, 0);
  const costs = outcomes.reduce(
    (sum, outcome) =>
      sum +
      outcome.fees +
      outcome.slippage +
      outcome.spread +
      outcome.financing,
    0,
  );
  const netPnl = netValues.reduce((sum, value) => sum + value, 0);
  const wins = netValues
    .filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(
    netValues
      .filter((value) => value < 0)
      .reduce((sum, value) => sum + value, 0),
  );
  const profitFactor =
    losses > 0 ? wins / losses : outcomes.length > 0 && wins > 0 ? null : 0;

  let equity = input.startingEquity;
  let peak = equity;
  let maxDrawdown = 0;
  for (const net of netValues) {
    equity += net;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 1);
  }
  maxDrawdown = Math.min(1, Math.max(0, maxDrawdown));

  const orderedR = [...rValues].sort((a, b) => a - b);
  const tailCount =
    orderedR.length > 0 ? Math.max(1, Math.ceil(orderedR.length * 0.05)) : 0;
  const expectedShortfallR =
    tailCount > 0
      ? orderedR.slice(0, tailCount).reduce((sum, value) => sum + value, 0) /
        tailCount
      : null;
  const netExpectancyR =
    rValues.length > 0
      ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length
      : null;
  const bootstrapSamples = Math.max(
    0,
    Math.min(5_000, Math.floor(input.bootstrapSamples ?? 1_000)),
  );
  const confidenceLevel = input.confidenceLevel ?? 0.95;
  if (!(confidenceLevel > 0 && confidenceLevel < 1))
    throw new Error("Confidence level must be between zero and one");
  const interval = bootstrapMeanInterval(
    rValues,
    bootstrapSamples,
    confidenceLevel,
    input.deterministicSeed,
  );
  const regimeMix: Record<string, number> = {};
  for (const outcome of outcomes)
    regimeMix[outcome.regime] = (regimeMix[outcome.regime] ?? 0) + 1;

  return Object.freeze(
    ResearchMetricsSchema.parse({
      eligibleDecisions: input.eligibleDecisions,
      closedTrades: outcomes.length,
      calendarDays: (end - start) / (24 * 60 * 60 * 1000),
      grossPnl,
      costs,
      netPnl,
      netExpectancyR,
      profitFactor,
      maxDrawdown,
      expectedShortfallR,
      abstentionRate:
        input.eligibleDecisions > 0
          ? input.abstentions / input.eligibleDecisions
          : 0,
      regimeMix,
      uncertainty: {
        method: "bootstrap-percentile",
        confidenceLevel,
        lowerNetExpectancyR: interval.lower,
        upperNetExpectancyR: interval.upper,
        samples: rValues.length > 0 ? bootstrapSamples : 0,
      },
    }),
  );
}
