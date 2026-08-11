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
  supportsShortEntries,
} from "../src/lib/marketSymbols";
import {
  assertTickerSymbolsMatchMarket,
  executionClientIdentity,
  fetchTickersForMarket,
  MarketScopedCache,
} from "../src/lib/marketIsolation";

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
const spot = buildSymbolMarketMaps(spotMarkets, "spot");
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
const usdm = buildSymbolMarketMaps(usdmMarkets, "futures");
expect("futures: BTCUSDT → BTC/USDT:USDT", usdm.toUnified.get("BTCUSDT"), "BTC/USDT:USDT");
expect("futures: BTC/USDT:USDT → BTCUSDT", usdm.toPlain.get("BTC/USDT:USDT"), "BTCUSDT");
expect("futures: dated contract excluded from the perpetual-swap domain", usdm.toUnified.has("BTCUSDT_240628"), false);
// THE ORIGINAL BUG, asserted: the spot-format conversion does NOT exist on usdm.
expect("futures: spot-style 'BTC/USDT' is not a valid usdm key", "BTC/USDT" in usdmMarkets, false);

// ── Collision preference: perpetual beats a dated contract sharing an id ─────
const collision = buildSymbolMarketMaps({
  a: { id: "XUSDT", symbol: "X/USDT:USDT-250101", active: true, future: true },
  b: { id: "XUSDT", symbol: "X/USDT:USDT", active: true, swap: true },
}, "futures");
expect("collision: perpetual swap wins", collision.toUnified.get("XUSDT"), "X/USDT:USDT");

// A mixed ccxt catalog must stay partitioned by the explicit active market.
const mixed = {
  "BTC/USDT": { id: "BTCUSDT", symbol: "BTC/USDT", active: true, spot: true, type: "spot" },
  "BTC/USDT:USDT": { id: "BTCUSDT", symbol: "BTC/USDT:USDT", active: true, swap: true, linear: true, type: "swap" },
};
expect("mixed catalog: spot map cannot select futures", buildSymbolMarketMaps(mixed, "spot").toUnified.get("BTCUSDT"), "BTC/USDT");
expect("mixed catalog: futures map cannot select spot", buildSymbolMarketMaps(mixed, "futures").toUnified.get("BTCUSDT"), "BTC/USDT:USDT");

// ── Fallbacks (used before markets load) ─────────────────────────────────────
expect("fallback plain→unified (spot)", unifiedFromPlainFallback("BTCUSDT", "spot"), "BTC/USDT");
expect("fallback plain→unified (futures)", unifiedFromPlainFallback("BTCUSDT", "futures"), "BTC/USDT:USDT");
expect("fallback unified→plain (spot)", plainFromUnifiedFallback("BTC/USDT"), "BTCUSDT");
expect("fallback unified→plain (futures)", plainFromUnifiedFallback("BTC/USDT:USDT"), "BTCUSDT");

// Spot is the only venue without a short-entry mechanism. OANDA Forex was
// previously grouped with spot by an `!== futures` check, silently dropping
// every valid Forex short in both live scans and backtests.
expect("spot: short entries unsupported", supportsShortEntries("spot"), false);
expect("futures: short entries supported", supportsShortEntries("futures"), true);
expect("forex: short entries supported", supportsShortEntries("forex"), true);

const cache = new MarketScopedCache<{ domain: string }>();
const spotClient = cache.getOrCreate("spot", () => ({ domain: "spot" }));
const futuresClient = cache.getOrCreate("futures", () => ({ domain: "futures" }));
expect("market client cache keeps Spot and Futures identities separate", spotClient !== futuresClient, true);
expect("market client cache reuses only the same domain", cache.getOrCreate("spot", () => ({ domain: "wrong" })) === spotClient, true);
expect(
  "authenticated cache identity includes persisted authority and market",
  executionClientIdentity("binance_spot_testnet", "spot") !== executionClientIdentity("binance_futures_demo", "futures"),
  true,
);

const bulkTickerRequests: string[][] = [];
const individualTickerRequests: string[] = [];
const tickerExchange = {
  async fetchTickers(symbols: string[]) {
    bulkTickerRequests.push(symbols);
    return Object.fromEntries(symbols.map((symbol) => [symbol, { last: 1 }]));
  },
  async fetchTicker(symbol: string) {
    individualTickerRequests.push(symbol);
    return { last: 1 };
  },
};
await fetchTickersForMarket({ exchange: tickerExchange, marketType: "spot", symbols: ["BTC/USDT", "ETH/USDT"] });
await fetchTickersForMarket({ exchange: tickerExchange, marketType: "futures", symbols: ["BTC/USDT:USDT", "ETH/USDT:USDT"] });
expect(
  "Spot fetchTickers receives only Spot symbols",
  bulkTickerRequests.length === 1 && bulkTickerRequests[0]?.every((symbol) => !symbol.includes(":")),
  true,
);
expect(
  "Futures ticker reads receive only swap symbols",
  individualTickerRequests.length === 2 && individualTickerRequests.every((symbol) => symbol.endsWith(":USDT")),
  true,
);

let spotRejectedSwap = false;
let futuresRejectedSpot = false;
try { assertTickerSymbolsMatchMarket(["BTC/USDT:USDT"], "spot"); } catch { spotRejectedSwap = true; }
try { assertTickerSymbolsMatchMarket(["BTC/USDT"], "futures"); } catch { futuresRejectedSpot = true; }
expect("Spot engine refuses Futures/swap symbols before provider polling", spotRejectedSwap, true);
expect("Futures engine refuses Spot-only symbols before provider polling", futuresRejectedSpot, true);

console.log(failures === 0 ? "\nAll assertions passed." : `\n${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
