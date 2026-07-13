/**
 * TradeCore Pro — Bot Engine  (Phase 2 Multi-Strategy Engine)
 *
 * Live Binance Spot connection via ccxt.
 * - 5-timeframe candle feed (1m / 3m / 5m / 15m / 1h)
 * - Multi-strategy evaluation: 6 specialized strategies ranked by confidence
 * - Market regime detection
 * - Risk-based or fixed-USDT position sizing per strategy
 * - Symbol cooldown after every exit
 * - Structured professional logging (rejection and acceptance)
 * - Adaptive learning: blacklist + toxic-hour filter backed by PostgreSQL
 */

import {
  binance as BinanceExchange,
  binanceusdm as BinanceUsdmExchange,
  AuthenticationError,
} from "ccxt";
import { db } from "@workspace/db";
import {
  tradesTable,
  botConfigTable,
  blacklistTable,
  hourlyStatsTable,
  tradePartialExitsTable,
} from "@workspace/db";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getBinanceCredentials } from "./binanceCredentials";
import {
  buildSignalRow,
  buildSignalRowLegacy,
  type MultiTimeframeCandles,
  type SignalRow,
  type MarketRegime,
  type IndicatorVote,
} from "./strategy";
import { strategySelector, computeTp1Tp2Ladder, type StrategyConfig, type PositionSide } from "./strategies";
import { loadStrategyConfigs } from "./strategyConfigLoader";
import { ExitManager, type OpenOrderIds } from "./exitManager";
import { TradeManager } from "./tradeManager";
import { placeSellOco, cancelOco } from "./binanceOco";
import { placeFuturesStopAndTakeProfit, closeFuturesPositionMarket, configureFuturesLeverage, getLiquidationPrice } from "./binanceFutures";
import { stopTooCloseToLiquidation } from "./futuresMath";
import { buildDailyReport, formatDailyReportText } from "./dailyReport";
import {
  buildSymbolMarketMaps,
  unifiedFromPlainFallback,
  plainFromUnifiedFallback,
  type SymbolMarketMaps,
} from "./marketSymbols";
import type {
  StageStatus,
  PipelineStage,
  RiskCheck,
  SymbolDecision,
  LiveTicker,
  MarketMonitor,
  BlockingSummary,
} from "./decisionTrace";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ccxt OHLCV candle: [timestamp, open, high, low, close, volume]
type Candle = [number, number, number, number, number, number];

export interface ScannerRow {
  symbol: string;
  confidence: number;
  rsi: number;
  atrPercent: number;
  status: "watching" | "entered" | "blacklisted" | "skipped";
  ema5AboveEma20: boolean;
  macroBullish: boolean;
  volumeRatio: number;
  lastPrice: number;
  // Phase 1 additions
  regime: MarketRegime;
  adx: number;
  macdHistogram: number;
  atrAbs: number;
  votes: IndicatorVote[];
  // Phase 2 additions
  strategyId?: string;
  strategyName?: string;
  entryReason?: string;
  /** Futures Phase: long or short — undefined until a strategy signal exists for this symbol. */
  side?: PositionSide;
}

export interface BotState {
  running: boolean;
  /** Free USDT on the connected exchange environment; null when stopped/unknown. */
  balanceUsdt: number | null;
  dailyPnl: number;
  openPositions: number;
  totalTradesToday: number;
  winRateToday: number;
  circuitBreakerActive: boolean;
  /** Phase 2.5: true when trading is suspended due to consecutive risk violations */
  riskPaused: boolean;
  mode: "live" | "testnet" | "backtest";
  startedAt: string | null;
  lastScanAt: string | null;
}

// In-memory order tracking: tradeDbId → { tpOrderId, slOrderId }
// (OpenOrderIds is defined in ./exitManager — the single consumer of this
// shape besides the map declaration below — so both stay in sync.)

// ---------------------------------------------------------------------------
// BotEngine singleton
// ---------------------------------------------------------------------------

class BotEngine {
  // Futures Phase: spot (`binance`) and futures (`binanceusdm`) are distinct
  // ccxt exchange classes with slightly different method surfaces (e.g. only
  // futures has fetchPositions/setLeverage) — typed loosely here, matching
  // the existing `ex: any` convention already used throughout
  // ExitManager/TradeManager's host callbacks for the same reason.
  private exchange: any = null;
  private availableMarkets: Set<string> = new Set();
  /** Exact DB-symbol ⟷ unified-symbol maps, built from loadMarkets() at start(). */
  private symbolMaps: SymbolMarketMaps | null = null;
  /** Market type of the ACTIVE exchange connection (set at start()). */
  private activeMarketType: "spot" | "futures" = "spot";
  private scannerData: Map<string, ScannerRow> = new Map();
  private openOrderIds: Map<number, OpenOrderIds> = new Map();

  // ── Verification surfaces: decision trace + live market monitor ─────────────
  /** Per-symbol full pipeline decision from the most recent scan. */
  private symbolDecisions: Map<string, SymbolDecision> = new Map();
  /** Latest real ticker snapshot per symbol (updated by the ticker poller). */
  private liveTickers: Map<string, LiveTicker> = new Map();
  /** Markets the ticker poller watches (populated on start). */
  private monitoredMarkets: string[] = [];
  private tickerTimer: ReturnType<typeof setInterval> | null = null;
  /** Single-flight guard so slow ticker fetches (>interval) don't overlap. */
  private tickerPolling = false;
  private marketsLoaded = 0;
  private credentialsVerified = false;
  private lastTickerFetchAt: string | null = null;
  private lastTickerLatencyMs: number | null = null;
  private lastConnError: string | null = null;

  // Symbol cooldowns: symbol → expiry timestamp (ms)
  private symbolCooldowns: Map<string, number> = new Map();
  /** Last resolved market regime per symbol — feeds regime hysteresis so the
   *  regime (and thus which strategies are eligible) can't flip every 15s
   *  scan tick on a metric hovering at a threshold. See detectMarketRegime. */
  private lastRegime: Map<string, MarketRegime> = new Map();
  /** UTC day ("YYYY-MM-DD") the scan loop last saw — a change triggers the
   *  daily-report webhook push for the day that just ended. */
  private lastDailyReportDate: string | null = null;

  // Single-flight guard: prevents overlapping scan executions
  private scanning = false;

  // Cached account balance for risk-based position sizing
  private cachedBalance = 0;
  private lastBalanceFetch = 0;
  private readonly BALANCE_CACHE_MS = 60_000;

  // Strategy config cache (60-second TTL)
  private strategyConfigs: Map<string, StrategyConfig> = new Map();
  private lastStrategyConfigLoad = 0;
  private readonly STRATEGY_CONFIG_CACHE_MS = 60_000;

  // ── Phase 2.5: Risk management protection ───────────────────────────────────
  /** Binance spot taker fee: 0.1% per side */
  private readonly BINANCE_TAKER_FEE = 0.001;
  /** How many consecutive risk violations before trading is paused */
  private readonly MAX_RISK_VIOLATIONS = 3;
  private riskViolationCount = 0;
  private riskPaused = false;

  // ── Phase 4A: centralized exit pipeline ─────────────────────────────────────
  // ExitManager owns every way a trade can close; BotEngine only supplies the
  // side effects (alerts, cooldowns, hourly stats, risk-pause bookkeeping) via
  // this host interface.
  private readonly exitManager = new ExitManager({
    takerFee: this.BINANCE_TAKER_FEE,
    sendAlert: (message: string) => this.sendAlert(message),
    setCooldown: (symbol: string, minutes: number) => this.setCooldown(symbol, minutes),
    recordHourlyStat: (now: Date, pnl: number, win: boolean) => this.recordHourlyStat(now, pnl, win),
    recordRiskViolation: (tradeId: number, symbol: string, detail: string) => {
      this.riskViolationCount++;
      logger.warn(
        { symbol, tradeId, consecutiveCount: this.riskViolationCount, detail },
        `RISK VIOLATION #${this.riskViolationCount} (consecutive): actual loss exceeded expected maximum`,
      );
      if (this.riskViolationCount >= this.MAX_RISK_VIOLATIONS && !this.riskPaused) {
        this.riskPaused = true;
        const alertMsg =
          `🚨 Risk management violation detected. Trading paused. ` +
          `${this.riskViolationCount} consecutive violations. Last: ${symbol} (trade #${tradeId}) — ${detail}`;
        logger.error(
          { consecutiveViolations: this.riskViolationCount, symbol },
          "RISK PAUSED: trading suspended due to consecutive risk violations — manual reset required",
        );
        this.sendAlert(alertMsg).catch(() => {});
      }
      this.persistRiskPauseState().catch(() => {});
    },
    recordCleanClose: () => {
      if (this.riskViolationCount > 0) {
        logger.info({ previousCount: this.riskViolationCount }, "Risk violation counter reset: clean trade close");
        this.riskViolationCount = 0;
        this.persistRiskPauseState().catch(() => {});
      }
    },
  });

  // ── Phase 4B: TP1/TP2/break-even/trailing management ────────────────────────
  // TradeManager only ever narrows risk (raises SL) or partially reduces size —
  // it never fully closes a trade; ExitManager still owns that (see above).
  private readonly tradeManager = new TradeManager({
    takerFee: this.BINANCE_TAKER_FEE,
    sendAlert: (message: string) => this.sendAlert(message),
    cancelProtection: async (ex, market, orderIds) => {
      if (!orderIds) return;
      if (orderIds.ocoOrderListId) {
        await cancelOco(ex, market, orderIds.ocoOrderListId);
      } else {
        if (orderIds.tpOrderId) await ex.cancelOrder(orderIds.tpOrderId, market).catch(() => {});
        if (orderIds.slOrderId) await ex.cancelOrder(orderIds.slOrderId, market).catch(() => {});
      }
    },
    replaceStopOrder: async (ex, trade, market, newStopPrice, tp, qty, oldOrderIds) => {
      // Cancel whatever was resting before (redundant-but-harmless if the
      // caller already called cancelProtection — cancelling an already-
      // cancelled order/list just no-ops via the catches below).
      if (oldOrderIds?.ocoOrderListId) {
        await cancelOco(ex, market, oldOrderIds.ocoOrderListId);
      } else {
        if (oldOrderIds?.tpOrderId) await ex.cancelOrder(oldOrderIds.tpOrderId, market).catch(() => {});
        if (oldOrderIds?.slOrderId) await ex.cancelOrder(oldOrderIds.slOrderId, market).catch(() => {});
      }

      const preciseQty = parseFloat(ex.amountToPrecision(market, qty));
      if (preciseQty <= 0) return null;

      // Futures Phase: a short (side="sell") closes with a BUY; no atomic
      // OCO exists on futures at all (see lib/binanceFutures.ts header).
      if (trade.marketType === "futures") {
        const positionSide = trade.side === "sell" ? "sell" : "buy";
        const result = await placeFuturesStopAndTakeProfit(ex, market, positionSide, preciseQty, newStopPrice, tp);
        return result ? { slOrderId: result.slOrderId, tpOrderId: result.tpOrderId } : null;
      }

      const stopLimitPrice = parseFloat(ex.priceToPrecision(market, newStopPrice * 0.999));
      const ocoResult = await placeSellOco(ex, market, preciseQty, tp, newStopPrice, stopLimitPrice);
      if (ocoResult) {
        return { slOrderId: ocoResult.slOrderId, tpOrderId: ocoResult.tpOrderId, ocoOrderListId: ocoResult.orderListId };
      }

      // Fallback: independent SL-only replacement (carries the known
      // double-reservation risk — see lib/binanceOco.ts). At minimum this
      // still protects the downside, which matters most. Spot is long-only,
      // so this closing sell is always correct here.
      try {
        const stopPrice = parseFloat(ex.priceToPrecision(market, newStopPrice));
        const order = await ex.createOrder(market, "stop_loss_limit", "sell", preciseQty, stopLimitPrice, { stopPrice });
        return { slOrderId: String(order.id) };
      } catch (err) {
        logger.error({ err, tradeId: trade.id, symbol: trade.symbol, newStopPrice, qty },
          "Failed to place replacement SL order — position may be running with NO exchange-side stop until the next tick retries this");
        return null;
      }
    },
    executePartialClose: async (ex, trade, market, qty) => {
      try {
        const preciseQty = parseFloat(ex.amountToPrecision(market, qty));
        if (preciseQty <= 0) return null;
        // Futures Phase: a short (side="sell") is partially closed by BUYING
        // back; a long (side="buy", spot's only option) by selling.
        const closeSide = trade.side === "sell" ? "buy" : "sell";
        const params = trade.marketType === "futures" ? { reduceOnly: true } : undefined;
        const order = await ex.createOrder(market, "market", closeSide, preciseQty, undefined, params);
        return order.average ?? order.price ?? null;
      } catch (err) {
        logger.error({ err, tradeId: trade.id, symbol: trade.symbol, qty }, "Partial close market order failed");
        return null;
      }
    },
    cancelOrder: async (ex, market, orderId) => {
      await ex.cancelOrder(orderId, market);
    },
  });

  private state: BotState = {
    running: false,
    balanceUsdt: null,
    dailyPnl: 0,
    openPositions: 0,
    totalTradesToday: 0,
    winRateToday: 0,
    circuitBreakerActive: false,
    riskPaused: false,
    mode: "testnet",
    startedAt: null,
    lastScanAt: null,
  };
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private backtestState: {
    running: boolean;
    progress: number;
    pairsTotal: number;
    pairsDone: number;
    tradesFound: number;
    error: string | null;
  } = {
    running: false,
    progress: 0,
    pairsTotal: 0,
    pairsDone: 0,
    tradesFound: 0,
    error: null,
  };

  /** Each instance is scoped to exactly one user — their own trades, config,
   *  strategy tuning, and Binance credentials. See lib/engineRegistry.ts for
   *  how a userId maps to its own BotEngine instance. */
  constructor(private readonly userId: number) {}

  // ---------------------------------------------------------------------------
  // Exchange initialisation
  // ---------------------------------------------------------------------------

  private async initExchange(testnet: boolean, marketType: "spot" | "futures"): Promise<any> {
    if (this.exchange) return this.exchange;

    const credentials = await getBinanceCredentials(this.userId);
    if (!credentials) {
      throw new Error(
        "No Binance API credentials configured for this account — add them on the Settings page before starting the bot.",
      );
    }

    const ExchangeClass = marketType === "futures" ? BinanceUsdmExchange : BinanceExchange;
    const ex = new ExchangeClass({
      apiKey: credentials.apiKey,
      secret: credentials.apiSecret,
      options: {
        defaultType: marketType,
        adjustForTimeDifference: true,
      },
    });

    if (testnet) {
      // Paper trading reaches Binance two different ways, and they are NOT
      // interchangeable — ccxt throws if you enable both:
      //
      //   spot    → setSandboxMode(true)     → testnet.binance.vision
      //   futures → enableDemoTrading(true)  → demo-fapi.binance.com
      //
      // Binance retired the futures testnet (testnet.binancefuture.com), so
      // ccxt now hard-rejects setSandboxMode on binanceusdm for every private
      // call. Demo Trading is its replacement. Note the two environments issue
      // SEPARATE API keys: spot-testnet keys will not authenticate against
      // demo-fapi, and vice versa.
      if (marketType === "futures") {
        ex.enableDemoTrading(true);
      } else {
        ex.setSandboxMode(true);
      }
    }

    this.exchange = ex;
    return ex;
  }

  /**
   * Convert a DB/config symbol ("BTCUSDT") to the ccxt unified symbol for the
   * ACTIVE exchange — "BTC/USDT" on spot, "BTC/USDT:USDT" on USDⓈ-M futures.
   * Resolved through the exact market.id maps built at start() (see
   * marketSymbols.ts for the silent-zero-pairs bug the old hardcoded spot
   * format caused in futures mode); format-rule fallback before markets load.
   */
  private toMarket(symbol: string): string {
    return this.symbolMaps?.toUnified.get(symbol)
      ?? unifiedFromPlainFallback(symbol, this.activeMarketType);
  }

  /** Convert a ccxt unified symbol back to the DB/API symbol ("BTCUSDT"). */
  private fromMarket(market: string): string {
    return this.symbolMaps?.toPlain.get(market) ?? plainFromUnifiedFallback(market);
  }

  // ---------------------------------------------------------------------------
  // Balance cache (for risk-based position sizing)
  // ---------------------------------------------------------------------------

  private async getBalance(): Promise<number> {
    const now = Date.now();
    if (now - this.lastBalanceFetch < this.BALANCE_CACHE_MS && this.cachedBalance > 0) {
      return this.cachedBalance;
    }
    try {
      const bal = await this.exchange!.fetchBalance();
      const free = Number((bal as any)["USDT"]?.free ?? (bal as any).total?.["USDT"] ?? 0);
      if (free > 0) {
        this.cachedBalance = free;
        this.lastBalanceFetch = now;
      }
      this.state.balanceUsdt = free; // keep the dashboard's balance current
    } catch {
      // Return cached value on transient failure
    }
    return this.cachedBalance;
  }

  // ---------------------------------------------------------------------------
  // Cooldown helpers
  // ---------------------------------------------------------------------------

  private isOnCooldown(symbol: string): boolean {
    const expiry = this.symbolCooldowns.get(symbol);
    return expiry !== undefined && Date.now() < expiry;
  }

  private setCooldown(symbol: string, minutes: number): void {
    this.symbolCooldowns.set(symbol, Date.now() + minutes * 60_000);
    logger.info({ symbol, cooldownMinutes: minutes }, "Symbol cooldown activated");
  }

  private async getStrategyConfigs(): Promise<Map<string, StrategyConfig>> {
    const now = Date.now();
    if (now - this.lastStrategyConfigLoad < this.STRATEGY_CONFIG_CACHE_MS && this.strategyConfigs.size > 0) {
      return this.strategyConfigs;
    }
    this.strategyConfigs = await loadStrategyConfigs(this.userId);
    this.lastStrategyConfigLoad = now;
    return this.strategyConfigs;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getState(): BotState {
    return { ...this.state, riskPaused: this.riskPaused };
  }

  getScannerData(): ScannerRow[] {
    return Array.from(this.scannerData.values());
  }

  // ── Live market monitor ─────────────────────────────────────────────────────
  getMarketMonitor(): MarketMonitor {
    return {
      connection: {
        connected: this.state.running && !!this.exchange && this.lastConnError === null,
        mode: this.state.mode,
        // Label must reflect the ACTIVE market type — this used to say "Binance
        // Spot Testnet" even when connected to futures Demo Trading, which
        // made the zero-pairs bug (marketSymbols.ts) look like a spot session.
        exchange:
          this.activeMarketType === "futures"
            ? this.state.mode === "testnet" ? "Binance Futures Demo (demo-fapi)" : "Binance USDⓈ-M Futures"
            : this.state.mode === "testnet" ? "Binance Spot Testnet" : "Binance Spot",
        marketsLoaded: this.marketsLoaded,
        credentialsVerified: this.credentialsVerified,
        lastTickerFetchAt: this.lastTickerFetchAt,
        lastTickerLatencyMs: this.lastTickerLatencyMs,
        lastError: this.lastConnError,
      },
      tickers: Array.from(this.liveTickers.values()).sort((a, b) => b.quoteVolume - a.quoteVolume),
    };
  }

  // ── Strategy decision trace ─────────────────────────────────────────────────
  getDecisions(): SymbolDecision[] {
    // Entered first, then by confidence descending — most interesting at the top.
    return Array.from(this.symbolDecisions.values()).sort((a, b) => {
      if (a.finalDecision !== b.finalDecision) return a.finalDecision === "ENTERED" ? -1 : 1;
      return b.confidence - a.confidence;
    });
  }

  getBlockingSummary(): BlockingSummary {
    const decisions = Array.from(this.symbolDecisions.values());
    const entered = decisions.filter((d) => d.finalDecision === "ENTERED").length;
    const blocked = decisions.filter((d) => d.finalDecision === "BLOCKED");

    // Aggregate blocked symbols by their exact reason.
    const byReason = new Map<string, { stage: string; reason: string; symbols: string[] }>();
    for (const d of blocked) {
      const reason = d.blockReason ?? "Unknown";
      const stage = d.blockStage ?? "Unknown";
      const key = `${stage}::${reason}`;
      const existing = byReason.get(key);
      if (existing) existing.symbols.push(d.symbol);
      else byReason.set(key, { stage, reason, symbols: [d.symbol] });
    }
    const reasons = Array.from(byReason.values())
      .map((r) => ({ ...r, count: r.symbols.length }))
      .sort((a, b) => b.count - a.count);

    // Engine-wide block takes precedence in the headline.
    let globalBlock: string | null = null;
    if (!this.state.running) {
      globalBlock = "Engine is stopped — press START to begin scanning";
    } else if (this.state.circuitBreakerActive) {
      globalBlock = "Circuit breaker active — daily loss limit reached, no new entries today";
    } else if (this.riskPaused) {
      globalBlock = `Trading paused after ${this.MAX_RISK_VIOLATIONS} consecutive risk violations — reset required`;
    } else if (decisions.length > 0 && entered === 0 && reasons.length === 1) {
      // Every evaluated symbol blocked for the same single reason.
      globalBlock = `All ${decisions.length} pairs blocked: ${reasons[0]!.reason}`;
    }

    return {
      tradingActive: entered > 0 || (this.state.running && globalBlock === null),
      running: this.state.running,
      globalBlock,
      entered,
      totalEvaluated: decisions.length,
      reasons,
      lastScanAt: this.state.lastScanAt,
    };
  }

  // ── Live ticker poller ──────────────────────────────────────────────────────
  private async pollTickers(): Promise<void> {
    const ex = this.exchange;
    if (!ex || this.monitoredMarkets.length === 0) return;
    // Skip this tick if the previous fetch is still in flight (slow network/API).
    if (this.tickerPolling) return;
    this.tickerPolling = true;
    const start = Date.now();
    try {
      const tickers = (await ex.fetchTickers(this.monitoredMarkets)) as Record<string, any>;
      this.lastTickerLatencyMs = Date.now() - start;
      for (const [market, t] of Object.entries(tickers)) {
        const symbol = this.fromMarket(market);
        const bid = Number(t.bid ?? 0);
        const ask = Number(t.ask ?? 0);
        const spread = ask > 0 && bid > 0 ? ask - bid : 0;
        this.liveTickers.set(symbol, {
          symbol,
          last: Number(t.last ?? t.close ?? 0),
          bid,
          ask,
          spread,
          spreadPercent: ask > 0 ? (spread / ask) * 100 : 0,
          baseVolume: Number(t.baseVolume ?? 0),
          quoteVolume: Number(t.quoteVolume ?? 0),
          changePercent: Number(t.percentage ?? 0),
          timestamp: Number(t.timestamp ?? Date.now()),
        });
      }
      this.lastTickerFetchAt = new Date().toISOString();
      this.lastConnError = null;
    } catch (err) {
      this.lastConnError = String((err as Error)?.message ?? err);
      logger.warn({ err }, "Ticker poll failed");
    } finally {
      this.tickerPolling = false;
    }
  }

  getBacktestStatus() {
    return { ...this.backtestState };
  }

  // ---------------------------------------------------------------------------
  // Legacy quick-backtest (kept for backward-compatibility with /bot/backtest)
  //
  // ⚠️ AUDIT NOTE (found while investigating the backtest-config-override bug
  // — see lib/backtestConfig.ts / CHANGES.md): this is a COMPLETELY SEPARATE
  // backtest implementation from lib/backtestEngine.ts's runBacktest(), which
  // is what the Backtest UI page and POST /backtests/run actually use. This
  // one is single-strategy (buildSignalRowLegacy), reads its percentage SL/TP/
  // confidence/risk from the GLOBAL bot_config table (the same config live
  // trading uses) rather than per-strategy strategy_configs, and — as of
  // this audit — is not called from anywhere in either frontend app. It's
  // reachable only by hitting POST /bot/backtest directly. Left in place
  // for any external/API-only callers that may depend on it, but do not
  // confuse this with the real backtest engine, and do not assume fixes to
  // one apply to the other — they share no code.
  // ---------------------------------------------------------------------------

  async startBacktest(days: number): Promise<void> {
    if (this.backtestState.running) return;

    logger.warn(
      "startBacktest() invoked — this is the LEGACY single-strategy backtest (POST /bot/backtest), not the main engine behind the Backtest UI (POST /backtests/run). See the comment above runLegacyBacktest().",
    );

    const config = await this.loadConfig();
    const pairs = this.getPairs(config);

    this.backtestState = {
      running: true,
      progress: 0,
      pairsTotal: pairs.length,
      pairsDone: 0,
      tradesFound: 0,
      error: null,
    };

    this.runLegacyBacktest(days, pairs, config).catch((err) => {
      this.backtestState.running = false;
      this.backtestState.error = String(err?.message ?? err);
      logger.error({ err }, "Legacy backtest failed");
    });
  }

  private async runLegacyBacktest(
    days: number,
    pairs: string[],
    config: Awaited<ReturnType<typeof this.loadConfig>>
  ): Promise<void> {
    try {
      const baseUrl = "https://api.binance.com/api/v3";
      const limit = Math.min(days * 1440, 1000);
      let tradesFound = 0;

      for (let i = 0; i < pairs.length; i++) {
        const symbol = pairs[i]!;
        this.backtestState.pairsDone = i;
        this.backtestState.progress = Math.round((i / pairs.length) * 100);

        try {
          const [res1m, res1h] = await Promise.all([
            fetch(`${baseUrl}/klines?symbol=${symbol}&interval=1m&limit=${limit}`).then((r) => r.json()),
            fetch(`${baseUrl}/klines?symbol=${symbol}&interval=1h&limit=100`).then((r) => r.json()),
          ]);

          if (!Array.isArray(res1m) || res1m.length < 21) continue;
          if (!Array.isArray(res1h) || res1h.length < 51) continue;

          const candles1m: Candle[] = (res1m as any[]).map((c) => [
            Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]),
          ]);
          const candles1h: Candle[] = (res1h as any[]).map((c) => [
            Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]),
          ]);

          const windowSize = 51;
          let inPosition = false;
          let entryPrice = 0;
          let sl = 0;
          let tp = 0;
          let entryTime: Date | null = null;
          let qty = 0;

          for (let j = windowSize; j < candles1m.length; j++) {
            const window1m = candles1m.slice(j - windowSize, j);
            const lastCandle = window1m[window1m.length - 1]!;
            const [ts, , high, low, close] = lastCandle;
            const now = new Date(ts);

            if (inPosition) {
              let exitReason: string | null = null;
              let exitPrice = 0;
              // NOTE: same-candle SL+TP ambiguity — see comment in
              // backtestEngine.ts. Conservative assumption: SL first.
              if (low <= sl) { exitReason = "stop_loss"; exitPrice = sl; }
              else if (high >= tp) { exitReason = "take_profit"; exitPrice = tp; }

              if (exitReason) {
                const pnl = (exitPrice - entryPrice) * qty;
                await db.insert(tradesTable).values({
                  userId: this.userId,
                  symbol, side: "buy",
                  entryPrice: entryPrice.toFixed(8),
                  exitPrice: exitPrice.toFixed(8),
                  quantity: qty.toFixed(8),
                  pnl: pnl.toFixed(8),
                  status: "closed",
                  confidence: "70.00",
                  stopLoss: sl.toFixed(8),
                  takeProfit: tp.toFixed(8),
                  entryTime: entryTime!,
                  exitTime: now,
                  exitReason,
                  isBacktest: true,
                });
                tradesFound++;
                this.backtestState.tradesFound = tradesFound;
                inPosition = false;
              }
              continue;
            }

            // Use legacy signal builder for backward-compat
            const row = buildSignalRowLegacy(symbol, window1m, candles1h);
            const canEnter =
              row.confidence >= Number(config.confidenceThreshold) &&
              row.ema5AboveEma20 &&
              row.macroBullish &&
              row.volumeRatio > 1;

            if (canEnter) {
              // Phase 5A: percentage-based SL/TP — no more ATR offset, no more
              // maxSlPercent cap (SL is now deterministically config.stopLossPercent).
              entryPrice = close;
              sl = close * (1 - Number(config.stopLossPercent) / 100);
              tp = close * (1 + Number(config.takeProfitPercent) / 100);
              qty = Number(config.positionSizeUsdt) / close;
              entryTime = now;
              inPosition = true;
            }
          }

          if (inPosition && candles1m.length > 0) {
            const lastC = candles1m[candles1m.length - 1]!;
            const exitPrice = lastC[4];
            const pnl = (exitPrice - entryPrice) * qty;
            await db.insert(tradesTable).values({
              userId: this.userId,
              symbol, side: "buy",
              entryPrice: entryPrice.toFixed(8),
              exitPrice: exitPrice.toFixed(8),
              quantity: qty.toFixed(8),
              pnl: pnl.toFixed(8),
              status: "closed",
              confidence: "70.00",
              stopLoss: sl.toFixed(8),
              takeProfit: tp.toFixed(8),
              entryTime: entryTime!,
              exitTime: new Date(lastC[0]),
              exitReason: "timeout",
              isBacktest: true,
            });
            tradesFound++;
            this.backtestState.tradesFound = tradesFound;
          }
        } catch (pairErr) {
          logger.warn({ err: pairErr, symbol }, "Legacy backtest pair failed, skipping");
        }
      }

      this.backtestState.pairsDone = pairs.length;
      this.backtestState.progress = 100;
      this.backtestState.running = false;
      logger.info({ tradesFound }, "Legacy backtest complete");
    } catch (err) {
      this.backtestState.running = false;
      this.backtestState.error = String((err as Error)?.message ?? err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Start / Stop
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.state.running) return;

    const config = await this.loadConfig();
    // Restore risk-pause state from the last run — this must NOT reset on
    // restart, since a process crash/redeploy silently clearing a "manual
    // reset required" safety pause would defeat its entire purpose.
    this.riskPaused = config.riskPaused;
    this.riskViolationCount = config.riskViolationCount;
    this.activeMarketType = config.marketType === "futures" ? "futures" : "spot";
    const ex = await this.initExchange(config.testnet, this.activeMarketType);

    logger.info("Loading Binance markets…");
    await ex.loadMarkets();
    this.availableMarkets = new Set(Object.keys(ex.markets));
    this.marketsLoaded = this.availableMarkets.size;
    // Exact DB-symbol ⟷ unified-symbol maps (spot "BTC/USDT" vs futures
    // "BTC/USDT:USDT") — every toMarket()/fromMarket() resolves through these.
    this.symbolMaps = buildSymbolMarketMaps(ex.markets);
    logger.info({ count: this.availableMarkets.size, mapped: this.symbolMaps.toUnified.size }, "Markets loaded");

    try {
      // This call verifies credentials AND primes the balance — previously the
      // result was discarded, so the user couldn't see their balance until
      // the first sizing-time fetch. Surface it in state immediately.
      const startupBal = await ex.fetchBalance();
      const freeUsdt = Number((startupBal as any)?.["USDT"]?.free ?? (startupBal as any)?.total?.["USDT"] ?? 0);
      if (freeUsdt > 0) {
        this.cachedBalance = freeUsdt;
        this.lastBalanceFetch = Date.now();
      }
      this.state.balanceUsdt = freeUsdt;
      this.credentialsVerified = true;
      logger.info({ balanceUsdt: freeUsdt }, "Exchange credentials verified");
    } catch (authErr: any) {
      this.credentialsVerified = false;
      this.exchange = null;

      // Only a genuine credential rejection should be reported as one. This
      // used to rewrite EVERY failure — network errors, and ccxt's NotSupported
      // for the retired futures testnet — into "check your API keys", which
      // sends you hunting for a credential problem that isn't there.
      if (!(authErr instanceof AuthenticationError)) {
        throw authErr;
      }

      // ccxt attaches `info` (the raw Binance error body) at runtime; it isn't
      // on the typed AuthenticationError surface, hence the cast.
      const code = (authErr as { info?: { code?: string } }).info?.code ?? authErr.message ?? "unknown";
      const environment = config.testnet
        ? config.marketType === "futures"
          ? "Binance Futures Demo Trading (demo-fapi.binance.com)"
          : "Binance spot testnet (testnet.binance.vision)"
        : "Binance live";
      throw new Error(
        `Exchange authentication failed (Binance code ${code}). ` +
          `The API key on the Settings page must be issued by ${environment} — ` +
          `each environment issues its own keys and will reject another's.`,
      );
    }

    this.state.running = true;
    this.state.startedAt = new Date().toISOString();
    this.state.mode = config.testnet ? "testnet" : "live";
    this.state.circuitBreakerActive = false;

    // Phase 5B: reconnect, then reconcile Exchange ⟷ Database ⟷ Bot Memory
    // BEFORE the scan loop starts, so trade management never runs a single
    // tick against stale/empty in-memory order tracking. See
    // reconcileOnStartup()'s header comment for exactly what this fixes.
    try {
      await this.reconcileOnStartup(config.marketType === "futures" ? "futures" : "spot");
    } catch (err) {
      // Reconciliation failing should never block the bot from starting —
      // that would turn a diagnostic safety net into an outage — but it
      // must be loud, since the whole point of this step is trust that
      // in-memory order tracking matches reality.
      logger.error({ err }, "Startup reconciliation threw — continuing to start, but in-memory order tracking may be incomplete until the next successful reconciliation");
      await this.sendAlert("⚠️ Startup reconciliation failed to complete — bot is starting anyway, but please verify open positions manually.");
    }

    // Live market monitor: poll real tickers on a fast, independent cadence so
    // the dashboard shows real-time prices without waiting on the 15s scan.
    const configuredPairs = this.getPairs(config);
    this.monitoredMarkets = configuredPairs
      .filter((s) => this.availableMarkets.has(this.toMarket(s)))
      .map((s) => this.toMarket(s));

    // A configured-but-unscannable state must be LOUD, never silent: before
    // the symbol-mapping fix (marketSymbols.ts) the engine ran for hours in
    // futures mode scanning zero pairs with no error anywhere. If nothing
    // survives the availability filter, alert and say exactly why.
    if (configuredPairs.length > 0 && this.monitoredMarkets.length === 0) {
      const envLabel = this.activeMarketType === "futures" ? "Binance USDⓈ-M futures" : "Binance spot";
      const msg =
        `⚠️ None of your ${configuredPairs.length} configured pairs (${configuredPairs.join(", ")}) ` +
        `exist on ${envLabel} (${this.state.mode}). The bot is running but cannot scan or trade ` +
        `anything until the pair list is fixed in Configuration.`;
      logger.error({ configuredPairs, marketType: this.activeMarketType }, msg);
      await this.sendAlert(msg);
    } else if (this.monitoredMarkets.length < configuredPairs.length) {
      const dropped = configuredPairs.filter((s) => !this.availableMarkets.has(this.toMarket(s)));
      logger.warn({ dropped }, "Some configured pairs are not listed on this exchange/market type and will be skipped");
    }
    await this.pollTickers();
    this.tickerTimer = setInterval(() => this.pollTickers(), 3000);

    await this.runScan();

    const intervalMs = config.scanIntervalSeconds * 1000;
    this.scanTimer = setInterval(() => this.runScan(), intervalMs);
    logger.info({ intervalMs, mode: this.state.mode }, "Bot engine started");
  }

  async stop(): Promise<void> {
    if (!this.state.running) return;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.tickerTimer) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = null;
    }
    // Reset monitor health so a stopped engine doesn't report stale connection data.
    this.liveTickers.clear();
    this.lastTickerFetchAt = null;
    this.lastTickerLatencyMs = null;
    this.lastConnError = null;
    // Tear down the exchange connection. initExchange() returns the cached
    // instance when one exists, so WITHOUT this, changing market type
    // (spot ⟷ futures) or credentials while stopped and then pressing Start
    // silently reused the OLD connection — the config change never took
    // effect. Stop → Start must always reconnect with the current config.
    this.exchange = null;
    this.credentialsVerified = false;
    this.symbolMaps = null;
    // The balance cache belongs to the torn-down connection's environment —
    // spot testnet and futures demo are DIFFERENT accounts with different
    // balances, so a restart into another environment must not size its
    // first trades off the old one's cached balance.
    this.cachedBalance = 0;
    this.lastBalanceFetch = 0;
    this.state.balanceUsdt = null;
    this.state.running = false;
    this.state.startedAt = null;
    logger.info("Bot engine stopped");
  }

  // ---------------------------------------------------------------------------
  // Core scan loop
  // ---------------------------------------------------------------------------

  private async runScan(): Promise<void> {
    // Single-flight guard — skip this tick if previous scan is still in progress
    if (this.scanning) {
      logger.warn("Scan skipped — previous scan still running");
      return;
    }
    this.scanning = true;
    try {
      const config = await this.loadConfig();
      const ex = await this.initExchange(config.testnet, config.marketType === "futures" ? "futures" : "spot");
      const now = new Date();
      this.state.lastScanAt = now.toISOString();

      await this.refreshDailyState(now);

      // Daily trade report: on the first scan after UTC midnight, push the
      // just-ended day's report to the user's alert webhook. Never blocks the
      // scan — report failure only logs. The same report is available on
      // demand via GET /reports/daily (lib/dailyReport.ts).
      const todayUtc = now.toISOString().slice(0, 10);
      if (this.lastDailyReportDate === null) {
        this.lastDailyReportDate = todayUtc; // first scan of this run — nothing ended yet
      } else if (this.lastDailyReportDate !== todayUtc) {
        const endedDay = this.lastDailyReportDate;
        this.lastDailyReportDate = todayUtc;
        buildDailyReport(this.userId, endedDay)
          .then((report) => this.sendAlert(formatDailyReportText(report, this.state.balanceUsdt)))
          .catch((err) => logger.warn({ err, endedDay }, "Daily report push failed"));
      }

      // Open trades are needed both for the circuit-breaker decision below
      // (which symbols still need exit-monitoring even when new entries are
      // blocked) and for the per-symbol loop's existing-position handling —
      // fetch once, up front.
      const openTrades = await db
        .select()
        .from(tradesTable)
        .where(and(eq(tradesTable.userId, this.userId), eq(tradesTable.status, "open")));
      this.state.openPositions = openTrades.length;

      // Circuit breaker
      //
      // FIX (Phase 5B): this used to `return` here, ending the scan entirely
      // before the per-symbol loop below ever ran — which meant open
      // positions stopped being monitored the moment the daily loss limit
      // was hit. Timeout exits (no exchange-side equivalent — 100%
      // dependent on this loop), trailing-stop/break-even/TP1/TP2 updates,
      // and the reconcilePriceTouch() safety net that catches a stop-limit
      // order failing to fill in a fast move all went dark at exactly the
      // moment the account was already under stress. A circuit breaker
      // should freeze NEW risk-taking while continuing to actively manage
      // existing risk — it must never also stop protecting the positions
      // that are already open.
      //
      // The per-symbol loop below already had the right structure to
      // support this correctly: the "existing position?" branch (which
      // calls checkExitCondition) runs unconditionally, before any of the
      // new-entry risk checks — including the "Circuit Breaker" check
      // already present in `preChecks` — are evaluated. So the fix is
      // simply: don't return early. Set the flag, log it, and let that
      // already-correct per-symbol gate do its job.
      this.state.circuitBreakerActive =
        this.state.dailyPnl <= -Math.abs(Number(config.dailyLossLimitUsdt));
      if (this.state.circuitBreakerActive) {
        logger.warn(
          { dailyPnl: this.state.dailyPnl, openPositions: openTrades.length },
          "Circuit breaker active — no new entries; existing positions still monitored",
        );
      }

      const blacklisted = await this.loadActiveBlacklist(now);
      const currentHour = now.getUTCHours();
      const isToxicHour = await this.isToxicHour(currentHour);

      // Performance: while the circuit breaker is active there is no point
      // fetching market data or evaluating entry signals for symbols with no
      // open position — every one of them will be blocked by the
      // "Circuit Breaker" pre-check anyway. Narrow the scan to exactly the
      // symbols that still need exit-monitoring. (When the breaker is not
      // active, this is exactly the same full pair list as before.)
      const openSymbols = new Set(openTrades.map((t) => t.symbol));
      const pairs = this.state.circuitBreakerActive
        ? this.getPairs(config).filter((s) => openSymbols.has(s) && this.availableMarkets.has(this.toMarket(s)))
        : this.getPairs(config).filter((s) => this.availableMarkets.has(this.toMarket(s)));

      if (this.state.circuitBreakerActive) {
        // Any symbol we're not scanning this tick (no open position) still
        // needs its scanner-table row marked, so the dashboard doesn't show
        // stale "entered"/"watching" data from before the breaker tripped.
        for (const [sym, row] of this.scannerData) {
          if (!openSymbols.has(sym)) this.scannerData.set(sym, { ...row, status: "skipped" });
        }
      }

      // Fetch all 5 timeframes in parallel for each symbol. We catch per-symbol
      // so a market-data failure is recorded as a decision rather than lost.
      type CandleResult =
        | { symbol: string; ok: true; tf1m: Candle[]; tf3m: Candle[]; tf5m: Candle[]; tf15m: Candle[]; tf1h: Candle[] }
        | { symbol: string; ok: false; error: string };
      const candleResults: CandleResult[] = await Promise.all(
        pairs.map(async (symbol): Promise<CandleResult> => {
          const market = this.toMarket(symbol);
          try {
            const [tf1m, tf3m, tf5m, tf15m, tf1h] = await Promise.all([
              ex.fetchOHLCV(market, "1m",  undefined, 100) as Promise<Candle[]>,
              ex.fetchOHLCV(market, "3m",  undefined, 100) as Promise<Candle[]>,
              ex.fetchOHLCV(market, "5m",  undefined, 100) as Promise<Candle[]>,
              ex.fetchOHLCV(market, "15m", undefined, 100) as Promise<Candle[]>,
              ex.fetchOHLCV(market, "1h",  undefined, 100) as Promise<Candle[]>,
            ]);
            return { symbol, ok: true, tf1m, tf3m, tf5m, tf15m, tf1h };
          } catch (err) {
            return { symbol, ok: false, error: String((err as Error)?.message ?? err) };
          }
        })
      );

      // Rebuild the decision trace fresh every scan.
      this.symbolDecisions.clear();

      const confThreshold = Number(config.confidenceThreshold);
      // Loaded once per scan (cached internally) — used both for the
      // max-holding-time exit check below and for entry evaluation further down.
      const strategyConfigs = await this.getStrategyConfigs();

      for (const result of candleResults) {
        const symbol = result.symbol;
        const ts = now.toISOString();

        // Five canonical pipeline stages — start neutral, fill in as we go.
        const marketStage: PipelineStage = { name: "Market Data", status: "skip", detail: "Not evaluated" };
        const indicatorStage: PipelineStage = { name: "Indicators", status: "skip", detail: "Not evaluated" };
        const signalStage: PipelineStage = { name: "Signal", status: "skip", detail: "Not evaluated" };
        const riskStage: PipelineStage = { name: "Risk Checks", status: "skip", detail: "Not evaluated" };
        const orderStage: PipelineStage = { name: "Order", status: "skip", detail: "Not evaluated" };

        const record = (
          final: "ENTERED" | "BLOCKED",
          blockStage: string | null,
          blockReason: string | null,
          confidence = 0,
        ) => {
          this.symbolDecisions.set(symbol, {
            symbol, timestamp: ts, confidence, finalDecision: final,
            blockStage, blockReason,
            stages: [marketStage, indicatorStage, signalStage, riskStage, orderStage],
          });
        };

        // ── Stage 1: Market Data ─────────────────────────────────────────────
        if (!result.ok) {
          marketStage.status = "fail";
          marketStage.detail = `Failed to fetch market data: ${result.error}`;
          record("BLOCKED", "Market Data", `Market data unavailable: ${result.error}`);
          logger.warn({ symbol, err: result.error }, "Candle fetch failed for a symbol");
          continue;
        }

        const { tf1m, tf3m, tf5m, tf15m, tf1h } = result;
        marketStage.data = {
          candles: { "1m": tf1m.length, "3m": tf3m.length, "5m": tf5m.length, "15m": tf15m.length, "1h": tf1h.length },
        };

        // Minimum candle counts required for all indicators
        if (tf1m.length < 30 || tf3m.length < 35 || tf5m.length < 30 || tf15m.length < 22 || tf1h.length < 51) {
          marketStage.status = "fail";
          marketStage.detail = "Insufficient candle history for indicator computation";
          record("BLOCKED", "Market Data", "Insufficient candle history (warming up)");
          continue;
        }

        const mtf: MultiTimeframeCandles = { tf1m, tf3m, tf5m, tf15m, tf1h };
        // Deferred-work #2: feed the last regime we saw for THIS symbol so
        // detectMarketRegime can apply hysteresis and stop whipsawing at the
        // 15s scan cadence. Store the resolved regime back for the next tick.
        const row = buildSignalRow(symbol, mtf, this.lastRegime.get(symbol));
        this.lastRegime.set(symbol, row.regime);
        marketStage.status = "pass";
        marketStage.detail = `Fetched 5 timeframes · last price ${row.lastPrice}`;

        // ── Stage 2: Indicators ──────────────────────────────────────────────
        indicatorStage.status = "pass";
        indicatorStage.detail =
          `Confidence ${row.confidence.toFixed(0)}% · regime ${row.regime} · ADX ${row.adx.toFixed(1)}` +
          ` · macro ${row.macroBullish ? "bullish" : "bearish"}`;
        indicatorStage.data = {
          confidence: row.confidence, regime: row.regime, adx: row.adx,
          rsi: row.rsi, macdHistogram: row.macdHistogram, macroBullish: row.macroBullish,
          confidenceThreshold: confThreshold,
        };

        // ── Handle open position for this symbol ─────────────────────────────
        const openForSymbol = openTrades.find((t) => t.symbol === symbol);
        if (openForSymbol) {
          // FIX (missing max-holding-time exit): each strategy defines
          // maxHoldingSeconds (e.g. micro-scalping = 10 min) as part of its
          // risk profile, but nothing previously enforced it — positions
          // could sit open indefinitely waiting on SL/TP alone, defeating a
          // scalping strategy's intended fast turnover. Fall back to the
          // trade's own cooldown-derived default if the strategy is unknown.
          const openStratConfig = openForSymbol.strategyId
            ? strategyConfigs.get(openForSymbol.strategyId)
            : undefined;
          const stratMaxHold = openStratConfig?.maxHoldingSeconds;
          // Bug fix (found during the backtest-config audit — same bug class:
          // a per-strategy value silently overridden by a global one): this
          // used to always pass the GLOBAL config.cooldownMinutes, making the
          // per-strategy cooldownMinutes field added in Phase 4B dead weight
          // — every strategy got the same cooldown no matter what was
          // configured per-strategy. Falls back to the global value only if
          // this trade has no resolvable strategy config.
          const cooldownMinutes = openStratConfig?.cooldownMinutes ?? Number(config.cooldownMinutes);
          await this.checkExitCondition(
            openForSymbol, tf1m, now, cooldownMinutes, stratMaxHold, openStratConfig
          );
          this.scannerData.set(symbol, { ...row, status: "entered" });
          signalStage.status = "skip";
          signalStage.detail = "Position already open — not seeking a new entry";
          riskStage.status = "skip";
          riskStage.detail = "Not applicable — position already open";
          orderStage.status = "pass";
          orderStage.detail = "Position open — monitoring exit conditions (SL/TP)";
          record("ENTERED", null, null, row.confidence);
          continue;
        }

        // ── Pre-signal risk checks (evaluated for display; block by priority) ─
        const isBlacklisted = blacklisted.has(symbol);
        const onCooldown = this.isOnCooldown(symbol);
        const maxPosReached = this.state.openPositions >= config.maxOpenPositions;
        const preChecks: RiskCheck[] = [
          { name: "Blacklist", passed: !isBlacklisted, detail: isBlacklisted ? "Symbol is blacklisted after recent losses" : "Not blacklisted" },
          { name: "Cooldown", passed: !onCooldown, detail: onCooldown ? "Symbol on post-trade cooldown" : "No active cooldown" },
          { name: "Max Open Positions", passed: !maxPosReached, detail: `${this.state.openPositions}/${config.maxOpenPositions} positions open` },
          { name: "Toxic Hour", passed: !isToxicHour, detail: isToxicHour ? `Hour ${currentHour}:00 UTC flagged as historically toxic` : `Hour ${currentHour}:00 UTC OK to trade` },
          { name: "Circuit Breaker", passed: !this.state.circuitBreakerActive, detail: this.state.circuitBreakerActive ? "Daily loss limit reached" : "Within daily loss limit" },
          { name: "Risk Pause", passed: !this.riskPaused, detail: this.riskPaused ? "Trading paused after consecutive risk violations" : "Not paused" },
        ];
        riskStage.data = { checks: preChecks };

        // Block by the exact same priority the engine enforces below.
        if (isBlacklisted) {
          this.scannerData.set(symbol, { ...row, status: "blacklisted" });
          signalStage.status = "skip"; signalStage.detail = "Skipped — blocked by a risk check first";
          riskStage.status = "fail"; riskStage.detail = "Blocked: symbol is blacklisted";
          record("BLOCKED", "Risk Checks", "Symbol is blacklisted", row.confidence);
          continue;
        }
        if (onCooldown) {
          this.scannerData.set(symbol, { ...row, status: "skipped" });
          signalStage.status = "skip"; signalStage.detail = "Skipped — blocked by a risk check first";
          riskStage.status = "fail"; riskStage.detail = "Blocked: symbol on post-trade cooldown";
          record("BLOCKED", "Risk Checks", "Symbol on post-trade cooldown", row.confidence);
          continue;
        }
        const portfolioBlocked = maxPosReached || isToxicHour || this.state.circuitBreakerActive;
        if (portfolioBlocked) {
          const status = row.confidence >= confThreshold ? "watching" : "skipped";
          this.scannerData.set(symbol, { ...row, status });
          const reason = maxPosReached
            ? `Max open positions reached (${this.state.openPositions}/${config.maxOpenPositions})`
            : isToxicHour ? `Toxic trading hour (${currentHour}:00 UTC)` : "Circuit breaker active";
          signalStage.status = "skip"; signalStage.detail = "Skipped — blocked by a risk check first";
          riskStage.status = "fail"; riskStage.detail = `Blocked: ${reason}`;
          record("BLOCKED", "Risk Checks", reason, row.confidence);
          continue;
        }
        if (this.riskPaused) {
          const status = row.confidence >= confThreshold ? "watching" : "skipped";
          this.scannerData.set(symbol, { ...row, status });
          signalStage.status = "skip"; signalStage.detail = "Skipped — blocked by a risk check first";
          riskStage.status = "fail"; riskStage.detail = "Blocked: trading paused (consecutive risk violations)";
          record("BLOCKED", "Risk Checks", "Trading paused after consecutive risk violations", row.confidence);
          continue;
        }

        // ── Stage 3: Signal (Phase 2 multi-strategy evaluation) ──────────────
        const balance = await this.getBalance();

        // Futures sizing: positionSizeUsdt is the MARGIN budget per trade, so
        // the notional cap is size × leverage (in spot they're the same
        // thing). Without this, futures notional was capped identically to
        // spot — every trade pinned at $positionSizeUsdt notional, actual
        // risk ~7x below the configured riskPercent, and leverage had zero
        // effect on P&L ("futures that trades like spot").
        const notionalCapUsdt =
          Number(config.positionSizeUsdt) *
          (config.marketType === "futures" ? Math.max(1, config.leverage) : 1);
        let signals = strategySelector.evaluateSymbol(
          symbol, mtf, row, strategyConfigs, balance, notionalCapUsdt
        );
        // Spot has no short-selling mechanism (buy-to-open is the only way to
        // enter) — strategies always evaluate both directions, so filter out
        // short signals here rather than duplicating a market-type check into
        // all 6 strategy files.
        if (config.marketType !== "futures") {
          signals = signals.filter((s) => s.side === "long");
        }

        if (signals.length === 0) {
          logger.info(
            { symbol, confidence: row.confidence, regime: row.regime, adx: row.adx, macroBullish: row.macroBullish },
            "No strategy signal"
          );
          const status = row.confidence >= confThreshold ? "watching" : "skipped";
          this.scannerData.set(symbol, { ...row, status });
          signalStage.status = "fail";
          signalStage.detail = row.confidence >= confThreshold
            ? `Confidence ${row.confidence.toFixed(0)}% met threshold but no strategy's entry rules qualified (regime ${row.regime})`
            : `Confidence ${row.confidence.toFixed(0)}% below ${confThreshold}% threshold — no qualifying signal`;
          record("BLOCKED", "Signal", "No strategy produced a qualifying entry signal", row.confidence);
          continue;
        }

        // Best signal is first (selector.evaluateSymbol sorts by confidence descending)
        const bestSignal = signals[0]!;
        const stratConfig = strategyConfigs.get(bestSignal.strategyId);
        signalStage.status = "pass";
        signalStage.detail = `${bestSignal.strategyName} signal @ ${bestSignal.confidence.toFixed(0)}% — ${bestSignal.entryReason}`;
        signalStage.data = {
          strategyId: bestSignal.strategyId, strategyName: bestSignal.strategyName,
          confidence: bestSignal.confidence, regime: bestSignal.regime, entryReason: bestSignal.entryReason,
          netRewardRisk: bestSignal.netRewardRisk,
        };

        // ── Stage 4 (cont.): post-signal risk checks ─────────────────────────
        const stratOpenCount = openTrades.filter((t) => t.strategyId === bestSignal.strategyId).length;
        const maxConcurrent = stratConfig?.maxConcurrentPositions ?? 2;
        const concurrentOk = stratOpenCount < maxConcurrent;
        const qtyOk = bestSignal.qty > 0;
        preChecks.push(
          { name: "Strategy Concurrency", passed: concurrentOk, detail: `${stratOpenCount}/${maxConcurrent} open for ${bestSignal.strategyName}` },
          { name: "Position Size", passed: qtyOk, detail: qtyOk ? `Qty ${bestSignal.qty}` : "Computed quantity is 0 — insufficient balance for min order size" },
        );

        if (!concurrentOk) {
          logger.info(
            { symbol, strategyId: bestSignal.strategyId, stratOpenCount, maxConcurrent },
            "Strategy at max concurrent positions — skipping"
          );
          this.scannerData.set(symbol, {
            ...row, status: "skipped",
            strategyId: bestSignal.strategyId, strategyName: bestSignal.strategyName, side: bestSignal.side,
          });
          riskStage.status = "fail";
          riskStage.detail = `Blocked: ${bestSignal.strategyName} at max concurrent positions (${stratOpenCount}/${maxConcurrent})`;
          record("BLOCKED", "Risk Checks", `${bestSignal.strategyName} at max concurrent positions`, bestSignal.confidence);
          continue;
        }
        if (!qtyOk) {
          this.scannerData.set(symbol, {
            ...row, status: "skipped",
            strategyId: bestSignal.strategyId, strategyName: bestSignal.strategyName, side: bestSignal.side,
          });
          riskStage.status = "fail";
          riskStage.detail = "Blocked: position size resolves to 0 (insufficient balance for min order size)";
          record("BLOCKED", "Risk Checks", "Insufficient balance for minimum order size", bestSignal.confidence);
          continue;
        }

        // Portfolio risk check (maxPortfolioRiskPercent): aggregate $ risk
        // across every open position — using each trade's CURRENT stop, since
        // break-even/trailing moves change the real worst-case loss over a
        // position's life — plus this candidate's own risk, capped against a
        // % of balance. maxOpenPositions above only caps a position COUNT;
        // this is the only check that caps actual dollar exposure.
        const existingRiskUsdt = openTrades.reduce((sum, t) => {
          const qty = Number(t.remainingQuantity ?? t.quantity);
          return sum + Math.abs(Number(t.entryPrice) - Number(t.stopLoss)) * qty;
        }, 0);
        const candidateRiskUsdt = Math.abs(bestSignal.entryPrice - bestSignal.suggestedSL) * bestSignal.qty;
        const maxPortfolioRiskUsdt = balance * (Number(config.maxPortfolioRiskPercent) / 100);
        const portfolioRiskOk = existingRiskUsdt + candidateRiskUsdt <= maxPortfolioRiskUsdt;
        preChecks.push({
          name: "Portfolio Risk",
          passed: portfolioRiskOk,
          detail: `$${(existingRiskUsdt + candidateRiskUsdt).toFixed(2)} / $${maxPortfolioRiskUsdt.toFixed(2)} max (${Number(config.maxPortfolioRiskPercent)}% of balance)`,
        });
        if (!portfolioRiskOk) {
          this.scannerData.set(symbol, {
            ...row, status: "skipped",
            strategyId: bestSignal.strategyId, strategyName: bestSignal.strategyName, side: bestSignal.side,
          });
          riskStage.status = "fail";
          riskStage.detail = `Blocked: aggregate portfolio risk ($${(existingRiskUsdt + candidateRiskUsdt).toFixed(2)}) would exceed ${Number(config.maxPortfolioRiskPercent)}% of balance ($${maxPortfolioRiskUsdt.toFixed(2)})`;
          record("BLOCKED", "Risk Checks", "Portfolio risk limit reached", bestSignal.confidence);
          continue;
        }

        riskStage.status = "pass";
        riskStage.detail = "All risk checks passed";

        logger.info(
          {
            symbol, strategyId: bestSignal.strategyId, confidence: bestSignal.confidence,
            regime: bestSignal.regime, reason: bestSignal.entryReason, stratOpenCount, maxConcurrent,
          },
          "Strategy signal — evaluating entry"
        );

        const entry = {
          entryPrice: bestSignal.entryPrice,
          slPrice: bestSignal.suggestedSL,
          tpPrice: bestSignal.suggestedTP,
          qty: bestSignal.qty,
        };

        // ── Stage 5: Order ───────────────────────────────────────────────────
        const { entered, reason } = await this.enterTrade(
          symbol, row, entry, config, now, bestSignal.side,
          bestSignal.strategyId, bestSignal.strategyName, stratConfig,
        );
        if (entered) this.state.openPositions++;
        this.scannerData.set(symbol, {
          ...row,
          status: entered ? "entered" : "skipped",
          strategyId: bestSignal.strategyId,
          strategyName: bestSignal.strategyName,
          entryReason: bestSignal.entryReason,
          side: bestSignal.side,
        });
        if (entered) {
          orderStage.status = "pass";
          orderStage.detail = `Order filled — ${reason}`;
          record("ENTERED", null, null, bestSignal.confidence);
        } else {
          orderStage.status = "fail";
          orderStage.detail = `Order not placed — ${reason}`;
          record("BLOCKED", "Order", reason, bestSignal.confidence);
        }
      }

      await this.updateBlacklist(pairs, now, blacklisted);
    } catch (err) {
      logger.error({ err }, "Scan loop error");
    } finally {
      this.scanning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Entry — real market order + TP limit + SL stop-limit
  // ---------------------------------------------------------------------------

  private async enterTrade(
    symbol: string,
    row: SignalRow,
    entry: { entryPrice: number; slPrice: number; tpPrice: number; qty: number },
    config: Awaited<ReturnType<typeof this.loadConfig>>,
    now: Date,
    side: PositionSide,
    strategyId?: string,
    strategyName?: string,
    stratConfig?: StrategyConfig,
  ): Promise<{ entered: boolean; reason: string }> {
    const ex = this.exchange!;
    const market = this.toMarket(symbol);
    const isShort = side === "short";
    const isFutures = config.marketType === "futures";
    // Order side to OPEN the position; the opposite side closes it.
    const openSide = isShort ? "sell" : "buy";
    const closeSide = isShort ? "buy" : "sell";

    try {
      const marketInfo = ex.markets[market];
      if (!marketInfo) {
        logger.warn({ symbol }, "Market not found, skipping");
        return { entered: false, reason: "Market not found on exchange" };
      }

      const rawQty = entry.qty;
      const qty = parseFloat(ex.amountToPrecision(market, rawQty));
      let effectiveLeverage = config.leverage;

      if (isFutures) {
        // Leverage/margin mode must be set on the exchange before the order
        // — Binance rejects an order whose implied notional exceeds what the
        // account's CURRENT leverage for this symbol allows. Binance also
        // caps leverage per symbol (varies widely by pair), so the
        // configured value may get clamped down — use whatever was actually
        // applied for everything below, not the requested value.
        effectiveLeverage = await configureFuturesLeverage(
          ex, market, config.leverage, config.marginMode === "cross" ? "cross" : "isolated",
        );

        // Margin-sufficiency pre-check: previously this relied entirely on
        // Binance rejecting the order if the required margin didn't fit —
        // a safety net, not a clean failure. Estimate required initial
        // margin from the effective (post-clamp) leverage and bail with a
        // clear, loggable reason before attempting the order if it won't
        // fit the available free balance (small buffer for fees/slippage).
        const estimatedNotional = qty * entry.entryPrice;
        const requiredMargin = estimatedNotional / effectiveLeverage;
        const freeBalance = await this.getBalance();
        if (requiredMargin > freeBalance * 0.98) {
          logger.warn(
            { symbol, requiredMargin: requiredMargin.toFixed(2), freeBalance: freeBalance.toFixed(2), effectiveLeverage },
            "Insufficient futures margin for this trade — skipping entry",
          );
          return {
            entered: false,
            reason: `Insufficient margin: needs ~$${requiredMargin.toFixed(2)} at ${effectiveLeverage}x, only $${freeBalance.toFixed(2)} available`,
          };
        }
      }

      const estimatedUsdt = qty * entry.entryPrice;
      logger.info(
        { symbol, side, qty, estimatedUsdt: estimatedUsdt.toFixed(2), marketType: config.marketType },
        `Placing market ${openSide.toUpperCase()} (${side})`
      );
      const openOrder = await ex.createOrder(market, "market", openSide, qty);

      const fillPrice = openOrder.average ?? openOrder.price ?? entry.entryPrice;
      const filledQty = openOrder.filled ?? qty;

      // ── FIX (bug #1 / #2): use the STRATEGY's own SL/TP, not a generic
      // ATR recompute ─────────────────────────────────────────────────────
      // Each strategy (mean-reversion, volatility-breakout, etc.) computes
      // suggestedSL/suggestedTP via computePercentSLTP() — a fixed % of entry
      // price (Phase 5A) — and computeQty() sized this trade's quantity
      // using the *distance* to that suggestedSL so the dollar risk equals
      // riskPercent × balance. Previously this code discarded that SL/TP and
      // recomputed a brand-new ATR-only SL/TP from the fill price, which (a)
      // ignored the strategy's actual exit logic entirely and (b) put a different
      // stop distance on the exchange than the one qty was sized against —
      // real risk taken no longer matched intended risk.
      //
      // Fix: preserve the strategy's intended risk distance (entry → SL) and
      // reward distance (entry → TP) in absolute price terms, then shift
      // both by the entry slippage (signal price vs. actual fill price) so
      // they stay anchored to what was actually filled. Futures Phase: for a
      // short, SL sits ABOVE entry and TP sits BELOW — the distances below
      // are still always positive magnitudes; only the +/- when reapplying
      // to fillPrice flips.
      const signalEntry = entry.entryPrice;
      const slDistance = isShort ? entry.slPrice - signalEntry : signalEntry - entry.slPrice; // intended risk ($/unit)
      const tpDistance = isShort ? signalEntry - entry.tpPrice : entry.tpPrice - signalEntry;  // intended reward ($/unit)

      const realSl = isShort ? fillPrice + slDistance : fillPrice - slDistance;
      const realTp = isShort ? fillPrice - tpDistance : fillPrice + tpDistance;

      // ── Phase 2.5: SL/TP validity guard — close immediately if invalid ────────
      // An invalid SL/TP after a real fill means we cannot protect the position.
      // Execute an immediate market close rather than leave capital unprotected.
      const slIsValid = isShort ? realSl > fillPrice : (realSl > 0 && realSl < fillPrice);
      const tpIsValid = isShort ? (realTp > 0 && realTp < fillPrice) : realTp > fillPrice;

      // Futures Phase: a leveraged position can be liquidated before its SL
      // ever triggers if the SL is placed beyond (or too close to) the
      // exchange-computed liquidation price. Checked only after a real fill,
      // since liquidation price isn't known until the position exists.
      let liquidationPrice: number | null = null;
      let liquidationIsUnsafe = false;
      if (isFutures) {
        liquidationPrice = await getLiquidationPrice(ex, market);
        if (liquidationPrice !== null) {
          // Distance-proportional buffer (futuresMath.ts): liquidation must
          // sit meaningfully farther from entry than the stop does. The old
          // inline 5%-of-price version rejected EVERY entry at leverage ≳20x.
          liquidationIsUnsafe = stopTooCloseToLiquidation(fillPrice, realSl, liquidationPrice);
        }
      }

      if (!slIsValid || !tpIsValid || liquidationIsUnsafe) {
        logger.error(
          {
            symbol, side,
            fillPrice:  fillPrice.toFixed(6),
            realSl:     realSl.toFixed(8),
            realTp:     realTp.toFixed(8),
            slDistance: slDistance.toFixed(8),
            tpDistance: tpDistance.toFixed(8),
            slIsValid,
            tpIsValid,
            liquidationPrice,
            liquidationIsUnsafe,
          },
          "RISK GUARD: computed SL/TP invalid (or too close to liquidation) after fill — executing immediate market close to protect capital"
        );
        try {
          const closeQty = parseFloat(ex.amountToPrecision(market, filledQty));
          const closeParams = isFutures ? { reduceOnly: true } : undefined;
          const closeOrder = await ex.createOrder(market, "market", closeSide, closeQty, undefined, closeParams);
          logger.warn(
            { symbol, closeOrderId: closeOrder.id, qty: closeQty },
            "RISK GUARD: position closed immediately — no trade recorded"
          );
        } catch (closeErr) {
          logger.error(
            { err: closeErr, symbol, filledQty },
            "RISK GUARD: failed to close unprotected position — MANUAL INTERVENTION REQUIRED"
          );
        }
        const reason = liquidationIsUnsafe
          ? "Risk guard: stop-loss too close to the exchange's liquidation price — position closed immediately"
          : "Risk guard: computed SL/TP invalid after fill — position closed immediately";
        return { entered: false, reason };
      }

      const tpPrice = parseFloat(ex.priceToPrecision(market, realTp));
      const slPrice = parseFloat(ex.priceToPrecision(market, realSl));
      const slLimitPrice = parseFloat(ex.priceToPrecision(market, isShort ? realSl * 1.001 : realSl * 0.999));

      // ── Phase 4B: compute TP1 / (optional) TP2 interior waypoints ────────────
      // Both are R-multiples of the same entry→SL distance the position was
      // risk-sized against. Either is only enabled when it lands strictly
      // between the entry and the strategy's own final `takeProfit` — never
      // beyond it — so the ladder is always entry < tp1 < tp2 < takeProfit
      // (or the mirror order for a short). These are TICK-CHECKED TRIGGERS
      // (see TradeManager), not resting exchange orders — a Binance spot OCO's
      // two legs must share one quantity (and futures has no atomic OCO at
      // all), so there's no valid resting order shape for "SL protects
      // everything, TP1/TP2 carve out smaller slices" at the same time. See
      // CHANGES.md / lib/binanceOco.ts for the full reasoning.
      //
      // Phase 7: this formula now lives once, in strategies/base.ts
      // (computeTp1Tp2Ladder), shared with backtestEngine.ts's simulation —
      // previously this was inline here only, so the backtest had no TP1/TP2
      // concept at all.
      const ladder = stratConfig
        ? computeTp1Tp2Ladder(
            fillPrice, slPrice, tpPrice, filledQty, stratConfig,
            (p) => parseFloat(ex.priceToPrecision(market, p)),
            (q) => parseFloat(ex.amountToPrecision(market, q)),
            side,
          )
        : { tp1Price: 0, tp1Qty: 0, tp2Price: 0, tp2Qty: 0 };
      const { tp1Price, tp1Qty, tp2Price, tp2Qty } = ladder;

      const slPercent = (Math.abs(fillPrice - slPrice) / fillPrice) * 100;
      const tpPercent = (Math.abs(tpPrice - fillPrice) / fillPrice) * 100;
      const riskUsdt = Math.abs(fillPrice - slPrice) * filledQty;
      const expectedMaxLossUsdt = riskUsdt;

      // ── Structured acceptance log ─────────────────────────────────────────
      logger.info(
        {
          symbol,
          side,
          marketType: config.marketType,
          ...(isFutures && { leverage: effectiveLeverage, marginMode: config.marginMode, liquidationPrice }),
          strategy: strategyName ?? "legacy",
          confidence: row.confidence,
          regime: row.regime,
          adx: row.adx,
          fillPrice: fillPrice.toFixed(6),
          slPrice: slPrice.toFixed(6),
          tpPrice: tpPrice.toFixed(6),
          slPercent: slPercent.toFixed(2) + "%",
          tpPercent: tpPercent.toFixed(2) + "%",
          riskUsdt: riskUsdt.toFixed(4),
          expectedMaxLossUsdt: expectedMaxLossUsdt.toFixed(4),
          impliedRiskPct: fillPrice > 0 ? ((expectedMaxLossUsdt / (fillPrice * filledQty)) * 100).toFixed(3) + "%" : "n/a",
          qty: filledQty.toFixed(6),
          macroBullish: row.macroBullish,
          votes: row.votes.reduce(
            (acc: Record<string, string>, v) => { acc[v.name] = v.signal; return acc; },
            {}
          ),
        },
        "Trade entered"
      );

      const [trade] = await db
        .insert(tradesTable)
        .values({
          userId: this.userId,
          symbol,
          side: openSide,
          marketType: config.marketType,
          ...(isFutures && { leverage: effectiveLeverage, marginMode: config.marginMode }),
          ...(liquidationPrice !== null && { liquidationPrice: liquidationPrice.toFixed(8) }),
          entryPrice: fillPrice.toFixed(8),
          quantity: filledQty.toFixed(8),
          status: "open",
          confidence: row.confidence.toFixed(2),
          stopLoss: slPrice.toFixed(8),
          takeProfit: tpPrice.toFixed(8),
          entryTime: now,
          ...(strategyId   && { strategyId }),
          ...(strategyName && { strategyName }),
          // Phase 4A: preserve the strategy's original signal-time SL/TP/qty
          // (before entry-slippage adjustment) so ExitManager can validate
          // planned vs. actual at close time.
          plannedStopLoss: entry.slPrice.toFixed(8),
          plannedTakeProfit: entry.tpPrice.toFixed(8),
          plannedQuantity: entry.qty.toFixed(8),
          // Phase 4B: trade-management ladder
          remainingQuantity: filledQty.toFixed(8),
          ...(tp1Price > 0 && { tp1Price: tp1Price.toFixed(8), tp1Quantity: tp1Qty.toFixed(8) }),
          ...(tp2Price > 0 && { tp2Price: tp2Price.toFixed(8), tp2Quantity: tp2Qty.toFixed(8) }),
        })
        .returning();

      let tpOrderId = "";
      let slOrderId = "";
      let ocoOrderListId = "";

      if (isFutures) {
        // Futures Phase: no atomic OCO exists on USDⓈ-M Futures — always two
        // independent reduceOnly orders (STOP_MARKET + TAKE_PROFIT_MARKET).
        // ExitManager already treats a missing ocoOrderListId as "cancel the
        // other leg on fill" (its independent-orders fallback path for spot),
        // which is exactly correct here too — no changes needed there.
        const result = await placeFuturesStopAndTakeProfit(ex, market, openSide, filledQty, slPrice, tpPrice);
        if (result) {
          slOrderId = result.slOrderId;
          tpOrderId = result.tpOrderId;
        }
      } else {
        // Phase 4B/OCO-fix: the SL and final take-profit are placed as ONE
        // atomic Binance OCO order for the FULL filled qty — not the
        // post-TP1/TP2 remainder — because a real OCO requires both legs to
        // share one quantity. TP1/TP2 are tick-checked triggers (see
        // TradeManager): when hit, it cancels this OCO, market-sells the
        // slice, and re-places a fresh OCO for whatever remains. This is the
        // only way to avoid two resting orders competing for the same locked
        // balance (see lib/binanceOco.ts for the full verified API details).
        // Spot is long-only, so this path never runs for a short.
        const ocoResult = await placeSellOco(ex, market, filledQty, tpPrice, slPrice, slLimitPrice);
        if (ocoResult) {
          tpOrderId = ocoResult.tpOrderId;
          slOrderId = ocoResult.slOrderId;
          ocoOrderListId = ocoResult.orderListId;
        } else {
          // Fallback: independent orders. Carries the known double-reservation
          // risk documented in CHANGES.md/ARCHITECTURE.md — only reached if
          // this ccxt build doesn't expose the raw orderList/oco endpoint.
          const sellQty = parseFloat(ex.amountToPrecision(market, filledQty));
          try {
            const tpOrder = await ex.createOrder(market, "limit", closeSide, sellQty, tpPrice);
            tpOrderId = String(tpOrder.id);
          } catch (tpErr) {
            logger.warn({ err: tpErr, symbol, tradeId: trade!.id },
              "TP order placement failed — position monitored by price");
          }
          try {
            const slOrder = await ex.createOrder(market, "stop_loss_limit", closeSide, sellQty, slLimitPrice, {
              stopPrice: slPrice,
            });
            slOrderId = String(slOrder.id);
          } catch (slErr) {
            logger.warn({ err: slErr, symbol, tradeId: trade!.id },
              "SL order placement failed — position monitored by price");
          }
        }
      }

      if (tpOrderId || slOrderId) {
        this.openOrderIds.set(trade!.id, {
          tpOrderId, slOrderId,
          ...(ocoOrderListId && { ocoOrderListId }),
        });
      }
      const bothPlaced    = !!(tpOrderId && slOrderId);
      const neitherPlaced = !tpOrderId && !slOrderId;
      logger.info(
        {
          tradeId: trade!.id,
          tpOrderId: tpOrderId || "FAILED",
          slOrderId: slOrderId || "FAILED",
          usedTrueOco: !!ocoOrderListId,
          protection: bothPlaced ? "full" : neitherPlaced ? "none" : "partial",
        },
        bothPlaced
          ? (ocoOrderListId ? "TP+SL placed as one atomic OCO — full exchange-side protection" : "TP and SL orders placed independently — full exchange-side protection")
          : neitherPlaced
            ? "WARN: both TP and SL placement failed — price-based exit monitoring only"
            : "Partial exchange protection — price-based exit monitoring supplementing"
      );

      return {
        entered: true,
        reason: bothPlaced
          ? `market ${openSide.toUpperCase()} filled, TP + SL protection placed`
          : neitherPlaced
            ? `market ${openSide.toUpperCase()} filled, price-based exit monitoring (TP/SL orders failed)`
            : `market ${openSide.toUpperCase()} filled, partial exchange protection`,
      };
    } catch (err) {
      logger.error({ err, symbol }, "Failed to enter trade");
      return { entered: false, reason: `Order placement failed: ${String((err as Error)?.message ?? err)}` };
    }
  }

  // ---------------------------------------------------------------------------
  // Exit monitoring — delegated entirely to ExitManager (Phase 4A)
  // ---------------------------------------------------------------------------
  //
  // ExitManager is the single place allowed to close a trade: confirmed
  // order-status fills, price-touch reconciliation, protective market
  // closes, and the max-holding-time exit all live there, along with the
  // planned-vs-actual SL/TP/qty/fees/slippage/P&L validation and the one
  // "closed" DB write. BotEngine only reacts to the outcome.

  private async checkExitCondition(
    trade: typeof tradesTable.$inferSelect,
    candles1m: Candle[],
    now: Date,
    cooldownMinutes: number,
    maxHoldingSeconds?: number,
    stratConfig?: StrategyConfig,
  ): Promise<void> {
    const ex = this.exchange!;
    const market = this.toMarket(trade.symbol);
    let orderIds = this.openOrderIds.get(trade.id);

    // Futures Phase: liquidation proximity is only checked once, right after
    // entry (enterTrade's "RISK GUARD" check) — but for an already-OPEN
    // futures position that check goes stale immediately, especially under
    // cross margin, where liquidation price depends on the whole account's
    // positions, not just this one. Re-verify the same 5% buffer every scan
    // cycle against the CURRENT stop (post break-even/trailing moves) and
    // force-flatten if it's been breached — losing the position to our own
    // market order beats losing it to the exchange's liquidation engine.
    if (trade.marketType === "futures") {
      const liquidationPrice = await getLiquidationPrice(ex, market);
      if (liquidationPrice !== null) {
        const currentStop = Number(trade.stopLoss);
        // Same distance-proportional check as the entry guard (futuresMath.ts),
        // measured from the position's entry against its CURRENT stop.
        const liquidationIsUnsafe = stopTooCloseToLiquidation(
          Number(trade.entryPrice), currentStop, liquidationPrice,
        );
        if (liquidationIsUnsafe) {
          logger.error(
            { tradeId: trade.id, symbol: trade.symbol, currentStop, liquidationPrice },
            "LIQUIDATION RISK: open position's stop is now too close to the exchange's liquidation price — force-flattening",
          );
          const outcome = await this.exitManager.closeManually(ex, trade, market, now, cooldownMinutes, "emergency_stop");
          if (outcome.closed) {
            this.openOrderIds.delete(trade.id);
            await this.sendAlert(
              `🚨 ${trade.symbol} force-closed — stop-loss drifted too close to the liquidation price ($${liquidationPrice.toFixed(4)}). Position flattened to protect capital.`,
            );
          }
          return;
        }
      }
    }

    // Phase 4B: TP1/TP2 partial closes, break-even move, and trailing stops
    // run first — they only ever narrow risk or reduce size, never fully
    // close. Re-fetch the trade afterward since TradeManager may have updated
    // stopLoss/takeProfit/remainingQuantity directly in the DB.
    //
    // manage() returns the OpenOrderIds that should now be tracked — this
    // MUST be persisted back into openOrderIds rather than discarded, since
    // if entry-time protection placement had fully failed (no map entry
    // existed), a later successful re-protection here is the only place that
    // order id is ever recorded. Previously this was dropped on the floor,
    // leaving the bot treating the trade as unprotected on every later tick.
    const updatedOrderIds = await this.tradeManager.manage(ex, trade, market, candles1m, stratConfig, orderIds);
    if (updatedOrderIds) {
      this.openOrderIds.set(trade.id, updatedOrderIds);
      orderIds = updatedOrderIds;
    }
    const current = (await db.select().from(tradesTable).where(eq(tradesTable.id, trade.id)))[0];
    if (!current || current.status !== "open") return; // TradeManager can't fully close, but guard anyway

    const outcome = await this.exitManager.evaluate(
      ex, current, market, candles1m, now, cooldownMinutes, maxHoldingSeconds, orderIds,
    );

    if (outcome.closed) {
      this.openOrderIds.delete(trade.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Startup reconciliation  (Phase 5B)
  //
  // WHY THIS EXISTS — this isn't just "nice to have," it's a real correctness
  // gap: `this.openOrderIds` (the in-memory Map tracking which exchange order
  // IDs protect which trade — see the field declaration above) starts EMPTY
  // on every process restart, but `trades.status='open'` in Postgres and any
  // resting orders on Binance persist across restarts fine. Before this
  // method existed, `TradeManager.cancelProtection()` silently no-ops when
  // `orderIds` is undefined (see the host implementation above —
  // `if (!orderIds) return;`), so the FIRST time a restarted bot tried to
  // adjust a trailing stop or fire a TP1/TP2 partial close on a pre-existing
  // position, it would skip cancelling the old resting order (doesn't know
  // its ID) and then try to place a brand-new one for the same asset — which
  // Binance will reject, since the old order still has that quantity locked.
  // The position wouldn't actually go unprotected (the stale old order is
  // still live), but every trade-management adjustment for it would silently
  // fail from that point on, with a misleading "no exchange-side stop" log.
  //
  // This method fixes that by rebuilding `openOrderIds` from Binance's actual
  // open orders, and separately catches the two failure modes the phase
  // brief calls out: a DB "open" trade the exchange no longer backs (closed
  // while the bot was down) and — the dangerous direction — an exchange
  // position with no resting protective orders at all. It deliberately does
  // NOT try to auto-adopt an exchange balance that has no matching DB trade
  // at all (untracked position, e.g. a manual buy) — guessing an entry
  // price/strategy/risk profile for a position this bot didn't itself open
  // is worse than loudly alerting and leaving it for a human to look at.
  // ---------------------------------------------------------------------------
  private async reconcileOnStartup(marketType: "spot" | "futures"): Promise<void> {
    const ex = this.exchange!;
    const openTrades = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.userId, this.userId), eq(tradesTable.status, "open")));

    if (openTrades.length === 0) {
      logger.info("Startup reconciliation: no open trades in the database — nothing to reconcile");
    } else {
      logger.info({ count: openTrades.length }, "Startup reconciliation: verifying exchange state for open trades");

      // Futures Phase: the "DB says open but exchange balance doesn't back
      // it" check below is inherently spot-shaped — it reads the SPOT wallet's
      // base-asset balance, which has nothing to do with a futures position
      // (margin-backed, tracked via fetchPositions, not a wallet balance of
      // the coin itself). For futures, skip straight to re-verifying/
      // re-placing resting orders — still a real safety net, just narrower
      // than spot's until a futures-native missing-position check is added.
      let balance: any;
      if (marketType === "spot") {
        try {
          balance = await ex.fetchBalance();
        } catch (err) {
          logger.error({ err }, "Startup reconciliation: fetchBalance failed — cannot verify open trades against the exchange this cycle; will retry protective-order recovery only, using tracked quantities");
        }
      }

      for (const trade of openTrades) {
        const market = this.toMarket(trade.symbol);
        const baseAsset = market.split("/")[0]!;
        const trackedQty = Number(trade.remainingQuantity ?? trade.quantity);

        if (balance) {
          const total = Number(balance?.total?.[baseAsset] ?? 0);
          const tolerance = Math.max(trackedQty * 0.005, 1e-8); // dust/precision slack

          if (total + tolerance < trackedQty) {
            await this.reconcileMissingPosition(trade, market, trackedQty, total);
            continue;
          }
        }

        await this.reconcileOrderTracking(trade, market, trackedQty);
      }

      logger.info("Startup reconciliation: open-trade pass complete");
    }

    if (marketType === "spot") {
      await this.detectUntrackedPositions(openTrades);
    }
  }

  /** DB says open, exchange balance says otherwise — closed while the bot was
   *  down (SL/TP fill, manual sell, or an untracked liquidation). Never
   *  guess a P&L number as a normal exit; mark it distinctly and alert loudly. */
  private async reconcileMissingPosition(
    trade: typeof tradesTable.$inferSelect,
    market: string,
    trackedQty: number,
    exchangeTotal: number,
  ): Promise<void> {
    logger.error(
      { tradeId: trade.id, symbol: trade.symbol, trackedQty, exchangeTotal },
      "RECONCILE_MISMATCH: DB shows an open position the exchange balance doesn't back — it closed while the bot was offline",
    );

    // The order side that CLOSES this position — sell for a long, buy for a short.
    const closingSide = trade.side === "sell" ? "buy" : "sell";
    let exitPrice = Number(trade.entryPrice);
    let priceSource = "entryPrice (no trade history available — verify manually)";
    try {
      const ex = this.exchange!;
      const myTrades: any[] = await ex.fetchMyTrades(market, undefined, 20);
      const entryTime = new Date(trade.entryTime).getTime();
      const sells = myTrades.filter((t) => t.side === closingSide && t.timestamp >= entryTime);
      const qty = sells.reduce((s, t) => s + Number(t.amount), 0);
      if (qty > 0) {
        exitPrice = sells.reduce((s, t) => s + Number(t.amount) * Number(t.price), 0) / qty;
        priceSource = `weighted average of ${sells.length} closing ${closingSide} fill(s) since entry`;
      }
    } catch (err) {
      logger.warn({ err, tradeId: trade.id }, "RECONCILE_MISMATCH: fetchMyTrades failed — falling back to entryPrice as a neutral placeholder");
    }

    // Roll in any TP1/TP2 partial closes so pnl reflects the WHOLE trade, not
    // just the remaining (post-partial) tranche — mirrors ExitManager.closeTrade().
    // Without this, a trade that took a profitable TP1 fill before the bot
    // went offline silently loses that profit from dailyPnl (circuit breaker)
    // and from the win-rate stats that drive blacklisting.
    const partials = await db
      .select()
      .from(tradePartialExitsTable)
      .where(eq(tradePartialExitsTable.tradeId, trade.id));
    const partialsNetPnl = partials.reduce((s, p) => s + Number(p.pnl), 0);

    const isShort = trade.side === "sell";
    const legPnl = (isShort ? Number(trade.entryPrice) - exitPrice : exitPrice - Number(trade.entryPrice)) * trackedQty;
    const pnl = legPnl + partialsNetPnl;
    await db
      .update(tradesTable)
      .set({
        status: "closed",
        exitPrice: String(exitPrice),
        exitTime: new Date(),
        exitReason: "reconciled_missing",
        pnl: String(pnl),
      })
      .where(eq(tradesTable.id, trade.id));

    this.openOrderIds.delete(trade.id);

    await this.sendAlert(
      `⚠️ RECONCILIATION: trade #${trade.id} (${trade.symbol}) was marked open in the database but the exchange no longer ` +
        `holds a matching balance — it must have closed while the bot was offline. Closed with a best-effort exit price of ` +
        `${exitPrice.toFixed(8)} (source: ${priceSource}). Please verify against Binance trade history and correct the record if needed.`,
    );
  }

  /** DB and exchange agree the position is open — rebuild this.openOrderIds
   *  from Binance's actual resting orders (empty in memory after every
   *  restart), and re-place protection immediately if there is none. */
  private async reconcileOrderTracking(
    trade: typeof tradesTable.$inferSelect,
    market: string,
    trackedQty: number,
  ): Promise<void> {
    const ex = this.exchange!;
    const isShort = trade.side === "sell";
    const isFutures = trade.marketType === "futures";
    // The order side that CLOSES this position — opposite of how it opened.
    const closingSide = isShort ? "buy" : "sell";
    try {
      const openOrders: any[] = await ex.fetchOpenOrders(market);
      const closingOrders = openOrders.filter((o) => o.side === closingSide);

      if (closingOrders.length === 0) {
        logger.error(
          { tradeId: trade.id, symbol: trade.symbol },
          `RECONCILE_UNPROTECTED: open position confirmed on the exchange but NO resting ${closingSide} orders exist — position has zero exchange-side protection. Re-placing now.`,
        );
        let ocoResult: { tpOrderId: string; slOrderId: string; orderListId?: string } | null = null;
        if (isFutures) {
          ocoResult = await placeFuturesStopAndTakeProfit(ex, market, isShort ? "sell" : "buy", trackedQty, Number(trade.stopLoss), Number(trade.takeProfit));
        } else {
          const stopLimitPrice = parseFloat(ex.priceToPrecision(market, Number(trade.stopLoss) * 0.999));
          ocoResult = await placeSellOco(
            ex, market, trackedQty, Number(trade.takeProfit), Number(trade.stopLoss), stopLimitPrice,
          );
        }
        if (ocoResult) {
          this.openOrderIds.set(trade.id, {
            tpOrderId: ocoResult.tpOrderId, slOrderId: ocoResult.slOrderId,
            ...(ocoResult.orderListId && { ocoOrderListId: ocoResult.orderListId }),
          });
          logger.info({ tradeId: trade.id }, "RECONCILE: re-placed protective orders for a previously-unprotected position");
          await this.sendAlert(
            `🚨 RECONCILIATION: trade #${trade.id} (${trade.symbol}) had NO exchange-side stop/take-profit on restart. ` +
              `Protection has been re-placed automatically. Please review why the original orders were missing.`,
          );
        } else {
          logger.error({ tradeId: trade.id }, "RECONCILE_UNPROTECTED: automatic re-protection failed — position remains unprotected until the next scan retries it");
          await this.sendAlert(
            `🚨🚨 URGENT: trade #${trade.id} (${trade.symbol}) has NO exchange-side protection and automatic recovery FAILED. Manual intervention needed now.`,
          );
        }
        return;
      }

      // Group by Binance's orderListId when present (true OCO — spot only,
      // futures never has one); otherwise fall back to distinguishing by type.
      const withList = closingOrders.find((o) => o.info?.orderListId && String(o.info.orderListId) !== "-1");
      if (withList) {
        const listId = String(withList.info.orderListId);
        const legs = closingOrders.filter((o) => String(o.info?.orderListId) === listId);
        const tp = legs.find((o) => !String(o.type).includes("stop"));
        const sl = legs.find((o) => String(o.type).includes("stop"));
        this.openOrderIds.set(trade.id, {
          ocoOrderListId: listId,
          tpOrderId: tp ? String(tp.id) : "",
          slOrderId: sl ? String(sl.id) : "",
        });
      } else {
        const tp = closingOrders.find((o) => !String(o.type).toLowerCase().includes("stop"));
        const sl = closingOrders.find((o) => String(o.type).toLowerCase().includes("stop"));
        this.openOrderIds.set(trade.id, {
          tpOrderId: tp ? String(tp.id) : "",
          slOrderId: sl ? String(sl.id) : "",
        });
      }
      logger.info(
        { tradeId: trade.id, symbol: trade.symbol, orderCount: closingOrders.length },
        "RECONCILE: restored in-memory order tracking from existing exchange orders",
      );
    } catch (err) {
      logger.error(
        { err, tradeId: trade.id, symbol: trade.symbol },
        "RECONCILE: failed to fetch/restore open orders — exit management will keep trying, but order-cancel-before-replace may fail (see reconcileOnStartup's header comment) until this trade's protection is next successfully touched",
      );
    }
  }

  /** The dangerous direction: an exchange balance with no corresponding DB
   *  trade at all — e.g. a manual buy, or a DB write that failed after the
   *  exchange fill succeeded. Deliberately does not auto-adopt (see header
   *  comment) — alerts loudly and leaves it for a human to resolve. */
  private async detectUntrackedPositions(openTrades: (typeof tradesTable.$inferSelect)[]): Promise<void> {
    const ex = this.exchange!;
    let balance: any;
    try {
      balance = await ex.fetchBalance();
    } catch {
      return; // already logged in reconcileOnStartup if this was the first call this cycle
    }

    const config = await this.loadConfig();
    const trackedSymbols = new Set(openTrades.map((t) => t.symbol));
    const pairs = this.getPairs(config);

    for (const symbol of pairs) {
      if (trackedSymbols.has(symbol)) continue;
      const market = this.toMarket(symbol);
      const baseAsset = market.split("/")[0]!;
      const total = Number(balance?.total?.[baseAsset] ?? 0);
      if (total <= 0) continue;

      // Ignore obvious dust (a small residual from a past partial fill/rounding).
      let lastPrice = 0;
      try {
        const ticker = await ex.fetchTicker(market);
        lastPrice = Number(ticker?.last ?? 0);
      } catch { /* best-effort only */ }
      const notional = total * lastPrice;
      if (notional > 0 && notional < 5) continue; // < $5 — treat as dust, not a position

      logger.error(
        { symbol, baseAsset, total, notionalUsdt: notional || "unknown" },
        "RECONCILE_UNTRACKED: exchange holds a balance with no matching open trade in the database — possible manual trade or a failed DB write after a real fill",
      );
      await this.sendAlert(
        `🚨 RECONCILIATION: found ${total} ${baseAsset} on the exchange (~$${notional ? notional.toFixed(2) : "?"}) with no matching ` +
          `open trade in the database. This bot will NOT auto-adopt it — please review manually (Binance trade history) and either ` +
          `close it yourself or create a matching trade record if it should be bot-managed.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Adaptive learning
  // ---------------------------------------------------------------------------

  private async updateBlacklist(
    pairs: string[],
    now: Date,
    alreadyBlacklisted: Set<string>,
  ): Promise<void> {
    for (const symbol of pairs) {
      const recent = await db
        .select()
        .from(tradesTable)
        .where(and(eq(tradesTable.userId, this.userId), eq(tradesTable.symbol, symbol), eq(tradesTable.status, "closed")))
        .orderBy(desc(tradesTable.exitTime))
        .limit(10);

      if (recent.length < 10) continue;

      const wins = recent.filter((t) => Number(t.pnl ?? 0) > 0).length;
      const winRate = wins / recent.length;

      if (winRate < 0.4) {
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        await db
          .insert(blacklistTable)
          .values({ userId: this.userId, symbol, winRate: winRate.toFixed(4), tradeCount: recent.length, blacklistedAt: now, expiresAt })
          .onConflictDoUpdate({
            target: [blacklistTable.userId, blacklistTable.symbol],
            set: { winRate: winRate.toFixed(4), tradeCount: recent.length, blacklistedAt: now, expiresAt },
          });
        // Only log when the symbol is newly blacklisted — not on every 15-second scan tick
        if (!alreadyBlacklisted.has(symbol)) {
          logger.warn({ symbol, winRate }, "Symbol blacklisted for 24h");
        }
      }
    }
  }

  private async loadActiveBlacklist(now: Date): Promise<Set<string>> {
    const rows = await db
      .select()
      .from(blacklistTable)
      .where(and(eq(blacklistTable.userId, this.userId), gte(blacklistTable.expiresAt, now)));
    return new Set(rows.map((r) => r.symbol));
  }

  private async isToxicHour(hour: number): Promise<boolean> {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;
    const rows = await db
      .select()
      .from(hourlyStatsTable)
      .where(and(
        eq(hourlyStatsTable.userId, this.userId),
        eq(hourlyStatsTable.hour, hour),
        gte(hourlyStatsTable.date, threeDaysAgo),
      ));
    if (rows.length === 0) return false;
    return rows.reduce((sum, r) => sum + Number(r.pnl), 0) < 0;
  }

  private async recordHourlyStat(now: Date, pnl: number, win: boolean): Promise<void> {
    const date = now.toISOString().split("T")[0]!;
    const hour = now.getUTCHours();
    await db.execute(
      sql`INSERT INTO hourly_stats (user_id, date, hour, pnl, trade_count, win_count)
          VALUES (${this.userId}, ${date}, ${hour}, ${pnl}, 1, ${win ? 1 : 0})
          ON CONFLICT (user_id, date, hour)
          DO UPDATE SET
            pnl         = hourly_stats.pnl + EXCLUDED.pnl,
            trade_count = hourly_stats.trade_count + 1,
            win_count   = hourly_stats.win_count + EXCLUDED.win_count,
            updated_at  = now()`
    );
  }

  // ---------------------------------------------------------------------------
  // Daily state refresh
  // ---------------------------------------------------------------------------

  private async refreshDailyState(now: Date): Promise<void> {
    const startOfDay = new Date(now.toISOString().split("T")[0]! + "T00:00:00Z");
    const closedToday = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.userId, this.userId), eq(tradesTable.status, "closed"), gte(tradesTable.exitTime, startOfDay)));

    const totalPnl = closedToday.reduce((sum, t) => sum + Number(t.pnl ?? 0), 0);
    const wins = closedToday.filter((t) => Number(t.pnl ?? 0) > 0).length;
    this.state.dailyPnl = totalPnl;
    this.state.totalTradesToday = closedToday.length;
    this.state.winRateToday = closedToday.length > 0 ? wins / closedToday.length : 0;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private getPairs(config: { pairs: string }): string[] {
    return config.pairs
      .split(",")
      .map((p: string) => p.trim())
      .filter(Boolean);
  }

  async loadConfig() {
    const rows = await db.select().from(botConfigTable).where(eq(botConfigTable.userId, this.userId)).limit(1);
    if (rows.length > 0) return rows[0]!;
    const [inserted] = await db.insert(botConfigTable).values({ userId: this.userId }).returning();
    return inserted!;
  }

  // ---------------------------------------------------------------------------
  // Phase 2.5: Risk alert webhook
  // ---------------------------------------------------------------------------

  /**
   * POST a risk alert to the configured Discord / Telegram / Slack webhook.
   * Supports both Discord (content) and generic JSON (text) webhook formats.
   * If alertWebhookUrl is not set, logs the alert message instead.
   */
  private async sendAlert(message: string): Promise<void> {
    try {
      const config = await this.loadConfig();
      const webhookUrl = config.alertWebhookUrl;
      if (!webhookUrl) {
        logger.warn(
          { message },
          "Risk alert: no alertWebhookUrl configured — set one in Engine Configuration to receive alerts"
        );
        return;
      }
      const response = await fetch(webhookUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ content: message, text: message }),
      });
      if (!response.ok) {
        logger.warn(
          { status: response.status, statusText: response.statusText },
          "Risk alert webhook returned non-2xx — message may not have been delivered"
        );
      } else {
        logger.info({ url: webhookUrl.replace(/\/[^/]+$/, "/***") }, "Risk alert sent to webhook");
      }
    } catch (err) {
      logger.warn({ err }, "Failed to send risk alert webhook");
    }
  }

  /**
   * Reset the risk pause state. Call this after investigating violations.
   * Exposed so a future API endpoint or manual intervention can clear it.
   */
  async resetRiskPause(): Promise<void> {
    this.riskViolationCount = 0;
    this.riskPaused = false;
    logger.info("Risk pause manually cleared — trading will resume on next scan");
    await this.persistRiskPauseState();
  }

  private async persistRiskPauseState(): Promise<void> {
    try {
      await db
        .update(botConfigTable)
        .set({ riskPaused: this.riskPaused, riskViolationCount: this.riskViolationCount })
        .where(eq(botConfigTable.userId, this.userId));
    } catch (err) {
      logger.error({ err }, "Failed to persist risk-pause state — in-memory state is still correct, but a restart before the next successful write would lose it");
    }
  }

  getRiskStatus(): { paused: boolean; violationCount: number; maxViolations: number } {
    return {
      paused:         this.riskPaused,
      violationCount: this.riskViolationCount,
      maxViolations:  this.MAX_RISK_VIOLATIONS,
    };
  }
}

export { BotEngine };
