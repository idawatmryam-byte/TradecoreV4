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
    // Fill-level fee audit is Binance-specific bookkeeping; OANDA is
    // commission-free (cost = spread) and closes report their own fill price.
    return [];
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  /**
   * Open a position AND its protection in ONE atomic call — OANDA natively
   * supports MARKET + stopLossOnFill + takeProfitOnFill, which removes the
   * whole fill-then-protect gap the Binance path has to manage. FOK: either
   * the full size fills or nothing does. Returns everything the engine must
   * persist: fill price/units, the OANDA trade id (keys every later SL/TP
   * replace + close), and the dependent SL/TP order ids.
   */
  async placeProtectedEntry(
    symbol: string,
    side: "buy" | "sell",
    units: number,
    slPrice: number,
    tpPrice: number,
  ): Promise<{ fillPrice: number; filledUnits: number; oandaTradeId: string; slOrderId: string; tpOrderId: string }> {
    const res = await this.client.acct<{
      orderFillTransaction?: { id: string; price: string; tradeOpened?: { tradeID: string; units: string; price?: string } };
      orderCancelTransaction?: { reason?: string };
    }>("POST", "/orders", {
      order: {
        type: "MARKET",
        instrument: symbol,
        // OANDA signs direction into units: positive = long, negative = short.
        units: (side === "buy" ? "" : "-") + this.amountToPrecision(symbol, units),
        timeInForce: "FOK",
        positionFill: "DEFAULT",
        stopLossOnFill: { price: this.priceToPrecision(symbol, slPrice), timeInForce: "GTC" },
        takeProfitOnFill: { price: this.priceToPrecision(symbol, tpPrice), timeInForce: "GTC" },
      },
    });

    const fill = res.orderFillTransaction;
    if (!fill?.tradeOpened) {
      throw new Error(`OANDA entry rejected: ${res.orderCancelTransaction?.reason ?? "order did not fill"}`);
    }

    // The dependent SL/TP orders are created ON the trade — one follow-up GET
    // returns their ids authoritatively (simpler and more robust than parsing
    // the create response's related-transaction list).
    const tradeId = fill.tradeOpened.tradeID;
    const tr = await this.client.acct<{
      trade: { stopLossOrder?: { id: string }; takeProfitOrder?: { id: string } };
    }>("GET", `/trades/${tradeId}`);

    return {
      fillPrice: Number(fill.tradeOpened.price ?? fill.price),
      filledUnits: Math.abs(Number(fill.tradeOpened.units)),
      oandaTradeId: tradeId,
      slOrderId: tr.trade.stopLossOrder?.id ?? "",
      tpOrderId: tr.trade.takeProfitOrder?.id ?? "",
    };
  }

  /** Current dependent SL/TP order ids for an open OANDA trade — used by
   *  startup reconciliation to rebuild order tracking after a restart. */
  async getTradeProtection(oandaTradeId: string): Promise<{ slOrderId: string; tpOrderId: string }> {
    const tr = await this.client.acct<{
      trade: { stopLossOrder?: { id: string }; takeProfitOrder?: { id: string } };
    }>("GET", `/trades/${oandaTradeId}`);
    return {
      slOrderId: tr.trade.stopLossOrder?.id ?? "",
      tpOrderId: tr.trade.takeProfitOrder?.id ?? "",
    };
  }

  /**
   * Atomically replace a trade's protective SL (and optionally TP) — OANDA's
   * PUT /trades/{id}/orders swaps dependent orders in one call, keyed by the
   * persisted oandaTradeId (trades.exchangeTradeId). Returns the NEW order ids.
   */
  async replaceTradeProtection(
    oandaTradeId: string,
    symbol: string,
    slPrice?: number,
    tpPrice?: number,
  ): Promise<{ slOrderId: string; tpOrderId: string }> {
    const body: Record<string, unknown> = {};
    if (slPrice != null) body.stopLoss = { price: this.priceToPrecision(symbol, slPrice), timeInForce: "GTC" };
    if (tpPrice != null) body.takeProfit = { price: this.priceToPrecision(symbol, tpPrice), timeInForce: "GTC" };
    const res = await this.client.acct<{
      stopLossOrderTransaction?: { id: string };
      takeProfitOrderTransaction?: { id: string };
    }>("PUT", `/trades/${oandaTradeId}/orders`, body);
    return {
      slOrderId: res.stopLossOrderTransaction?.id ?? "",
      tpOrderId: res.takeProfitOrderTransaction?.id ?? "",
    };
  }

  /**
   * ccxt-compat market order — CLOSES ONLY. Every generic close site in the
   * engine (ExitManager's protective close, TradeManager's partial close,
   * the entry risk-guard flatten) issues `createOrder(market, "market",
   * <opposite side>, qty)`; this translates that to an OANDA trade close on
   * the open trade it opposes (v1 runs one trade per instrument). A market
   * order with NO opposing open trade is refused — the engine never intends
   * a bare unprotected entry (entries go through placeProtectedEntry), so
   * anything else reaching here is a bug and must not open real exposure.
   */
  async createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    _price?: number,
    _params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (type !== "market") {
      throw new NotSupported(`OANDA adapter: only market close orders are supported via createOrder (got type=${type}) — protection is placed atomically at entry`);
    }
    const open = await this.client.acct<{
      trades: Array<{ id: string; instrument: string; currentUnits: string }>;
    }>("GET", "/openTrades");
    // Buying closes a short (negative units); selling closes a long.
    const wantSign = side === "buy" ? -1 : 1;
    const target = open.trades.find(
      (t) => t.instrument === symbol && Math.sign(Number(t.currentUnits)) === wantSign,
    );
    if (!target) {
      throw new Error(`OANDA: no open ${wantSign < 0 ? "short" : "long"} trade on ${symbol} to close — refusing to place a fresh unprotected market order`);
    }

    const openUnits = Math.abs(Number(target.currentUnits));
    const closeUnits = Math.min(amount, openUnits);
    const res = await this.client.acct<{
      orderFillTransaction?: { id: string; price: string; units: string };
    }>("PUT", `/trades/${target.id}/close`, {
      // "ALL" avoids leaving a dust remainder when closing the full size.
      units: closeUnits >= openUnits ? "ALL" : this.amountToPrecision(symbol, closeUnits),
    });
    const fill = res.orderFillTransaction;
    const px = fill?.price != null ? Number(fill.price) : undefined;
    return {
      id: fill?.id ?? target.id,
      average: px,
      price: px,
      filled: fill?.units != null ? Math.abs(Number(fill.units)) : closeUnits,
      status: "closed",
      info: res,
    };
  }

  async cancelOrder(id: string, _symbol?: string): Promise<unknown> {
    // Cancelling an already-filled order 404s — the engine's reconciliation
    // paths EXPECT that throw (they then fetchOrder to learn what happened).
    return this.client.acct("PUT", `/orders/${id}/cancel`);
  }

  async fetchOrder(id: string, _symbol?: string): Promise<unknown> {
    const res = await this.client.acct<{
      order: { id: string; state: string; price?: string; type: string };
    }>("GET", `/orders/${id}`);
    const o = res.order;
    return {
      id: o.id,
      // OANDA states → ccxt statuses: FILLED→closed, CANCELLED→canceled,
      // PENDING/TRIGGERED→open.
      status: o.state === "FILLED" ? "closed" : o.state === "CANCELLED" ? "canceled" : "open",
      price: o.price != null ? Number(o.price) : undefined,
      average: undefined,
      info: o,
    };
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
