/**
 * TradeCore Pro — broker adapter contract
 *
 * The bot engine was written against ccxt's Binance objects and calls ~20 of
 * their methods at ~99 scattered sites. Rather than refactor every call site
 * behind a new abstraction (high-risk churn on a live-money path), non-ccxt
 * brokers implement THIS interface: the exact subset of the ccxt surface the
 * engine actually touches, with faithful shapes. The ccxt Binance classes
 * satisfy it structurally — nothing about the crypto path changes.
 *
 * Shape conventions the engine relies on (verified against call sites):
 *   - `markets` is keyed by unified symbol; each market has `id` + `symbol`
 *     (buildSymbolMarketMaps uses only those two, marketSymbols.ts:49).
 *   - `fetchOHLCV` returns `[msTimestamp, open, high, low, close, volume][]`.
 *   - tickers expose `bid`, `ask`, `last`/`close`, `baseVolume`,
 *     `quoteVolume`, `percentage`, `timestamp` (botEngine.pollTickers).
 *   - `fetchBalance()` result is indexable by currency code with
 *     `{ free, used, total }` (getBalance reads `bal["USDT"].free`).
 *   - `amountToPrecision`/`priceToPrecision` return STRINGS (call sites
 *     wrap them in parseFloat).
 *   - auth failures throw ccxt's `AuthenticationError` (start() classifies
 *     with `instanceof`).
 */

/** ccxt OHLCV candle: [timestamp(ms), open, high, low, close, volume]. */
export type OhlcvCandle = [number, number, number, number, number, number];

/** The three market environments an engine can run against.
 *  spot/futures → Binance (ccxt); forex → OANDA (OandaAdapter). */
export type MarketType = "spot" | "futures" | "forex";

export interface BrokerMarket {
  /** Broker-native id ("BTCUSDT", "EUR_USD"). For OANDA id === symbol. */
  id: string;
  /** Unified symbol used as the `markets` key. */
  symbol: string;
  active: boolean;
  precision: {
    /** Decimal places for prices (OANDA displayPrecision). */
    price: number;
    /** Decimal places for order amounts (OANDA tradeUnitsPrecision; 0 = whole units). */
    amount: number;
  };
  limits: {
    amount: { min?: number; max?: number };
  };
  /** Broker-specific extras (e.g. OANDA marginRate / pipLocation) live here. */
  info: Record<string, unknown>;
}

export interface BrokerTicker {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  close: number;
  baseVolume: number;
  quoteVolume: number;
  percentage: number;
  timestamp: number;
}

export interface BrokerBalanceEntry {
  free: number;
  used: number;
  total: number;
}

/** ccxt-shaped balance: per-currency entries plus free/total/used mirrors. */
export interface BrokerBalance {
  [currencyOrBucket: string]: unknown;
  free: Record<string, number>;
  used: Record<string, number>;
  total: Record<string, number>;
}

/**
 * The read-only + execution surface the engine consumes. Execution methods
 * are present in the type so call sites compile, but a Phase-1 adapter may
 * throw ccxt `NotSupported` from them (the engine additionally guards forex
 * entries off before any order call is reachable).
 */
export interface BrokerAdapter {
  markets: Record<string, BrokerMarket>;

  loadMarkets(): Promise<Record<string, BrokerMarket>>;
  market(symbol: string): BrokerMarket;

  amountToPrecision(symbol: string, amount: number): string;
  priceToPrecision(symbol: string, price: number): string;

  fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): Promise<OhlcvCandle[]>;
  fetchTicker(symbol: string): Promise<BrokerTicker>;
  fetchTickers(symbols?: string[]): Promise<Record<string, BrokerTicker>>;
  fetchBalance(): Promise<BrokerBalance>;

  fetchPositions(symbols?: string[]): Promise<unknown[]>;
  fetchOpenOrders(symbol?: string): Promise<unknown[]>;
  fetchMyTrades(symbol?: string, since?: number, limit?: number): Promise<unknown[]>;

  createOrder(symbol: string, type: string, side: string, amount: number, price?: number, params?: Record<string, unknown>): Promise<unknown>;
  cancelOrder(id: string, symbol?: string): Promise<unknown>;
  fetchOrder(id: string, symbol?: string): Promise<unknown>;
}
