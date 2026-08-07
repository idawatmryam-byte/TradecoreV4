import { z } from "zod";
import { deepFreeze, type ReadonlyDeep } from "../canonical";
import { INTELLIGENCE_SCHEMA_VERSION } from "../contracts";

const finite = z.number().finite();
const isoTime = z.string().datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/i);

export const MARKET_STATE_VERSION = "market-state-v1" as const;
export const MarketRegimeSchema = z.enum(["strong_trend", "weak_trend", "range", "high_volatility", "low_volatility"]);
export const DirectionSchema = z.enum(["bullish", "bearish", "neutral"]);

export const TimeframeObservationSchema = z.object({
  timeframe: z.enum(["1m", "3m", "5m", "15m", "1h"]),
  intervalMs: finite.int().positive(),
  candleCount: finite.int().positive(),
  lastClosedAt: isoTime,
  lastClose: finite.positive(),
  excludedOpenCandles: finite.int().nonnegative(),
}).strict();

export const MarketStateSchema = z.object({
  schemaVersion: z.literal(INTELLIGENCE_SCHEMA_VERSION),
  marketStateVersion: z.literal(MARKET_STATE_VERSION),
  fingerprint: hash,
  symbol: z.string().min(1).max(80),
  venue: z.enum(["spot", "futures", "forex"]),
  provider: z.enum(["binance", "oanda", "fixture"]),
  dataTimestamp: isoTime,
  observedAt: isoTime,
  freshness: z.object({
    status: z.enum(["fresh", "stale"]),
    ageMs: finite.int().nonnegative(),
    maximumAgeMs: finite.int().positive(),
  }).strict(),
  dataQuality: z.object({
    status: z.enum(["healthy", "degraded"]),
    issues: z.array(z.string().min(1)).max(50),
  }).strict(),
  observations: z.object({
    lastPrice: finite.positive(),
    timeframes: z.array(TimeframeObservationSchema).length(5),
    trend: z.object({
      tf3m: DirectionSchema,
      tf5m: DirectionSchema,
      tf15m: DirectionSchema,
      tf1h: DirectionSchema,
      alignedTimeframes: finite.int().min(0).max(4),
    }).strict(),
    volatility: z.object({
      atr: finite.nonnegative(),
      atrPercent: finite.nonnegative(),
      baselineAtrPercent: finite.nonnegative(),
      ratioToBaseline: finite.nonnegative(),
      phase: z.enum(["compression", "normal", "expansion"]),
    }).strict(),
    momentum: z.object({
      rsi5m: finite.min(0).max(100),
      macdHistogram3m: finite,
      longStructureScore: finite.min(0).max(100),
      shortStructureScore: finite.min(0).max(100),
    }).strict(),
    liquidity: z.object({
      volumeRatio: finite.nonnegative(),
      proxyStatus: z.enum(["thin", "normal", "elevated"]),
      disclaimer: z.literal("Volume is a liquidity proxy, not order-book depth."),
    }).strict(),
    structure: z.object({
      supports: z.array(finite.positive()).max(10),
      resistances: z.array(finite.positive()).max(10),
      nearestSupport: finite.positive().nullable(),
      nearestResistance: finite.positive().nullable(),
    }).strict(),
  }).strict(),
  inferences: z.object({
    regime: MarketRegimeSchema,
    regimeConfidence: finite.min(0).max(1),
    dominantDirection: DirectionSchema,
    session: z.enum(["asia", "europe", "us", "europe_us_overlap", "off_hours"]),
    anomaly: z.object({
      detected: z.boolean(),
      reasonCodes: z.array(z.string().min(1)).max(20),
    }).strict(),
  }).strict(),
  context: z.object({
    breadth: z.object({
      status: z.enum(["observed", "unavailable"]),
      bullishFraction: finite.min(0).max(1).nullable(),
      sampleSize: finite.int().nonnegative(),
    }).strict(),
    leadership: z.object({
      status: z.enum(["observed", "unavailable"]),
      leader: z.string().min(1).nullable(),
      score: finite.min(-1).max(1).nullable(),
    }).strict(),
    correlation: z.object({
      status: z.enum(["observed", "unavailable"]),
      referenceSymbol: z.string().min(1).nullable(),
      coefficient: finite.min(-1).max(1).nullable(),
      sampleSize: finite.int().nonnegative(),
    }).strict(),
  }).strict(),
}).strict();

export type MarketState = ReadonlyDeep<z.infer<typeof MarketStateSchema>>;

export interface MarketStateBuildIssue {
  readonly code: string;
  readonly detail: string;
  readonly timeframe?: string;
}

export type MarketStateResult =
  | { readonly status: "available"; readonly state: MarketState }
  | {
      readonly status: "blocked";
      readonly symbol: string;
      readonly observedAt: string;
      readonly issues: readonly MarketStateBuildIssue[];
    };

export function parseMarketState(input: unknown): MarketState {
  return deepFreeze(MarketStateSchema.parse(input));
}
