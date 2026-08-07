import type { Candle, MultiTimeframeCandles } from "../src/lib/strategy";
import {
  buildMarketState,
  buildMarketStateResult,
} from "../src/lib/intelligence/market-state/builder";

let failures = 0;
function expect(name: string, condition: boolean): void {
  if (condition) console.log("✓  " + name);
  else { failures++; console.error("✗  " + name); }
}

const observedAt = new Date("2025-01-10T12:00:00.000Z");

function frame(intervalMs: number, closedCount: number, slope = 0.05): Candle[] {
  const start = observedAt.getTime() - closedCount * intervalMs;
  const candles: Candle[] = [];
  for (let index = 0; index <= closedCount; index++) {
    const timestamp = start + index * intervalMs;
    const open = 100 + index * slope;
    const close = open + slope * 0.6;
    candles.push([timestamp, open, Math.max(open, close) + 0.2, Math.min(open, close) - 0.2, close, 1000 + index * 5]);
  }
  return candles;
}

function fixture(): MultiTimeframeCandles {
  return {
    tf1m: frame(60_000, 120),
    tf3m: frame(3 * 60_000, 70),
    tf5m: frame(5 * 60_000, 70),
    tf15m: frame(15 * 60_000, 70),
    tf1h: frame(60 * 60_000, 70),
  };
}

const input = {
  symbol: "BTCUSDT",
  venue: "futures" as const,
  provider: "fixture" as const,
  candles: fixture(),
  observedAt,
  maximumAgeMs: 3 * 60_000,
  context: {
    breadth: { bullishFraction: 0.6, sampleSize: 20 },
    leadership: { leader: "BTCUSDT", score: 0.7 },
    correlation: { referenceSymbol: "ETHUSDT", coefficient: 0.8, sampleSize: 60 },
  },
};

const first = buildMarketState(input);
const second = buildMarketState(input);
expect("identical closed inputs produce an identical fingerprint", first.fingerprint === second.fingerprint);
expect("the open candle is excluded on every timeframe", first.observations.timeframes.every((frame) => frame.excludedOpenCandles === 1));
expect("market time is the newest closed candle close", first.dataTimestamp === observedAt.toISOString());
expect("observations and inferences are separate", first.observations.lastPrice > 0 && first.inferences.regime.length > 0);
expect("optional cross-market context is explicitly observed", first.context.breadth.status === "observed");
expect("MarketState is deeply immutable", Object.isFrozen(first) && Object.isFrozen(first.observations) && Object.isFrozen(first.observations.timeframes));

const withoutContext = buildMarketState({ ...input, context: undefined });
expect("missing breadth is unavailable rather than fabricated", withoutContext.context.breadth.status === "unavailable" && withoutContext.context.breadth.bullishFraction === null);

const changedClock = buildMarketState({ ...input, observedAt: new Date(observedAt.getTime() + 30_000) });
expect("wall-clock freshness does not alter the market fingerprint", changedClock.fingerprint === first.fingerprint);

const stale = buildMarketStateResult({ ...input, observedAt: new Date(observedAt.getTime() + 10 * 60_000) });
expect("stale required data blocks state generation", stale.status === "blocked" && stale.issues.some((issue) => issue.code === "STALE_TIMEFRAME"));

const malformed = fixture();
malformed.tf1m[10]![4] = Number.NaN;
const invalid = buildMarketStateResult({ ...input, candles: malformed });
expect("non-finite candles block state generation", invalid.status === "blocked" && invalid.issues.some((issue) => issue.code === "NON_FINITE_CANDLE"));

const unsorted = fixture();
[unsorted.tf5m[5], unsorted.tf5m[6]] = [unsorted.tf5m[6]!, unsorted.tf5m[5]!];
const invalidOrder = buildMarketStateResult({ ...input, candles: unsorted });
expect("unsorted candles block state generation", invalidOrder.status === "blocked" && invalidOrder.issues.some((issue) => issue.code === "UNSORTED_OR_DUPLICATE_CANDLE"));

const tooShort = fixture();
tooShort.tf1h = tooShort.tf1h.slice(-10);
const insufficient = buildMarketStateResult({ ...input, candles: tooShort });
expect("insufficient history blocks state generation", insufficient.status === "blocked" && insufficient.issues.some((issue) => issue.code === "INSUFFICIENT_CLOSED_HISTORY"));

console.log(failures === 0 ? "\nAll MarketState checks passed." : "\n" + failures + " FAILED");
process.exit(failures === 0 ? 0 : 1);
