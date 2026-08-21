import {
  decimalToMinor,
  deriveAuthoritativeEquity,
} from "../src/lib/execution/equityAuthority";

let failures = 0;
function expect(name: string, ok: boolean): void {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failures += 1;
  }
}

const observedAt = new Date("2026-08-21T00:00:00.000Z");
const buckets = { free: {}, used: {}, total: {} };

expect("decimal conversion is exact", decimalToMinor("123.45") === 12_345n);
expect(
  "minor conversion floors sub-cent provider precision",
  decimalToMinor("1.009") === 100n,
);
expect("negative equity is invalid", decimalToMinor("-1") === null);
expect("non-finite equity is invalid", decimalToMinor(Number.NaN) === null);
expect(
  "pathological provider exponents are rejected before BigInt expansion",
  decimalToMinor("1e999999") === null,
);

const forex = deriveAuthoritativeEquity({
  marketType: "forex",
  balance: {
    ...buckets,
    total: { USDT: 1234.56 },
    info: { NAV: "1234.56", homeCurrency: "USD", homeToUsdRate: 1 },
  },
  observedAt,
  maxAgeMs: 60_000,
});
expect(
  "OANDA NAV becomes exact account equity",
  forex.state === "AVAILABLE" && forex.currentEquityMinor === 123_456n,
);
const convertedOanda = deriveAuthoritativeEquity({
  marketType: "forex",
  balance: {
    ...buckets,
    total: { USDT: 125 },
    info: { NAV: "100.00", homeCurrency: "GBP", homeToUsdRate: "1.25" },
  },
  observedAt,
  maxAgeMs: 60_000,
});
expect(
  "non-USD OANDA NAV retains explicit conversion provenance",
  convertedOanda.state === "AVAILABLE" &&
    convertedOanda.currentEquityMinor === 12_500n &&
    convertedOanda.sourceIdentity === "OANDA_NAV_GBP_TO_USD",
);

const futures = deriveAuthoritativeEquity({
  marketType: "futures",
  balance: {
    ...buckets,
    info: { totalMarginBalance: "987.654321" },
  },
  observedAt,
  maxAgeMs: 60_000,
});
expect(
  "Binance futures uses total margin balance including unrealized PnL",
  futures.state === "AVAILABLE" && futures.currentEquityMinor === 98_765n,
);

const spot = deriveAuthoritativeEquity({
  marketType: "spot",
  balance: {
    ...buckets,
    total: { USDT: 100, BTC: 0.25 },
  },
  tickers: {
    "BTC/USDT": {
      symbol: "BTC/USDT",
      bid: 60_000,
      ask: 60_001,
      last: 60_000.5,
      close: 60_000,
      baseVolume: 1,
      quoteVolume: 60_000,
      percentage: 0,
      timestamp: observedAt.getTime() - 1_000,
    },
  },
  observedAt,
  maxAgeMs: 60_000,
});
expect(
  "spot equity marks every positive asset at a fresh provider bid",
  spot.state === "AVAILABLE" && spot.currentEquityMinor === 1_510_000n,
);

const stale = deriveAuthoritativeEquity({
  marketType: "spot",
  balance: { ...buckets, total: { BTC: 0.25 } },
  tickers: {
    "BTC/USDT": {
      symbol: "BTC/USDT",
      bid: 60_000,
      ask: 60_001,
      last: 60_000,
      close: 60_000,
      baseVolume: 1,
      quoteVolume: 60_000,
      percentage: 0,
      timestamp: observedAt.getTime() - 60_001,
    },
  },
  observedAt,
  maxAgeMs: 60_000,
});
expect("stale spot valuation is UNKNOWN", stale.state === "UNKNOWN");

const missing = deriveAuthoritativeEquity({
  marketType: "spot",
  balance: { ...buckets, total: { ETH: 1 } },
  tickers: {},
  observedAt,
  maxAgeMs: 60_000,
});
expect(
  "unpriced positive asset is UNKNOWN, never zero",
  missing.state === "UNKNOWN",
);

console.log(
  failures === 0
    ? "\nequity-authority: all checks passed"
    : `\nequity-authority: ${failures} FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
