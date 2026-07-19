/**
 * Offline verification for the OANDA adapter's pure/derived logic — no
 * network: the 3m candle synthesis (OANDA has no M3 granularity), the
 * identity symbol mapping through buildSymbolMarketMaps, and the forex
 * fallback conversions.
 *
 * Run:  tsx harness/oanda-adapter.test.ts   (exit 0 = all pass)
 */
import { aggregateCandles, conversionPairFor } from "../src/lib/brokers/oandaAdapter";
import type { OhlcvCandle } from "../src/lib/brokers/brokerAdapter";
import {
  buildSymbolMarketMaps,
  unifiedFromPlainFallback,
  plainFromUnifiedFallback,
} from "../src/lib/marketSymbols";

let failures = 0;
function expect(name: string, actual: unknown, wanted: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)})`}`);
}

// ── 3m synthesis: 6×M1 → 2×3m, epoch-aligned ────────────────────────────────
const M1 = 60_000;
const t0 = 1_700_000_100_000; // NOT 3m-aligned on purpose (offset 100s into a bucket)
const aligned = Math.floor(t0 / (3 * M1)) * (3 * M1);
const m1: OhlcvCandle[] = [
  [aligned,          1.10, 1.15, 1.08, 1.12, 10],
  [aligned + 1 * M1, 1.12, 1.20, 1.11, 1.19, 20],
  [aligned + 2 * M1, 1.19, 1.21, 1.05, 1.06, 30],
  [aligned + 3 * M1, 1.06, 1.09, 1.02, 1.03, 5],
  [aligned + 4 * M1, 1.03, 1.04, 1.00, 1.01, 5],
  [aligned + 5 * M1, 1.01, 1.30, 1.01, 1.25, 5],
];
const agg = aggregateCandles(m1, 3 * M1);

expect("two 3m buckets from six M1", agg.length, 2);
expect("bucket 1 timestamp epoch-aligned", agg[0]![0], aligned);
expect("bucket 1 open = first M1 open", agg[0]![1], 1.10);
expect("bucket 1 high = max of highs", agg[0]![2], 1.21);
expect("bucket 1 low = min of lows", agg[0]![3], 1.05);
expect("bucket 1 close = last M1 close", agg[0]![4], 1.06);
expect("bucket 1 volume summed", agg[0]![5], 60);
expect("bucket 2 close = last M1 close", agg[1]![4], 1.25);
expect("bucket 2 volume summed", agg[1]![5], 15);

// Partial trailing bucket (live candle): 7th M1 starts a new bucket alone.
const agg2 = aggregateCandles(
  [...m1, [aligned + 6 * M1, 1.25, 1.26, 1.24, 1.255, 2] as OhlcvCandle],
  3 * M1,
);
expect("in-progress trailing bucket kept", agg2.length, 3);
expect("trailing bucket close", agg2[2]![4], 1.255);

// ── Identity symbol maps for OANDA-shaped markets ───────────────────────────
const oandaMarkets = {
  EUR_USD: { id: "EUR_USD", symbol: "EUR_USD", active: true },
  XAU_USD: { id: "XAU_USD", symbol: "XAU_USD", active: true },
};
const maps = buildSymbolMarketMaps(oandaMarkets);
expect("toUnified is identity", maps.toUnified.get("EUR_USD"), "EUR_USD");
expect("toPlain is identity", maps.toPlain.get("XAU_USD"), "XAU_USD");

// ── Home-currency → USD conversion pair selection ───────────────────────────
expect("USD needs no pair", conversionPairFor("USD"), { instrument: "", invert: false });
expect("GBP → GBP_USD, multiply", conversionPairFor("GBP"), { instrument: "GBP_USD", invert: false });
expect("EUR → EUR_USD, multiply", conversionPairFor("EUR"), { instrument: "EUR_USD", invert: false });
expect("JPY → USD_JPY, inverted", conversionPairFor("JPY"), { instrument: "USD_JPY", invert: true });
expect("CAD → USD_CAD, inverted", conversionPairFor("CAD"), { instrument: "USD_CAD", invert: true });
expect("lowercase input normalized", conversionPairFor("gbp"), { instrument: "GBP_USD", invert: false });

// ── Forex fallbacks: identity, never /USDT$/ surgery ────────────────────────
expect("forex unified fallback identity", unifiedFromPlainFallback("EUR_USD", "forex"), "EUR_USD");
expect("forex plain fallback identity", plainFromUnifiedFallback("EUR_USD"), "EUR_USD");
expect("spot fallback unchanged", unifiedFromPlainFallback("BTCUSDT", "spot"), "BTC/USDT");
expect("futures fallback unchanged", unifiedFromPlainFallback("BTCUSDT", "futures"), "BTC/USDT:USDT");

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll OANDA adapter checks passed.");
