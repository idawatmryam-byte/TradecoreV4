import assert from "node:assert/strict";
import {
  aggregateCandles,
  closedTimeframes,
  getClosedWindow,
} from "../src/lib/candleTiming";
import {
  buildSignalRow,
  type Candle,
  type MultiTimeframeCandles,
} from "../src/lib/strategy";

const minute = 60_000;
const hour = 60 * minute;
const start = Date.UTC(2026, 0, 1);
const source: Candle[] = Array.from({ length: 120 * 60 }, (_, index) => {
  const price = 100 + index * 0.01;
  return [start + index * minute, price, price + 1, price - 1, price + 0.1, 10];
});
const hourly = aggregateCandles(source, hour);
const observedAt = start + 110 * hour + 15 * minute;
const past = getClosedWindow(hourly, hour, observedAt)!;
assert.equal(past.length, 100);
assert.equal(past.at(-1)![0], start + 109 * hour);
assert.equal(getClosedWindow(hourly, hour, start + 100 * hour - 1), null);
assert.equal(getClosedWindow(hourly, hour, start + 100 * hour)!.length, 100);

// A large move later in the current hour must not change an earlier input.
const changed = source.map(
  (candle): Candle =>
    candle[0] >= observedAt
      ? [candle[0], 500, 600, 400, 550, 100_000]
      : [...candle],
);
assert.deepEqual(
  getClosedWindow(aggregateCandles(changed, hour), hour, observedAt),
  past,
);

const withGap = source.filter((_, index) => index !== 20);
assert.equal(aggregateCandles(withGap, hour).length, 119);
assert.equal(aggregateCandles(source.slice(1, 119), hour).length, 0);
assert.throws(() => aggregateCandles(source, 300_000, 180_000));
assert.throws(() => aggregateCandles([source[1]!, source[0]!], hour));
assert.throws(() => aggregateCandles([source[0]!, source[0]!], hour));
assert.deepEqual(aggregateCandles(source.slice(0, 3), 3 * minute), [
  [start, 100, 101.02, 99, 100.11999999999999, 30],
]);

const raw: MultiTimeframeCandles = {
  tf1m: source,
  tf3m: aggregateCandles(source, 3 * minute),
  tf5m: aggregateCandles(source, 5 * minute),
  tf15m: aggregateCandles(source, 15 * minute),
  tf1h: hourly,
};
const closed = closedTimeframes(raw, observedAt);
assert.ok(Object.values(closed).every((frame) => frame.length === 100));
assert.equal(closed.tf1m.at(-1)![0] + minute, observedAt);
const replay: MultiTimeframeCandles = {
  tf1m: getClosedWindow(raw.tf1m, minute, observedAt)!,
  tf3m: getClosedWindow(raw.tf3m, 3 * minute, observedAt)!,
  tf5m: getClosedWindow(raw.tf5m, 5 * minute, observedAt)!,
  tf15m: getClosedWindow(raw.tf15m, 15 * minute, observedAt)!,
  tf1h: getClosedWindow(raw.tf1h, hour, observedAt)!,
};
assert.deepEqual(
  buildSignalRow("BTCUSDT", closed),
  buildSignalRow("BTCUSDT", replay),
);
assert.equal(source.length, 7200, "input history is not mutated");
console.log(
  "candle-timing: close boundaries, future invariance, gaps, and demo/replay indicator parity passed",
);
