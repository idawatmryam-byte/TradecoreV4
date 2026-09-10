/** Synthetic boundary tests: causal inputs, not profitability evidence. */
import { strict as assert } from "node:assert";
import {
  closedCandleWindow,
  closedSignalCandles,
} from "../src/lib/candleWindows";
import {
  buildSignalRow,
  type Candle,
  type MultiTimeframeCandles,
} from "../src/lib/strategy";

const hour = 3_600_000;
const base = Date.parse("2026-01-01T10:00:00Z");
function series(interval: number): Candle[] {
  return Array.from({ length: 110 }, (_, i): Candle => {
    const close = 100 + i * 0.1;
    return [
      base + (i - 100) * interval,
      close,
      close + 0.1,
      close - 0.1,
      close,
      100,
    ];
  });
}

for (const interval of [60_000, 180_000, 300_000, 900_000, hour]) {
  const candles = series(interval);
  assert.equal(
    closedCandleWindow(candles, base + interval - 1, interval).at(-1)![0],
    base - interval,
  );
  assert.equal(
    closedCandleWindow(candles, base + interval, interval).at(-1)![0],
    base,
  );
  assert.equal(
    closedCandleWindow(candles, base + interval, interval).length,
    100,
  );
  const copy = closedCandleWindow(candles, base, interval);
  copy[0]![4] = -1;
  assert.ok(
    candles.every((candle) => candle[4] > 0),
    "window cannot mutate source data",
  );
}

const raw: MultiTimeframeCandles = {
  tf1m: series(60_000),
  tf3m: series(180_000),
  tf5m: series(300_000),
  tf15m: series(900_000),
  tf1h: series(hour),
};
const cutoff = base + 6 * 60_000; // 10:05 primary candle becomes known at 10:06.
const prior = closedSignalCandles(raw, cutoff);
const priorSignal = buildSignalRow("FIXTURE", prior);
const intervals = {
  tf1m: 60_000,
  tf3m: 180_000,
  tf5m: 300_000,
  tf15m: 900_000,
  tf1h: hour,
} as const;
for (const key of Object.keys(intervals) as Array<
  keyof MultiTimeframeCandles
>) {
  for (const candle of raw[key]) {
    if (candle[0] + intervals[key] > cutoff) {
      candle[1] = 999;
      candle[2] = 1000;
      candle[3] = 998;
      candle[4] = 999;
      candle[5] = 100_000;
    }
  }
}
assert.deepEqual(
  closedSignalCandles(raw, cutoff),
  prior,
  "changing unfinished/future OHLCV cannot change decision inputs",
);
assert.deepEqual(
  buildSignalRow("FIXTURE", closedSignalCandles(raw, cutoff)),
  priorSignal,
  "future prices cannot change the signal",
);
assert.equal(
  prior.tf1h.at(-1)![0],
  base - hour,
  "10:05 decision must not read the 10:00-10:59 hourly bar",
);
assert.equal(
  raw.tf1h.at(-1)![4],
  999,
  "raw live data remains available separately for exit monitoring",
);
assert.deepEqual(closedCandleWindow([], cutoff, hour), []);
assert.deepEqual(
  closedCandleWindow([[base, 100, 100, 100, 100, 1]], base, hour),
  [],
);
assert.equal(closedCandleWindow(series(hour), base, hour, 3).length, 3);
for (const [at, interval, limit] of [
  [NaN, hour, 100],
  [base, 0, 100],
  [base, hour, 0],
  [base, hour, 1.5],
]) {
  assert.throws(
    () => closedCandleWindow([], at!, interval!, limit!),
    RangeError,
  );
}
console.log(
  "backtest-causality: timeframe boundaries, future-tail invariance, signal invariance, isolation, and invalid inputs passed",
);
