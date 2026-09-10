import type { Candle, MultiTimeframeCandles } from "./strategy";

/** Keep the execution strategy on the same closed-candle clock as research. */
export function closedSignalCandles(
  candles: MultiTimeframeCandles,
  availableAtMs: number,
): MultiTimeframeCandles {
  return {
    tf1m: closedCandleWindow(candles.tf1m, availableAtMs, 60_000),
    tf3m: closedCandleWindow(candles.tf3m, availableAtMs, 3 * 60_000),
    tf5m: closedCandleWindow(candles.tf5m, availableAtMs, 5 * 60_000),
    tf15m: closedCandleWindow(candles.tf15m, availableAtMs, 15 * 60_000),
    tf1h: closedCandleWindow(candles.tf1h, availableAtMs, 60 * 60_000),
  };
}

/**
 * Read a point-in-time window from an ascending candle series. Providers and
 * precomputed aggregates timestamp candles at OPEN; their OHLCV is available
 * only after the interval closes. Never use processing latency as the cutoff.
 */
export function closedCandleWindow(
  candles: readonly Candle[],
  availableAtMs: number,
  intervalMs: number,
  limit = 100,
): Candle[] {
  if (
    !Number.isFinite(availableAtMs) ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isSafeInteger(limit) ||
    limit <= 0
  ) {
    throw new RangeError(
      "Candle window requires a finite cutoff, positive interval and positive integer limit",
    );
  }
  let low = 0;
  let high = candles.length - 1;
  let last = -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    if (candles[middle]![0] + intervalMs <= availableAtMs) {
      last = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candles
    .slice(Math.max(0, last - limit + 1), last + 1)
    .map((candle) => [...candle] as Candle);
}
