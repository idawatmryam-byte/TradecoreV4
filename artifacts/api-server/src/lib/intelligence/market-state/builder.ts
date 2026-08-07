import {
  buildSignalRow,
  calcAtr,
  calcEma,
  type Candle,
  type MarketRegime,
  type MultiTimeframeCandles,
} from "../../strategy";
import { sha256Fingerprint } from "../canonical";
import { INTELLIGENCE_SCHEMA_VERSION } from "../contracts";
import {
  MARKET_STATE_VERSION,
  parseMarketState,
  type MarketState,
  type MarketStateBuildIssue,
  type MarketStateResult,
} from "./types";

const FRAME_SPECS = [
  { key: "tf1m", timeframe: "1m", intervalMs: 60_000, minimum: 30 },
  { key: "tf3m", timeframe: "3m", intervalMs: 3 * 60_000, minimum: 35 },
  { key: "tf5m", timeframe: "5m", intervalMs: 5 * 60_000, minimum: 30 },
  { key: "tf15m", timeframe: "15m", intervalMs: 15 * 60_000, minimum: 22 },
  { key: "tf1h", timeframe: "1h", intervalMs: 60 * 60_000, minimum: 51 },
] as const;

type FrameKey = typeof FRAME_SPECS[number]["key"];

export interface MarketStateContextInput {
  breadth?: { bullishFraction: number; sampleSize: number };
  leadership?: { leader: string; score: number };
  correlation?: { referenceSymbol: string; coefficient: number; sampleSize: number };
}

export interface BuildMarketStateInput {
  symbol: string;
  venue: "spot" | "futures" | "forex";
  provider: "binance" | "oanda" | "fixture";
  candles: MultiTimeframeCandles;
  observedAt: Date;
  maximumAgeMs?: number;
  previousRegime?: MarketRegime;
  context?: MarketStateContextInput;
}

export class MarketStateBuildError extends Error {
  constructor(readonly issues: readonly MarketStateBuildIssue[]) {
    super("MarketState refused: " + issues.map((issue) => issue.code).join(", "));
    this.name = "MarketStateBuildError";
  }
}

function validateAndClose(
  candles: readonly Candle[],
  timeframe: string,
  intervalMs: number,
  minimum: number,
  observedAtMs: number,
  maximumAgeMs: number,
): { closed: Candle[]; lastClosedAt: number; excludedOpenCandles: number } {
  const issues: MarketStateBuildIssue[] = [];
  let previousTimestamp = -Infinity;

  for (const [index, candle] of candles.entries()) {
    if (candle.length !== 6 || candle.some((value) => !Number.isFinite(value))) {
      issues.push({ code: "NON_FINITE_CANDLE", detail: "Candle " + index + " is incomplete or non-finite", timeframe });
      continue;
    }
    const [timestamp, open, high, low, close, volume] = candle;
    if (timestamp <= previousTimestamp) issues.push({ code: "UNSORTED_OR_DUPLICATE_CANDLE", detail: "Candle timestamps must be strictly increasing", timeframe });
    previousTimestamp = timestamp;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0 || high < Math.max(open, close) || low > Math.min(open, close) || low > high) {
      issues.push({ code: "INVALID_OHLCV", detail: "Candle " + index + " violates OHLCV invariants", timeframe });
    }
  }

  const closed = candles.filter((candle) => candle[0] + intervalMs <= observedAtMs).map((candle) => [...candle] as Candle);
  const excludedOpenCandles = candles.length - closed.length;
  if (closed.length < minimum) {
    issues.push({ code: "INSUFFICIENT_CLOSED_HISTORY", detail: "Need at least " + minimum + " closed candles; received " + closed.length, timeframe });
  }
  const last = closed[closed.length - 1];
  const lastClosedAt = last ? last[0] + intervalMs : 0;
  if (lastClosedAt > 0 && observedAtMs - lastClosedAt > maximumAgeMs + intervalMs) {
    issues.push({ code: "STALE_TIMEFRAME", detail: "Newest closed candle exceeds the freshness limit", timeframe });
  }
  if (issues.length) throw new MarketStateBuildError(issues);
  return { closed, lastClosedAt, excludedOpenCandles };
}

function trend(candles: readonly Candle[]): "bullish" | "bearish" | "neutral" {
  const closes = candles.map((candle) => candle[4]);
  const fast = calcEma(closes, 20);
  const slow = calcEma(closes, 50);
  if (!(slow > 0)) return "neutral";
  const difference = (fast - slow) / slow;
  if (difference > 0.0005) return "bullish";
  if (difference < -0.0005) return "bearish";
  return "neutral";
}

function structure(candles: readonly Candle[], price: number) {
  const recent = candles.slice(-50);
  const supports: number[] = [];
  const resistances: number[] = [];
  for (let index = 1; index < recent.length - 1; index++) {
    const previous = recent[index - 1]!;
    const current = recent[index]!;
    const next = recent[index + 1]!;
    if (current[3] < previous[3] && current[3] < next[3]) supports.push(current[3]);
    if (current[2] > previous[2] && current[2] > next[2]) resistances.push(current[2]);
  }
  const unique = (values: number[]) => [...new Set(values.map((value) => Math.round(value * 1e8) / 1e8))];
  const below = unique(supports).filter((value) => value < price).sort((a, b) => b - a).slice(0, 5);
  const above = unique(resistances).filter((value) => value > price).sort((a, b) => a - b).slice(0, 5);
  return {
    supports: below,
    resistances: above,
    nearestSupport: below[0] ?? null,
    nearestResistance: above[0] ?? null,
  };
}

function session(at: Date): "asia" | "europe" | "us" | "europe_us_overlap" | "off_hours" {
  const hour = at.getUTCHours();
  if (hour >= 13 && hour < 16) return "europe_us_overlap";
  if (hour >= 7 && hour < 16) return "europe";
  if (hour >= 13 && hour < 22) return "us";
  if (hour >= 0 && hour < 9) return "asia";
  return "off_hours";
}

function regimeConfidence(regime: MarketRegime, adx: number, volatilityRatio: number): number {
  const raw = regime === "high_volatility" ? Math.abs(volatilityRatio - 1.35) / 0.65
    : regime === "low_volatility" ? Math.abs(0.7 - volatilityRatio) / 0.7
    : regime === "strong_trend" ? (adx - 25) / 25
    : regime === "weak_trend" ? 1 - Math.abs(adx - 22.5) / 12.5
    : (20 - Math.min(20, adx)) / 20;
  return Math.round(Math.max(0.05, Math.min(0.99, raw)) * 1000) / 1000;
}

function optionalContext(input?: MarketStateContextInput) {
  const breadth = input?.breadth;
  const leadership = input?.leadership;
  const correlation = input?.correlation;
  return {
    breadth: breadth && Number.isFinite(breadth.bullishFraction) && breadth.bullishFraction >= 0 && breadth.bullishFraction <= 1 && Number.isInteger(breadth.sampleSize) && breadth.sampleSize > 0
      ? { status: "observed" as const, bullishFraction: breadth.bullishFraction, sampleSize: breadth.sampleSize }
      : { status: "unavailable" as const, bullishFraction: null, sampleSize: 0 },
    leadership: leadership && leadership.leader.trim() && Number.isFinite(leadership.score) && Math.abs(leadership.score) <= 1
      ? { status: "observed" as const, leader: leadership.leader, score: leadership.score }
      : { status: "unavailable" as const, leader: null, score: null },
    correlation: correlation && correlation.referenceSymbol.trim() && Number.isFinite(correlation.coefficient) && Math.abs(correlation.coefficient) <= 1 && Number.isInteger(correlation.sampleSize) && correlation.sampleSize > 1
      ? { status: "observed" as const, referenceSymbol: correlation.referenceSymbol, coefficient: correlation.coefficient, sampleSize: correlation.sampleSize }
      : { status: "unavailable" as const, referenceSymbol: null, coefficient: null, sampleSize: 0 },
  };
}

function deterministicStateCore(state: Omit<MarketState, "fingerprint" | "observedAt" | "freshness">) {
  return state;
}

export function buildMarketState(input: BuildMarketStateInput): MarketState {
  if (!input.symbol.trim()) throw new MarketStateBuildError([{ code: "SYMBOL_REQUIRED", detail: "symbol is required" }]);
  const observedAtMs = input.observedAt.getTime();
  if (!Number.isFinite(observedAtMs)) throw new MarketStateBuildError([{ code: "INVALID_OBSERVED_AT", detail: "observedAt must be a valid date" }]);
  const maximumAgeMs = input.maximumAgeMs ?? 3 * 60_000;
  if (!Number.isFinite(maximumAgeMs) || maximumAgeMs <= 0) throw new MarketStateBuildError([{ code: "INVALID_FRESHNESS_LIMIT", detail: "maximumAgeMs must be positive" }]);

  const closed = {} as Record<FrameKey, Candle[]>;
  const timeframeObservations: Array<{
    timeframe: "1m" | "3m" | "5m" | "15m" | "1h";
    intervalMs: number;
    candleCount: number;
    lastClosedAt: string;
    lastClose: number;
    excludedOpenCandles: number;
  }> = [];
  const issues: MarketStateBuildIssue[] = [];

  for (const spec of FRAME_SPECS) {
    try {
      const result = validateAndClose(input.candles[spec.key], spec.timeframe, spec.intervalMs, spec.minimum, observedAtMs, maximumAgeMs);
      closed[spec.key] = result.closed;
      timeframeObservations.push({
        timeframe: spec.timeframe,
        intervalMs: spec.intervalMs,
        candleCount: result.closed.length,
        lastClosedAt: new Date(result.lastClosedAt).toISOString(),
        lastClose: result.closed[result.closed.length - 1]![4],
        excludedOpenCandles: result.excludedOpenCandles,
      });
    } catch (error) {
      if (error instanceof MarketStateBuildError) issues.push(...error.issues);
      else issues.push({ code: "FRAME_VALIDATION_FAILED", detail: error instanceof Error ? error.message : String(error), timeframe: spec.timeframe });
    }
  }
  if (issues.length) throw new MarketStateBuildError(issues);

  const mtf = closed as unknown as MultiTimeframeCandles;
  const row = buildSignalRow(input.symbol, mtf, input.previousRegime);
  const price = row.lastPrice;
  const trends = {
    tf3m: trend(mtf.tf3m),
    tf5m: trend(mtf.tf5m),
    tf15m: trend(mtf.tf15m),
    tf1h: trend(mtf.tf1h),
  };
  const directions = Object.values(trends);
  const bullish = directions.filter((value) => value === "bullish").length;
  const bearish = directions.filter((value) => value === "bearish").length;
  const dominantDirection = bullish > bearish ? "bullish" : bearish > bullish ? "bearish" : "neutral";
  const atr = calcAtr(mtf.tf1m, 14);
  const baselineAtr = calcAtr(mtf.tf1m, Math.min(100, mtf.tf1m.length - 1));
  const atrPercent = price > 0 ? atr / price * 100 : 0;
  const baselineAtrPercent = price > 0 ? baselineAtr / price * 100 : 0;
  const volatilityRatio = baselineAtrPercent > 0 ? atrPercent / baselineAtrPercent : 1;
  const latest = mtf.tf1m[mtf.tf1m.length - 1]!;
  const previous = mtf.tf1m[mtf.tf1m.length - 2]!;
  const gapPercent = previous[4] > 0 ? Math.abs(latest[1] - previous[4]) / previous[4] * 100 : 0;
  const anomalyReasons = [
    ...(gapPercent > Math.max(atrPercent * 2, 0.25) ? ["PRICE_GAP"] : []),
    ...(row.volumeRatio >= 4 ? ["VOLUME_SPIKE"] : []),
  ];
  const dataTimestampMs = latest[0] + 60_000;
  const ageMs = Math.max(0, observedAtMs - dataTimestampMs);

  const withoutFingerprint = {
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    marketStateVersion: MARKET_STATE_VERSION,
    symbol: input.symbol,
    venue: input.venue,
    provider: input.provider,
    dataTimestamp: new Date(dataTimestampMs).toISOString(),
    dataQuality: { status: "healthy" as const, issues: [] as string[] },
    observations: {
      lastPrice: price,
      timeframes: timeframeObservations,
      trend: { ...trends, alignedTimeframes: Math.max(bullish, bearish) },
      volatility: {
        atr,
        atrPercent,
        baselineAtrPercent,
        ratioToBaseline: volatilityRatio,
        phase: volatilityRatio >= 1.35 ? "expansion" as const : volatilityRatio <= 0.7 ? "compression" as const : "normal" as const,
      },
      momentum: {
        rsi5m: row.rsi,
        macdHistogram3m: row.macdHistogram,
        longStructureScore: row.confidence,
        shortStructureScore: row.shortConfidence,
      },
      liquidity: {
        volumeRatio: row.volumeRatio,
        proxyStatus: row.volumeRatio < 0.6 ? "thin" as const : row.volumeRatio >= 1.5 ? "elevated" as const : "normal" as const,
        disclaimer: "Volume is a liquidity proxy, not order-book depth." as const,
      },
      structure: structure(mtf.tf15m, price),
    },
    inferences: {
      regime: row.regime,
      regimeConfidence: regimeConfidence(row.regime, row.adx, volatilityRatio),
      dominantDirection,
      session: session(new Date(dataTimestampMs)),
      anomaly: { detected: anomalyReasons.length > 0, reasonCodes: anomalyReasons },
    },
    context: optionalContext(input.context),
  };
  const fingerprint = sha256Fingerprint(deterministicStateCore(withoutFingerprint as Omit<MarketState, "fingerprint" | "observedAt" | "freshness">));
  return parseMarketState({
    ...withoutFingerprint,
    fingerprint,
    observedAt: input.observedAt.toISOString(),
    freshness: {
      status: ageMs <= maximumAgeMs ? "fresh" : "stale",
      ageMs,
      maximumAgeMs,
    },
  });
}

export function buildMarketStateResult(input: BuildMarketStateInput): MarketStateResult {
  try {
    return { status: "available", state: buildMarketState(input) };
  } catch (error) {
    const issues = error instanceof MarketStateBuildError
      ? error.issues
      : [{ code: "MARKET_STATE_BUILD_FAILED", detail: error instanceof Error ? error.message : String(error) }];
    return {
      status: "blocked",
      symbol: input.symbol,
      observedAt: Number.isFinite(input.observedAt.getTime()) ? input.observedAt.toISOString() : "invalid",
      issues,
    };
  }
}
