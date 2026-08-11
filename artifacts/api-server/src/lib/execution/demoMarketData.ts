/**
 * TradeCore Pro — market data for the built-in Demo account
 *
 * A demo account has no broker connection, but the whole point is that it
 * trades on the REAL market — a simulation fed synthetic prices teaches a user
 * nothing and proves nothing. So demo needs a data source that requires no
 * credentials from the user.
 *
 * The two sections are not equally easy:
 *
 *   CRYPTO — solved. Binance's public REST endpoints (markets, candles,
 *     tickers) need no API key, so ccxt can be constructed keyless and the
 *     demo engine reads exactly the same prices a live engine does.
 *
 *   FOREX — needs a credential. OANDA has no public market-data API; even
 *     quotes require an account token. So a keyless forex demo is impossible,
 *     and the platform must supply ONE practice token shared by every demo
 *     user (OANDA_PLATFORM_TOKEN / OANDA_PLATFORM_ACCOUNT_ID). Without it,
 *     forex demo is unavailable and says so plainly rather than failing
 *     somewhere deeper with a confusing credential error.
 *
 * Rate limits are the known cost of the shared-token approach: every demo
 * user's forex data goes through one OANDA account's allowance. That is a real
 * scaling ceiling, not a solved problem — it wants a caching layer in front of
 * it before demo forex is opened to significant numbers of users.
 */
import { binance as BinanceExchange, binanceusdm as BinanceUsdmExchange } from "ccxt";
import { OandaAdapter } from "../brokers/oandaAdapter";
import type { MarketType } from "../brokers/brokerAdapter";

/** Thrown when demo cannot get data for a section. Surfaced to the user. */
export class DemoDataUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoDataUnavailableError";
  }
}

export class DemoExecutionIsolationError extends Error {
  constructor(method: string) {
    super(`Simulated Demo market-data client cannot call external broker method ${method}`);
    this.name = "DemoExecutionIsolationError";
  }
}

const DEMO_MARKET_DATA_METHODS = new Set([
  "loadMarkets",
  "market",
  "fetchOHLCV",
  "fetchTicker",
  "fetchTickers",
  "amountToPrecision",
  "priceToPrecision",
]);

/**
 * Capability boundary, not merely a convention. The OANDA practice adapter
 * necessarily holds a platform credential to read prices, so returning the
 * raw adapter would also expose createOrder/cancelOrder. This proxy exports
 * only the market-data surface and turns every other method into an explicit
 * fail-closed error. The same wrapper protects keyless Binance Demo clients
 * against future accidental signed reads or execution calls.
 */
export function restrictToDemoMarketData<T extends object>(source: T): T {
  return new Proxy(source, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const method = String(property);
      if (!DEMO_MARKET_DATA_METHODS.has(method)) {
        return () => {
          throw new DemoExecutionIsolationError(method);
        };
      }
      return value.bind(target);
    },
  });
}

/** True when the platform has forex demo data configured. */
export function forexDemoAvailable(): boolean {
  return Boolean(process.env.OANDA_PLATFORM_TOKEN && process.env.OANDA_PLATFORM_ACCOUNT_ID);
}

/**
 * A read-only market-data client for the demo engine.
 *
 * Nothing here can place an order: crypto is keyless (Binance rejects any
 * signed request), and the OANDA practice account is the platform's, not the
 * user's. Orders in demo never reach a venue at all — they are filled by
 * execution/fillModel.ts.
 */
export async function buildDemoMarketData(marketType: MarketType): Promise<any> {
  if (marketType === "forex") {
    const token = process.env.OANDA_PLATFORM_TOKEN;
    const accountId = process.env.OANDA_PLATFORM_ACCOUNT_ID;
    if (!token || !accountId) {
      throw new DemoDataUnavailableError(
        "Forex demo is unavailable: OANDA has no public market-data API, so the platform needs its own " +
          "practice account. Set OANDA_PLATFORM_TOKEN and OANDA_PLATFORM_ACCOUNT_ID, or use the crypto " +
          "section, which needs no credentials at all.",
      );
    }
    // Always the practice endpoint. A demo account must never be able to reach
    // fxtrade, whatever the section's testnet flag happens to say.
    return restrictToDemoMarketData(new OandaAdapter({ token, accountId, practice: true }));
  }

  // Keyless: public endpoints only. ccxt is happy without credentials and will
  // simply fail any signed call, which is the desired blast radius.
  const ExchangeClass = marketType === "futures" ? BinanceUsdmExchange : BinanceExchange;
  return restrictToDemoMarketData(new ExchangeClass({
    options: { defaultType: marketType, adjustForTimeDifference: true },
  }));
}
