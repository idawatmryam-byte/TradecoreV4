/**
 * TradeCore Pro — OANDA v20 adapter (ccxt-shaped)
 *
 * Implements the read-only subset of `BrokerAdapter` so the existing bot
 * engine can run a forex section against OANDA without touching its ~99
 * `ex.*` call sites. Order execution (createOrder & friends) intentionally
 * throws ccxt `NotSupported` in this phase — the engine additionally refuses
 * forex entries before any order call is reachable.
 *
 * Symbol convention: OANDA-native names ("EUR_USD", "XAU_USD") are used as
 * BOTH `market.id` and `market.symbol`, so buildSymbolMarketMaps() produces
 * identity maps and toMarket()/fromMarket() are no-ops for forex.
 *
 * Timeframe note: OANDA has no 3-minute granularity (M1,M2,M4,M5,… — no M3),
 * but the scanner requests "3m" candles. fetchOHLCV synthesizes 3m by
 * aggregating 3×M1 buckets so every engine timeframe works uniformly.
 */
import { NotSupported, BadSymbol } from "ccxt";
import { OandaClient, oandaTimeToMs, type OandaClientConfig } from "./oandaClient";
import type {
  BrokerAdapter,
  BrokerBalance,
  BrokerMarket,
  BrokerTicker,
  OhlcvCandle,
} from "./brokerAdapter";

/** Engine timeframe → native OANDA granularity ("3m" is synthesized, see below). */
const GRANULARITY: Record<string, string> = {
  "1m": "M1",
  "2m": "M2",
  "4m": "M4",
  "5m": "M5",
  "15m": "M15",
  "30m": "M30",
  "1h": "H1",
  "4h": "H4",
  "1d": "D",
};

interface OandaInstrument {
  name: string;
  type: string; // CURRENCY | METAL | CFD
  displayName: string;
  pipLocation: number;
  displayPrecision: number;
  tradeUnitsPrecision: number;
  minimumTradeSize: string;
  marginRate: string;
}

interface OandaCandle {
  complete: boolean;
  volume: number;
  time: string; // UNIX seconds string
  mid: { o: string; h: string; l: string; c: string };
}

export class OandaAdapter implements BrokerAdapter {
  markets: Record<string, BrokerMarket> = {};
  private readonly client: OandaClient;

  constructor(config: OandaClientConfig) {
    this.client = new OandaClient(config);
  }

  // ── Markets ────────────────────────────────────────────────────────────────

  async loadMarkets(): Promise<Record<string, BrokerMarket>> {
    const res = await this.client.acct<{ instruments: OandaInstrument[] }>("GET", "/instruments");
    const markets: Record<string, BrokerMarket> = {};
    for (const inst of res.instruments) {
      markets[inst.name] = {
        id: inst.name,
        symbol: inst.name,
        active: true,
        precision: {
          price: inst.displayPrecision,
          amount: inst.tradeUnitsPrecision,
        },
        limits: {
          amount: { min: Number(inst.minimumTradeSize) || 1 },
        },
        info: {
          type: inst.type,
          displayName: inst.displayName,
          pipLocation: inst.pipLocation,
          marginRate: Number(inst.marginRate),
        },
      };
    }
    this.markets = markets;
    return markets;
  }

  market(symbol: string): BrokerMarket {
    const m = this.markets[symbol];
    if (!m) throw new BadSymbol(`OANDA: unknown instrument ${symbol} (markets not loaded, or not tradeable on this account)`);
    return m;
  }

  // ── Precision helpers (string returns, like ccxt) ─────────────────────────

  amountToPrecision(symbol: string, amount: number): string {
    const decimals = this.market(symbol).precision.amount;
    // Truncate toward zero (never round an order size UP past what was risk-sized).
    const factor = 10 ** decimals;
    return (Math.trunc(amount * factor) / factor).toFixed(decimals);
  }

  priceToPrecision(symbol: string, price: number): string {
    return price.toFixed(this.market(symbol).precision.price);
  }

  // ── Candles ────────────────────────────────────────────────────────────────

  async fetchOHLCV(symbol: string, timeframe: string, _since?: number, limit = 100): Promise<OhlcvCandle[]> {
    if (timeframe === "3m") {
      // Synthesized: no M3 granularity exists on OANDA.
      const m1 = await this.fetchNative(symbol, "M1", limit * 3);
      return aggregateCandles(m1, 3 * 60_000).slice(-limit);
    }
    const gran = GRANULARITY[timeframe];
    if (!gran) throw new NotSupported(`OANDA: unsupported timeframe ${timeframe}`);
    return this.fetchNative(symbol, gran, limit);
  }

  private async fetchNative(symbol: string, granularity: string, count: number): Promise<OhlcvCandle[]> {
    const res = await this.client.request<{ candles: OandaCandle[] }>(
      "GET",
      `/v3/instruments/${symbol}/candles?granularity=${granularity}&count=${Math.min(count, 5000)}&price=M`,
    );
    // Keep the in-progress last candle (the engine treats the newest candle
    // as live everywhere), drop nothing else — incomplete mid-history candles
    // don't occur.
    return res.candles.map((c): OhlcvCandle => [
      oandaTimeToMs(c.time),
      Number(c.mid.o),
      Number(c.mid.h),
      Number(c.mid.l),
      Number(c.mid.c),
      c.volume,
    ]);
  }

  // ── Tickers ────────────────────────────────────────────────────────────────

  async fetchTicker(symbol: string): Promise<BrokerTicker> {
    const tickers = await this.fetchTickers([symbol]);
    const t = tickers[symbol];
    if (!t) throw new BadSymbol(`OANDA: no pricing returned for ${symbol}`);
    return t;
  }

  async fetchTickers(symbols?: string[]): Promise<Record<string, BrokerTicker>> {
    const list = symbols && symbols.length > 0 ? symbols : Object.keys(this.markets);
    const res = await this.client.acct<{
      prices: Array<{
        instrument: string;
        time: string;
        bids: Array<{ price: string }>;
        asks: Array<{ price: string }>;
      }>;
    }>("GET", `/pricing?instruments=${encodeURIComponent(list.join(","))}`);

    const out: Record<string, BrokerTicker> = {};
    for (const p of res.prices) {
      const bid = Number(p.bids[0]?.price ?? 0);
      const ask = Number(p.asks[0]?.price ?? 0);
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
      out[p.instrument] = {
        symbol: p.instrument,
        bid,
        ask,
        last: mid,
        close: mid,
        // OANDA's pricing stream has no 24h volume/change stats — these fields
        // only feed dashboard cosmetics (scanner volume comes from candles).
        baseVolume: 0,
        quoteVolume: 0,
        percentage: 0,
        timestamp: oandaTimeToMs(p.time),
      };
    }
    return out;
  }

  // ── Balance ────────────────────────────────────────────────────────────────

  /**
   * LOUD SEMANTIC NOTE: the engine reads `bal["USDT"].free` everywhere as
   * "spendable account quote currency". For OANDA that concept is the
   * account's home currency (USD in v1) — we surface it under the "USDT" key
   * ON PURPOSE so sizing/balance code is unchanged. "USDT" here means
   * "account home currency", not Tether.
   *   free  = marginAvailable (what new positions can actually use)
   *   used  = marginUsed
   *   total = NAV (balance + unrealized P/L)
   */
  async fetchBalance(): Promise<BrokerBalance> {
    const res = await this.client.acct<{
      account: { NAV: string; marginAvailable: string; marginUsed: string; currency: string };
    }>("GET", "/summary");
    const free = Number(res.account.marginAvailable);
    const used = Number(res.account.marginUsed);
    const total = Number(res.account.NAV);
    return {
      USDT: { free, used, total },
      free: { USDT: free },
      used: { USDT: used },
      total: { USDT: total },
      info: res.account,
    };
  }

  // ── Open state (read-only; full reconciliation lands in Phase 3) ──────────

  async fetchPositions(_symbols?: string[]): Promise<unknown[]> {
    const res = await this.client.acct<{
      trades: Array<{ id: string; instrument: string; price: string; currentUnits: string; openTime: string }>;
    }>("GET", "/openTrades");
    return res.trades.map((t) => {
      const units = Number(t.currentUnits);
      return {
        symbol: t.instrument,
        side: units >= 0 ? "long" : "short",
        contracts: Math.abs(units),
        entryPrice: Number(t.price),
        info: { ...t, oandaTradeId: t.id },
      };
    });
  }

  async fetchOpenOrders(symbol?: string): Promise<unknown[]> {
    const res = await this.client.acct<{
      orders: Array<{ id: string; type: string; instrument?: string; price?: string; state: string }>;
    }>("GET", "/pendingOrders");
    return res.orders
      .filter((o) => !symbol || o.instrument === symbol)
      .map((o) => ({
        id: o.id,
        type: o.type.toLowerCase(),
        symbol: o.instrument,
        price: o.price != null ? Number(o.price) : undefined,
        status: "open",
        info: o,
      }));
  }

  async fetchMyTrades(_symbol?: string, _since?: number, _limit?: number): Promise<unknown[]> {
    // Fee/fill audit arrives with execution in Phase 2 (via transactions API).
    return [];
  }

  // ── Execution — Phase 2 ────────────────────────────────────────────────────

  async createOrder(): Promise<never> {
    throw new NotSupported("OANDA order execution is not enabled yet (arrives in Phase 2)");
  }

  async cancelOrder(): Promise<never> {
    throw new NotSupported("OANDA order execution is not enabled yet (arrives in Phase 2)");
  }

  async fetchOrder(): Promise<never> {
    throw new NotSupported("OANDA order execution is not enabled yet (arrives in Phase 2)");
  }
}

/**
 * Aggregate fine candles into fixed-width buckets (used for the synthetic
 * "3m" timeframe). Buckets align to epoch multiples of `bucketMs`, matching
 * how exchanges align their native intervals.
 */
export function aggregateCandles(candles: OhlcvCandle[], bucketMs: number): OhlcvCandle[] {
  const out: OhlcvCandle[] = [];
  let current: OhlcvCandle | null = null;
  for (const [t, o, h, l, c, v] of candles) {
    const bucketStart = Math.floor(t / bucketMs) * bucketMs;
    if (!current || current[0] !== bucketStart) {
      if (current) out.push(current);
      current = [bucketStart, o, h, l, c, v];
    } else {
      current[2] = Math.max(current[2], h);
      current[3] = Math.min(current[3], l);
      current[4] = c;
      current[5] += v;
    }
  }
  if (current) out.push(current);
  return out;
}
