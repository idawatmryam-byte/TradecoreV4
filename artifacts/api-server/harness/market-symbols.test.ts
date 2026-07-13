/**
 * Offline verification for src/lib/marketSymbols.ts — the fix for the
 * "engine ran for hours scanning 0 pairs in futures mode" root cause.
 *
 * Constructs market objects shaped exactly like ccxt's loadMarkets() output
 * for binance (spot) and binanceusdm (USDⓈ-M futures) and asserts both
 * conversion directions, the perpetual-vs-dated-contract preference, the
 * inactive-market skip, and the pre-load fallbacks.
 *
 * Run:  tsx harness/market-symbols.test.ts   (exit 0 = all pass)
 */
import {
  buildSymbolMarketMaps,
  unifiedFromPlainFallback,
  plainFromUnifiedFallback,
} from "../src/lib/marketSymbols";

let failures = 0;
function expect(name: string, actual: unknown, wanted: unknown) {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)})`}`);
}

// ── Spot: ccxt `binance` markets are keyed "BTC/USDT" with id "BTCUSDT" ──────
const spotMarkets = {
  "BTC/USDT": { id: "BTCUSDT", symbol: "BTC/USDT", active: true, spot: true },
  "ETH/USDT": { id: "ETHUSDT", symbol: "ETH/USDT", active: true, spot: true },
  "OLD/USDT": { id: "OLDUSDT", symbol: "OLD/USDT", active: false, spot: true }, // delisted
};
const spot = buildSymbolMarketMaps(spotMarkets);
expect("spot: BTCUSDT → BTC/USDT", spot.toUnified.get("BTCUSDT"), "BTC/USDT");
expect("spot: BTC/USDT → BTCUSDT", spot.toPlain.get("BTC/USDT"), "BTCUSDT");
expect("spot: inactive market excluded", spot.toUnified.has("OLDUSDT"), false);

// ── Futures: ccxt `binanceusdm` keys perpetuals "BTC/USDT:USDT" (id "BTCUSDT")
//    and dated contracts "BTC/USDT:USDT-240628" (id "BTCUSDT_240628") ─────────
const usdmMarkets = {
  "BTC/USDT:USDT": { id: "BTCUSDT", symbol: "BTC/USDT:USDT", active: true, swap: true, linear: true },
  "ETH/USDT:USDT": { id: "ETHUSDT", symbol: "ETH/USDT:USDT", active: true, swap: true, linear: true },
  "BTC/USDT:USDT-240628": { id: "BTCUSDT_240628", symbol: "BTC/USDT:USDT-240628", active: true, future: true },
};
const usdm = buildSymbolMarketMaps(usdmMarkets);
expect("futures: BTCUSDT → BTC/USDT:USDT", usdm.toUnified.get("BTCUSDT"), "BTC/USDT:USDT");
expect("futures: BTC/USDT:USDT → BTCUSDT", usdm.toPlain.get("BTC/USDT:USDT"), "BTCUSDT");
expect("futures: dated contract kept under its own id, not the perp's", usdm.toUnified.get("BTCUSDT_240628"), "BTC/USDT:USDT-240628");
// THE ORIGINAL BUG, asserted: the spot-format conversion does NOT exist on usdm.
expect("futures: spot-style 'BTC/USDT' is not a valid usdm key", "BTC/USDT" in usdmMarkets, false);

// ── Collision preference: perpetual beats a dated contract sharing an id ─────
const collision = buildSymbolMarketMaps({
  a: { id: "XUSDT", symbol: "X/USDT:USDT-250101", active: true, future: true },
  b: { id: "XUSDT", symbol: "X/USDT:USDT", active: true, swap: true },
});
expect("collision: perpetual swap wins", collision.toUnified.get("XUSDT"), "X/USDT:USDT");

// ── Fallbacks (used before markets load) ─────────────────────────────────────
expect("fallback plain→unified (spot)", unifiedFromPlainFallback("BTCUSDT", "spot"), "BTC/USDT");
expect("fallback plain→unified (futures)", unifiedFromPlainFallback("BTCUSDT", "futures"), "BTC/USDT:USDT");
expect("fallback unified→plain (spot)", plainFromUnifiedFallback("BTC/USDT"), "BTCUSDT");
expect("fallback unified→plain (futures)", plainFromUnifiedFallback("BTC/USDT:USDT"), "BTCUSDT");

console.log(failures === 0 ? "\nAll assertions passed." : `\n${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
