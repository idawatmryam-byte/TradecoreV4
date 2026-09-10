/**
 * Deterministic signal regressions: preserve market-price precision and let
 * directional momentum resolve the micro-scalper's overlapping RSI zones.
 * Synthetic market fixtures verify logic only, not trading profitability.
 */
import {
  buildSignalRow,
  type Candle,
  type MultiTimeframeCandles,
} from "../src/lib/strategy";
import { MicroScalpingStrategy } from "../src/lib/strategies/micro-scalping";
import {
  DEFAULT_STRATEGY_CONFIGS,
  type StrategyConfig,
} from "../src/lib/strategies/base";

let failures = 0;
let assertions = 0;
function expect(name: string, actual: unknown, expected: unknown): void {
  assertions++;
  const passed = actual === expected;
  if (!passed) failures++;
  console.log(
    `${passed ? "PASS" : "FAIL"} ${name}${passed ? "" : ` (got ${String(actual)}, expected ${String(expected)})`}`,
  );
}

function series(closeAt: (index: number) => number, minutes: number): Candle[] {
  return Array.from({ length: 100 }, (_, index): Candle => {
    const close = closeAt(index);
    return [
      1_700_000_000_000 + index * minutes * 60_000,
      close,
      close * 1.001,
      close * 0.999,
      close,
      100,
    ];
  });
}

function market(closeAt: (index: number) => number): MultiTimeframeCandles {
  return {
    tf1m: series(closeAt, 1),
    tf3m: series(closeAt, 3),
    tf5m: series(closeAt, 5),
    tf15m: series(closeAt, 15),
    tf1h: series(closeAt, 60),
  };
}

for (const price of [0.000012345, 0.00012345, 1.123456, 67_123.456789]) {
  const row = buildSignalRow(
    "FIXTURE",
    market(() => price),
  );
  expect(`signal preserves the candle price ${price}`, row.lastPrice, price);
}

const strategy = new MicroScalpingStrategy();
const config: StrategyConfig = {
  ...DEFAULT_STRATEGY_CONFIGS.micro_scalping!,
  strategyId: strategy.strategyId,
};

for (const direction of [1, -1] as const) {
  const mtf = market(
    (index) => 100 + direction * (index * 0.01 + index ** 2 * 0.001),
  );
  // Isolate the documented RSI zone boundaries. The candle series supplies
  // real computed MACD, EMA alignment, and slope; orthogonal row inputs keep
  // participation and the default confidence gate satisfied for either side.
  const row = {
    ...buildSignalRow("FIXTURE", mtf),
    volumeRatio: 4,
  };
  for (const rsi of [34.9, 35, 40, 44.9, 45, 50, 55, 55.1, 60, 65, 65.1]) {
    const expected =
      direction === 1
        ? rsi >= 45 && rsi <= 65
          ? "long"
          : null
        : rsi >= 35 && rsi <= 55
          ? "short"
          : null;
    const signal = strategy.evaluate(
      "FIXTURE",
      mtf,
      { ...row, rsi },
      config,
      10_000,
      100,
    );
    expect(
      `${direction === 1 ? "bullish" : "bearish"} momentum with RSI ${rsi}`,
      signal?.side ?? null,
      expected,
    );
  }

  const opposite = market(
    (index) => 100 - direction * (index * 0.01 + index ** 2 * 0.001),
  );
  expect(
    `opposing 5m trend still rejects ${direction === 1 ? "long" : "short"}`,
    strategy.evaluate(
      "FIXTURE",
      { ...mtf, tf5m: opposite.tf5m },
      { ...row, rsi: 50 },
      config,
      10_000,
      100,
    ),
    null,
  );
  expect(
    `opposing 1m slope still rejects ${direction === 1 ? "long" : "short"}`,
    strategy.evaluate(
      "FIXTURE",
      { ...mtf, tf1m: opposite.tf1m },
      { ...row, rsi: 50 },
      config,
      10_000,
      100,
    ),
    null,
  );
  expect(
    `fading MACD still rejects ${direction === 1 ? "long" : "short"}`,
    strategy.evaluate(
      "FIXTURE",
      { ...mtf, tf3m: series(() => 100, 3) },
      { ...row, rsi: 50 },
      config,
      10_000,
      100,
    ),
    null,
  );
}

console.log(`${assertions - failures}/${assertions} assertions passed.`);
process.exitCode = failures === 0 ? 0 : 1;
