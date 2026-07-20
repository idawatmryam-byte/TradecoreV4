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

// ── Execution surface against a scripted fake OANDA client (no network) ─────
// Proves the exact request bodies OANDA receives and the close-emulation
// rules — the two places a silent mistake would trade wrong live.
import { OandaAdapter } from "../src/lib/brokers/oandaAdapter";

function fakeClientAdapter(state: {
  openTrades: Array<{ id: string; instrument: string; currentUnits: string }>;
  calls: Array<{ method: string; path: string; body?: unknown }>;
}) {
  const adapter = new OandaAdapter({ token: "t", accountId: "a", practice: true });
  (adapter as any).client = {
    accountId: "a",
    acct(method: string, path: string, body?: unknown) {
      state.calls.push({ method, path, body });
      if (path === "/openTrades") return Promise.resolve({ trades: state.openTrades });
      if (path === "/orders" && method === "POST") {
        return Promise.resolve({
          orderFillTransaction: { id: "900", price: "1.0850", tradeOpened: { tradeID: "777", units: (body as any).order.units, price: "1.0851" } },
        });
      }
      if (path === "/trades/777" && method === "GET") {
        return Promise.resolve({ trade: { stopLossOrder: { id: "sl9" }, takeProfitOrder: { id: "tp9" } } });
      }
      if (path.endsWith("/close")) {
        return Promise.resolve({ orderFillTransaction: { id: "901", price: "1.0900", units: (body as any).units === "ALL" ? "-4000" : `-${(body as any).units}` } });
      }
      if (path === "/orders/sl9" && method === "GET") {
        return Promise.resolve({ order: { id: "sl9", state: "FILLED", price: "1.0800", type: "STOP_LOSS" } });
      }
      return Promise.reject(new Error(`fake client: unhandled ${method} ${path}`));
    },
    request() { return Promise.reject(new Error("fake client: request() not needed here")); },
  };
  (adapter as any).markets = {
    EUR_USD: { id: "EUR_USD", symbol: "EUR_USD", active: true, precision: { price: 5, amount: 0 }, limits: { amount: { min: 1 } }, info: { pipLocation: -4, marginRate: 0.0333, type: "CURRENCY" } },
  };
  return adapter;
}

{
  const state = { openTrades: [] as any[], calls: [] as any[] };
  const ad = fakeClientAdapter(state);
  const res = await ad.placeProtectedEntry("EUR_USD", "sell", 3000, 1.0900, 1.0800);
  const body: any = state.calls.find((c) => c.path === "/orders")!.body;
  expect("short entry sends NEGATIVE units", body.order.units, "-3000");
  expect("bracket carries SL price string", body.order.stopLossOnFill.price, "1.09000");
  expect("bracket carries TP price string", body.order.takeProfitOnFill.price, "1.08000");
  expect("FOK + market order type", `${body.order.type}/${body.order.timeInForce}`, "MARKET/FOK");
  expect("returns oandaTradeId + leg ids", `${res.oandaTradeId}/${res.slOrderId}/${res.tpOrderId}`, "777/sl9/tp9");
  expect("filled units reported unsigned", res.filledUnits, 3000);
}

{
  const state = { openTrades: [{ id: "555", instrument: "EUR_USD", currentUnits: "4000" }], calls: [] as any[] };
  const ad = fakeClientAdapter(state);
  const full: any = await ad.createOrder("EUR_USD", "market", "sell", 4000);
  const closeCall: any = state.calls.find((c) => c.path === "/trades/555/close");
  expect("full close uses ALL (no dust)", closeCall.body.units, "ALL");
  expect("close returns fill price", full.average, 1.09);

  state.calls.length = 0;
  await ad.createOrder("EUR_USD", "market", "sell", 1500);
  const partialCall: any = state.calls.find((c) => c.path === "/trades/555/close");
  expect("partial close sends exact units", partialCall.body.units, "1500");

  let refused = false;
  await ad.createOrder("EUR_USD", "market", "buy", 1000).catch(() => { refused = true; });
  expect("same-direction market order REFUSED (no bare entries)", refused, true);
}

{
  const state = { openTrades: [] as any[], calls: [] as any[] };
  const ad = fakeClientAdapter(state);
  const o: any = await ad.fetchOrder("sl9");
  expect("FILLED maps to ccxt closed", o.status, "closed");
  expect("filled SL reports its price", o.price, 1.08);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll OANDA adapter checks passed.");
