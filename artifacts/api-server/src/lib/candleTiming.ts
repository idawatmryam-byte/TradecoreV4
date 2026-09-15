import type { Candle, MultiTimeframeCandles } from "./strategy";

export const CANDLE_INTERVALS = {
  tf1m: 60_000,
  tf3m: 180_000,
  tf5m: 300_000,
  tf15m: 900_000,
  tf1h: 3_600_000,
} as const;

/** Provider timestamps identify the OPEN of the bar, not its availability. */
export function closedCandles(
  candles: readonly Candle[],
  intervalMs: number,
  observedAtMs: number,
): Candle[] {
  return candles.filter((candle) => candle[0] + intervalMs <= observedAtMs);
}

export function closedTimeframes(
  candles: MultiTimeframeCandles,
  observedAtMs: number,
): MultiTimeframeCandles {
  return Object.fromEntries(
    Object.entries(CANDLE_INTERVALS).map(([key, intervalMs]) => [
      key,
      closedCandles(
        candles[key as keyof MultiTimeframeCandles],
        intervalMs,
        observedAtMs,
      ).slice(-100),
    ]),
  ) as unknown as MultiTimeframeCandles;
}

/** Only complete, contiguous source bars may form a higher-timeframe bar. */
export function aggregateCandles(
  candles: readonly Candle[],
  targetMs: number,
  sourceMs = 60_000,
): Candle[] {
  if (
    !Number.isSafeInteger(sourceMs) ||
    sourceMs <= 0 ||
    !Number.isSafeInteger(targetMs) ||
    targetMs < sourceMs ||
    targetMs % sourceMs !== 0
  ) {
    throw new Error(
      "Candle aggregation requires an integer multiple of the source interval",
    );
  }
  const result: Candle[] = [];
  let aggregate: Candle | undefined;
  let count = 0;
  let previousTimestamp = -Infinity;
  for (const candle of candles) {
    const timestamp = candle[0];
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp % sourceMs !== 0 ||
      timestamp <= previousTimestamp
    ) {
      throw new Error(
        "Candle timestamps must be aligned and strictly increasing",
      );
    }
    previousTimestamp = timestamp;
    const slot = Math.floor(timestamp / targetMs) * targetMs;
    if (timestamp === slot) {
      aggregate = [...candle];
      count = 1;
    } else if (
      aggregate &&
      aggregate[0] === slot &&
      timestamp === slot + count * sourceMs
    ) {
      aggregate[2] = Math.max(aggregate[2], candle[2]);
      aggregate[3] = Math.min(aggregate[3], candle[3]);
      aggregate[4] = candle[4];
      aggregate[5] += candle[5];
      count++;
    } else {
      aggregate = undefined;
      count = 0;
    }
    if (aggregate && count === targetMs / sourceMs) {
      result.push(aggregate);
      aggregate = undefined;
      count = 0;
    }
  }
  return result;
}

/** Binary search on CLOSE time; future bars cannot affect an earlier decision. */
export function getClosedWindow(
  candles: readonly Candle[],
  intervalMs: number,
  observedAtMs: number,
  windowSize = 100,
): Candle[] | null {
  let lo = 0;
  let hi = candles.length - 1;
  let end = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid]![0] + intervalMs <= observedAtMs) {
      end = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return end < windowSize - 1
    ? null
    : candles.slice(end - windowSize + 1, end + 1);
}
