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
  tradeAnalysesTable,
} from "@workspace/db";
import { analyzeTrade } from "./tradeAnalysis";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getBinanceCredentials } from "./binanceCredentials";
import {
  buildSignalRow,
  type MultiTimeframeCandles,
  type SignalRow,
  type MarketRegime,
  type IndicatorVote,
} from "./strategy";
import { strategySelector, computeTp1Tp2Ladder, type StrategyConfig, type PositionSide, type TradePlan } from "./strategies";
import { recordDecisions, pruneDecisions, planToRecord, rejectionToRecord, type DecisionRecord } from "./decisionRecorder";
import { DEFAULT_FEE_RATE, FUTURES_FEE_RATE } from "./tradingCosts";
import { loadStrategyConfigs } from "./strategyConfigLoader";
import { ExitManager, type OpenOrderIds } from "./exitManager";
import { TradeManager } from "./tradeManager";
import { placeSellOco, cancelOco } from "./binanceOco";
import { placeFuturesStopAndTakeProfit, closeFuturesPositionMarket, configureFuturesLeverage, getLiquidationPrice } from "./binanceFutures";
import { stopTooCloseToLiquidation, MIN_PROTECTIVE_STOP_PCT } from "./futuresMath";
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

// Keyless ccxt clients for PUBLIC market data (chart candles) — shared across
// all engines, created lazily. Used when an engine has no live authenticated
// connection of the right market type (candles need no credentials).
const publicClients: Partial<Record<"spot" | "futures", any>> = {};


function publicDataClient(marketType: "spot" | "futures"): any {
  if (!publicClients[marketType]) {
    const ExchangeClass = marketType === "futures" ? BinanceUsdmExchange : BinanceExchange;
    publicClients[marketType] = new ExchangeClass({ options: { defaultType: marketType } });
  }
  return publicClients[marketType];
}

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
  /** Last time the persistent decision journal was pruned (hourly cadence). */
  private lastDecisionPruneAt = 0;
  /** Last orphaned-stop-order sweep (10-minute cadence, futures only). */
  private lastOrphanSweepAt = 0;
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
  /** Consecutive entry-time flattens per symbol (risk-guard / stop-placement
   *  failures at birth). Without a cooldown these re-fire every scan — the
   *  observed live failure: 10 DOT entries in 5 minutes, each flattened at
   *  fill, ~$150 burned on slippage+fees alone. */
  private entryFlattenStrikes: Map<string, { count: number; lastAt: number }> = new Map();

  /**
   * High-frequency test mode, resolved fresh each scan from loadConfig()
   * (config.highFrequencyTestMode && config.testnet). When true the engine
   * relaxes its turnover-limiting gates to generate lots of trades for
   * end-to-end testing on Demo Trading. Read by getStrategyConfigs() and
   * isToxicHour(), both of which run after loadConfig() within a scan.
   */
  private highFreqActive = false;
  // Test-mode caps — deliberately aggressive so the engine actually churns.
  private readonly HF_MAX_HOLD_SECONDS = 600;      // force fast position cycling
  private readonly HF_MAX_OPEN_POSITIONS = 30;     // allow every pair open at once
  private readonly HF_MAX_CONCURRENT_PER_STRAT = 10;
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
  /** Taker fee per side for the ACTIVE market type — spot 0.1%, futures 0.05%
   *  (half). Used by ExitManager/TradeManager P&L accounting. Previously
   *  hardcoded to the spot rate, which overstated fees ~2× on every futures
   *  trade and disagreed with the backtest's futures fee. */
  private get activeTakerFee(): number {
    return this.activeMarketType === "futures" ? FUTURES_FEE_RATE : DEFAULT_FEE_RATE;
  }
  /** How many consecutive risk violations before trading is paused */
  private readonly MAX_RISK_VIOLATIONS = 3;
  private riskViolationCount = 0;
  private riskPaused = false;

  // ── Phase 4A: centralized exit pipeline ─────────────────────────────────────
  // ExitManager owns every way a trade can close; BotEngine only supplies the
  // side effects (alerts, cooldowns, hourly stats, risk-pause bookkeeping) via
  // this host interface.
  private readonly exitManager = new ExitManager({
    takerFee: () => this.activeTakerFee,
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
    onTradeClosed: (tradeId: number) => {
      // Best-effort, off the close path: generate + persist the post-trade
      // analysis into the engine's persistent memory. Never throws back.
      this.recordTradeAnalysis(tradeId).catch((err) =>
        logger.warn({ err, tradeId }, "Post-trade analysis failed"),
      );
    },
  });

  // ── Phase 4B: TP1/TP2/break-even/trailing management ────────────────────────
  // TradeManager only ever narrows risk (raises SL) or partially reduces size —
  // it never fully closes a trade; ExitManager still owns that (see above).
  private readonly tradeManager = new TradeManager({
    takerFee: () => this.activeTakerFee,
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

  /** Each instance is scoped to exactly one user — their own trades, config,
   *  strategy tuning, and Binance credentials. See lib/engineRegistry.ts for
   *  how a userId maps to its own BotEngine instance. */
  constructor(private readonly userId: number) {}

  // ---------------------------------------------------------------------------
  // Exchange initialisation
  // ---------------------------------------------------------------------------

  private async initExchange(testnet: boolean, marketType: "spot" | "futures"): Promise<any> {
    if (this.exchange) return this.exchange;
    const ex = await this.buildExchange(testnet, marketType);
    this.exchange = ex;
    return ex;
  }

  /** Construct (without caching) an exchange client for the given market
   *  type. Used by initExchange, and directly by closeTradeManually when the
   *  trade's market type differs from whatever the engine is running. */
  private async buildExchange(testnet: boolean, marketType: "spot" | "futures"): Promise<any> {
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

  /**
   * An entry was flattened AT BIRTH (risk-guard or stop-placement failure
   * after the fill). Whatever the root cause, retrying the same symbol next
   * scan is guaranteed to repeat it — and each attempt costs real slippage +
   * fees (observed live: 10 DOT entries in 5 minutes, ~$150 burned). First
   * strike: 15-minute cooldown. Repeat within an hour: 60 minutes. Returns
   * the minutes applied so the caller's reason (recorded in the decision
   * journal) carries the number.
   */
  /**
   * Cancel protective stop/TP orders that belong to NO open position —
   * "orphans". Root cause of the observed Binance -4045 "Reach max stop
   * order limit" loop: every engine restart loses the in-memory order-ID
   * map, and reconciled_missing closes leave their resting SL/TP triggers
   * on the exchange. They accumulate silently until Binance's stop-order
   * cap is full — and then every NEW entry is born unprotectable. This
   * sweep keeps the account's stop-order budget clean. Futures only.
   *
   * An order is swept only when its symbol has neither an open tracked
   * trade nor a live exchange position — protection for anything real is
   * never touched.
   */
  private async sweepOrphanedProtectiveOrders(ex: any): Promise<number> {
    try {
      const open = await db
        .select({ symbol: tradesTable.symbol })
        .from(tradesTable)
        .where(and(eq(tradesTable.userId, this.userId), eq(tradesTable.status, "open")));
      const active = new Set(open.map((t) => this.toMarket(t.symbol)));
      try {
        const positions = await ex.fetchPositions();
        for (const p of positions ?? []) {
          if (Math.abs(Number(p?.contracts ?? 0)) > 0 && p?.symbol) active.add(String(p.symbol));
        }
      } catch (posErr) {
        // Without a live position picture we can't tell orphan from real —
        // canceling a real position's stop is worse than keeping orphans.
        logger.warn({ err: posErr }, "Orphan sweep skipped — could not fetch positions");
        return 0;
      }

      const orders = await ex.fetchOpenOrders();
      let cancelled = 0;
      for (const o of orders ?? []) {
        const type = String(o?.type ?? "").toUpperCase();
        const isProtective =
          o?.reduceOnly === true || type.includes("STOP") || type.includes("TAKE_PROFIT");
        if (!isProtective || !o?.symbol || active.has(String(o.symbol))) continue;
        try {
          await ex.cancelOrder(o.id, o.symbol);
          cancelled++;
        } catch (cancelErr) {
          logger.warn({ err: cancelErr, orderId: o.id, symbol: o.symbol }, "Failed to cancel orphaned order");
        }
      }
      if (cancelled > 0) {
        logger.warn(
          { cancelled },
          "Swept orphaned protective orders — freed Binance stop-order slots (-4045 guard)",
        );
      }
      return cancelled;
    } catch (err) {
      logger.warn({ err }, "Orphan-order sweep failed");
      return 0;
    }
  }

  private cooldownAfterEntryFlatten(symbol: string, why: string): number {
    const now = Date.now();
    const prev = this.entryFlattenStrikes.get(symbol);
    const count = prev && now - prev.lastAt < 3600_000 ? prev.count + 1 : 1;
    this.entryFlattenStrikes.set(symbol, { count, lastAt: now });
    const minutes = count >= 2 ? 60 : 15;
    this.setCooldown(symbol, minutes);
    logger.warn(
      { symbol, strike: count, cooldownMinutes: minutes, why },
      "Entry flattened at birth — symbol cooled down to break the re-entry loop",
    );
    return minutes;
  }

  private async getStrategyConfigs(): Promise<Map<string, StrategyConfig>> {
    const now = Date.now();
    if (now - this.lastStrategyConfigLoad < this.STRATEGY_CONFIG_CACHE_MS && this.strategyConfigs.size > 0) {
      return this.strategyConfigs;
    }
    this.strategyConfigs = await loadStrategyConfigs(this.userId);
    this.lastStrategyConfigLoad = now;
    return this.highFreqStrategyConfigs(this.strategyConfigs);
  }

  /**
   * In high-frequency test mode, cap every strategy's max holding time so
   * positions cycle fast, drop its cooldown to zero, and widen its concurrency
   * cap — the per-strategy half of applyHighFreqOverrides(). Returns the map
   * unchanged when the mode is off. (this.highFreqActive is set by loadConfig,
   * which every scan runs before this.)
   */
  private highFreqStrategyConfigs(configs: Map<string, StrategyConfig>): Map<string, StrategyConfig> {
    if (!this.highFreqActive) return configs;
    const out = new Map<string, StrategyConfig>();
    for (const [id, cfg] of configs) {
      out.set(id, {
        ...cfg,
        maxHoldingSeconds: Math.min(cfg.maxHoldingSeconds, this.HF_MAX_HOLD_SECONDS),
        cooldownMinutes: 0,
        maxConcurrentPositions: Math.max(cfg.maxConcurrentPositions, this.HF_MAX_CONCURRENT_PER_STRAT),
      });
    }
    return out;
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

  /**
   * Recent 1m candles for the position chart (dashboard). Uses the engine's
   * LIVE exchange connection when available — the exact feed trades are
   * priced against — and falls back to a keyless public client (candles are
   * public data) so the chart still works while the engine is stopped.
   */
  async getRecentCandles(
    symbol: string,
    timeframe: string,
    limit: number,
    marketType: "spot" | "futures",
  ): Promise<Candle[]> {
    if (this.exchange && this.activeMarketType === marketType) {
      return this.exchange.fetchOHLCV(this.toMarket(symbol), timeframe, undefined, limit);
    }
    const ex = publicDataClient(marketType);
    if (!ex.markets || Object.keys(ex.markets).length === 0) {
      await ex.loadMarkets();
    }
    return ex.fetchOHLCV(unifiedFromPlainFallback(symbol, marketType), timeframe, undefined, limit);
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
    const orderStageFailures = reasons.filter((r) => r.stage === "Order");

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
    } else if (entered === 0 && orderStageFailures.length > 0) {
      // A symbol only reaches the Order stage once a strategy has already
      // produced a qualifying signal and it has cleared every risk gate — so
      // an Order-stage failure means a trade the engine WANTED to take was
      // rejected by the exchange. That is categorically more urgent than the
      // benign "no signal" reason, which is normal and always outnumbers it
      // (most symbols are signal-less on any given scan), and would otherwise
      // bury this at the bottom of a count-sorted list while the headline
      // claimed nothing was wrong. Surfaced live: every entry failed with
      // Binance -4028 for 12h while the cockpit still read "trading active".
      const worst = orderStageFailures[0]!;
      globalBlock =
        `Entries are reaching the exchange and being rejected — ` +
        `${worst.reason} (${worst.symbols.join(", ")})`;
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
      // Fetch 24h tickers for ONLY the monitored pairs.
      //
      // Why not a single fetchTickers() call on futures: ccxt's binanceusdm
      // fetchTickers ignores the symbol list entirely and calls the
      // fapiPublic /ticker/24hr endpoint with no filter — pulling the full
      // 24h stats for all ~400 USDⓈ-M markets (request weight 40, a large
      // payload) and then discarding all but our handful. Against the slow
      // demo-fapi server that heavy response was the bulk of the multi-second
      // monitor latency shown on the dashboard. Fetching each monitored
      // symbol individually (weight 1, tiny payload) in parallel sends only
      // what we actually display and cuts both the payload and the rate-limit
      // weight to the number of pairs (9, not 400). Spot's fetchTickers DOES
      // filter server-side (it forwards a symbols= array), so keep the single
      // call there — it's already minimal.
      let tickers: Record<string, any>;
      if (this.activeMarketType === "futures") {
        const results = await Promise.all(
          this.monitoredMarkets.map(async (market) => {
            try {
              return [market, await ex.fetchTicker(market)] as const;
            } catch (err) {
              logger.warn({ err, market }, "Per-symbol ticker fetch failed");
              return [market, null] as const;
            }
          }),
        );
        tickers = Object.fromEntries(results.filter((r) => r[1] != null));
      } else {
        tickers = (await ex.fetchTickers(this.monitoredMarkets)) as Record<string, any>;
      }
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

    // Persist the desired state so a server restart (update.sh / pm2 / reboot)
    // auto-resumes this engine instead of silently leaving it stopped.
    try {
      await db
        .update(botConfigTable)
        .set({ engineDesiredRunning: true })
        .where(eq(botConfigTable.userId, this.userId));
    } catch (err) {
      logger.warn({ err }, "Could not persist engine desired-running state (auto-resume after restart may not trigger)");
    }

    logger.info({ intervalMs, mode: this.state.mode }, "Bot engine started");
  }

  async stop(): Promise<void> {
    if (!this.state.running) return;
    // Clear the persisted desired state FIRST — an explicit Stop must never
    // be undone by an auto-resume on the next server restart.
    try {
      await db
        .update(botConfigTable)
        .set({ engineDesiredRunning: false })
        .where(eq(botConfigTable.userId, this.userId));
    } catch (err) {
      logger.warn({ err }, "Could not persist engine desired-running=false");
    }
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
      // Effective config for this scan = stored settings + high-frequency test
      // overrides (a no-op unless highFrequencyTestMode is on AND on testnet).
      // This also sets this.highFreqActive for getStrategyConfigs/isToxicHour.
      const config = this.applyHighFreqOverrides(await this.loadConfig());
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

      // ── Scan diagnostics accumulators ────────────────────────────────────
      // Aggregate funnel for the end-of-scan structured summary log — answers
      // "why did/didn't the engine trade this scan" at a glance, without
      // reading 700 per-symbol trace lines. signalsByStrategy counts EVERY
      // qualifying signal each strategy produced (not just the winner), so a
      // strategy that never fires is visible as an absent/zero entry.
      const signalsByStrategy: Record<string, number> = {};
      const regimeCounts: Record<string, number> = {};

      // Positions opened DURING this scan. `openTrades` is a snapshot taken at
      // scan start, so without this the per-strategy concurrency cap and the
      // portfolio-risk cap would both read stale counts — two symbols signalling
      // for the same strategy in one scan could each pass and breach the limit.
      // maxOpenPositions is already safe (it uses the live this.state counter).
      const enteredThisScan: Array<{ strategyId?: string; riskUsdt: number }> = [];
      // Decision journal for this scan: every considered-and-rejected trade
      // plus approved-but-not-taken plans. Flushed (best-effort) at scan end.
      const scanDecisions: DecisionRecord[] = [];

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
        regimeCounts[row.regime] = (regimeCounts[row.regime] ?? 0) + 1;
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
          // Per-trade deadline first ("the brains" choose their own max hold,
          // persisted on the trade at entry); legacy trades — and trades from
          // before plans existed — fall back to the strategy config, which is
          // exactly the value legacy plans persist, so behavior is unchanged.
          const planMaxHold = Number(openForSymbol.maxHoldSeconds);
          const stratMaxHold = planMaxHold > 0 ? planMaxHold : openStratConfig?.maxHoldingSeconds;
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
        // Dollar-risk context (always passed): a strategy carrying its OWN
        // trade plan (tradeAmount/maxLoss/target on the Strategies page)
        // trades the dollar model with those numbers; otherwise the global
        // dollar config applies when riskModel = "dollar"; otherwise legacy
        // %-based behavior. Same resolution the backtest uses (parity).
        const dollarRisk = {
          marketType: config.marketType as "spot" | "futures",
          leverage: config.marketType === "futures" ? Math.max(1, config.leverage) : 1,
          feeRate: this.activeTakerFee,
          globalTradeAmountUsdt: Number(config.positionSizeUsdt),
          ...(config.riskModel === "dollar" && {
            globalMaxLossUsdt: Number(config.maxLossUsdt),
            globalTargetProfitUsdt: Number(config.targetProfitUsdt),
          }),
        };
        const { plans, rejections } = strategySelector.decideSymbol(
          symbol, mtf, row, strategyConfigs, balance, notionalCapUsdt, dollarRisk
        );
        // Considered-and-rejected trades are first-class output now — queue
        // them for the persistent decision journal (flushed once per scan).
        for (const r of rejections) scanDecisions.push(rejectionToRecord(r));
        // Spot has no short-selling mechanism (buy-to-open is the only way to
        // enter) — strategies always evaluate both directions, so filter out
        // short signals here rather than duplicating a market-type check into
        // all 6 strategy files.
        let signals = plans;
        if (config.marketType !== "futures") {
          signals = signals.filter((s) => s.side === "long");
        }
        for (const s of signals) {
          signalsByStrategy[s.strategyId] = (signalsByStrategy[s.strategyId] ?? 0) + 1;
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

        // ── Fair per-strategy allocation ─────────────────────────────────────
        // Every enabled strategy evaluates this symbol independently; the
        // selector already returned their qualifying signals sorted by
        // confidence. Rather than only ever considering the single best one —
        // which let a dominant strategy at its concurrency cap BLOCK the whole
        // symbol and starve the others of trades/data — walk the list and take
        // the highest-confidence signal whose OWN strategy still has budget and
        // a valid size. Only one position per symbol is possible (futures
        // one-way mode), so this fairly hands the symbol to the best strategy
        // that can actually act, instead of skipping the symbol entirely.
        let bestSignal: (typeof signals)[number] | undefined;
        let stratConfig: StrategyConfig | undefined;
        let stratOpenCount = 0;
        let maxConcurrent = 0;
        const cappedStrategies: string[] = [];
        for (const cand of signals) {
          const cfg = strategyConfigs.get(cand.strategyId);
          const openCount =
            openTrades.filter((t) => t.strategyId === cand.strategyId).length +
            enteredThisScan.filter((e) => e.strategyId === cand.strategyId).length;
          const maxC = cfg?.maxConcurrentPositions ?? 2;
          if (openCount >= maxC) {
            cappedStrategies.push(cand.strategyName);
            scanDecisions.push(planToRecord(cand, "approved_not_taken", {
              stage: "Strategy Concurrency",
              reason: `${openCount}/${maxC} positions already open for ${cand.strategyName}`,
            }));
            continue;
          }
          if (!(cand.qty > 0)) continue;
          bestSignal = cand; stratConfig = cfg; stratOpenCount = openCount; maxConcurrent = maxC;
          break;
        }

        if (!bestSignal) {
          // Every strategy that signalled this symbol is at its own concurrency
          // cap (or couldn't be sized) — nothing to do, but say which.
          const reason = cappedStrategies.length > 0
            ? `All signalling strategies at their concurrency cap (${[...new Set(cappedStrategies)].join(", ")})`
            : "No signal could be sized (insufficient balance for min order size)";
          this.scannerData.set(symbol, { ...row, status: "skipped" });
          signalStage.status = "pass";
          signalStage.detail = `${signals.length} signal(s), none actionable — ${reason}`;
          riskStage.status = "fail";
          riskStage.detail = `Blocked: ${reason}`;
          record("BLOCKED", "Risk Checks", reason, signals[0]!.confidence);
          continue;
        }

        signalStage.status = "pass";
        signalStage.detail = `${bestSignal.strategyName} signal @ ${bestSignal.confidence.toFixed(0)}% — ${bestSignal.report.summary}`;
        signalStage.data = {
          strategyId: bestSignal.strategyId, strategyName: bestSignal.strategyName,
          confidence: bestSignal.confidence, regime: bestSignal.regime, entryReason: bestSignal.report.summary,
          netRewardRisk: bestSignal.netRewardRisk, plannedLeverage: bestSignal.leverage,
        };
        preChecks.push(
          { name: "Strategy Concurrency", passed: true, detail: `${stratOpenCount}/${maxConcurrent} open for ${bestSignal.strategyName}` },
          { name: "Position Size", passed: true, detail: `Qty ${bestSignal.qty}` },
        );

        // Portfolio risk check (maxPortfolioRiskPercent): aggregate $ risk
        // across every open position — using each trade's CURRENT stop, since
        // break-even/trailing moves change the real worst-case loss over a
        // position's life — plus this candidate's own risk, capped against a
        // % of balance. maxOpenPositions above only caps a position COUNT;
        // this is the only check that caps actual dollar exposure.
        const existingRiskUsdt =
          openTrades.reduce((sum, t) => {
            const qty = Number(t.remainingQuantity ?? t.quantity);
            return sum + Math.abs(Number(t.entryPrice) - Number(t.stopLoss)) * qty;
          }, 0) +
          // Include risk from positions opened earlier in this same scan.
          enteredThisScan.reduce((sum, e) => sum + e.riskUsdt, 0);
        const candidateRiskUsdt = Math.abs(bestSignal.entryPrice - bestSignal.slPrice) * bestSignal.qty;
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
          scanDecisions.push(planToRecord(bestSignal, "approved_not_taken", {
            stage: "Portfolio Risk",
            reason: `aggregate risk $${(existingRiskUsdt + candidateRiskUsdt).toFixed(2)} would exceed the $${maxPortfolioRiskUsdt.toFixed(2)} cap`,
          }));
          continue;
        }

        riskStage.status = "pass";
        riskStage.detail = "All risk checks passed";

        logger.info(
          {
            symbol, strategyId: bestSignal.strategyId, confidence: bestSignal.confidence,
            regime: bestSignal.regime, reason: bestSignal.report.summary,
            plannedLeverage: bestSignal.leverage, stratOpenCount, maxConcurrent,
          },
          "Strategy signal — evaluating entry"
        );

        // ── Stage 5: Order — execute the strategy's approved TradePlan ──────
        const { entered, reason } = await this.enterTrade(
          symbol, row, bestSignal, config, now, stratConfig,
        );
        if (entered) {
          this.state.openPositions++;
          // Track for the same-scan concurrency + portfolio-risk accounting above.
          enteredThisScan.push({ strategyId: bestSignal.strategyId, riskUsdt: candidateRiskUsdt });
        }
        this.scannerData.set(symbol, {
          ...row,
          status: entered ? "entered" : "skipped",
          strategyId: bestSignal.strategyId,
          strategyName: bestSignal.strategyName,
          entryReason: bestSignal.report.summary,
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
          scanDecisions.push(planToRecord(bestSignal, "approved_not_taken", {
            stage: "Order",
            reason,
          }));
        }
      }

      // ── End-of-scan structured funnel summary ────────────────────────────
      // ONE line per scan that shows the whole pipeline: how many symbols were
      // scanned, the regime split, how many signals each strategy produced,
      // and — for every symbol that did NOT enter — the exact stage+reason it
      // was blocked (tallied from the per-symbol decision trace). This is the
      // primary "why isn't it trading?" diagnostic: if `entered` is 0 for
      // hours, this line names the culprit (e.g. all "range" regime so the
      // trend strategies never fired, or every candidate on cooldown).
      const decisions = Array.from(this.symbolDecisions.values());
      const entered = decisions.filter((d) => d.finalDecision === "ENTERED").length;
      const blockedBy: Record<string, number> = {};
      for (const d of decisions) {
        if (d.finalDecision === "ENTERED") continue;
        const key = `${d.blockStage ?? "?"}: ${d.blockReason ?? "unknown"}`;
        blockedBy[key] = (blockedBy[key] ?? 0) + 1;
      }
      const totalSignals = Object.values(signalsByStrategy).reduce((a, b) => a + b, 0);
      const topReason = Object.entries(blockedBy).sort((a, b) => b[1] - a[1])[0];
      const topBlock = topReason ? `${topReason[0]} (${topReason[1]})` : "none";
      logger.info(
        {
          scanId: now.toISOString(),
          marketType: this.activeMarketType,
          symbolsScanned: pairs.length,
          symbolsEvaluated: decisions.length,
          openPositions: this.state.openPositions,
          maxOpenPositions: config.maxOpenPositions,
          regimeCounts,
          signalsByStrategy,
          totalSignals,
          entered,
          blockedBy,
          circuitBreakerActive: this.state.circuitBreakerActive,
          riskPaused: this.riskPaused,
        },
        `SCAN_SUMMARY — ${pairs.length} scanned · ${totalSignals} signals · ${entered} entered` +
          (entered === 0 ? ` · TOP BLOCK: ${topBlock}` : ""),
      );

      // Flush the decision journal (fire-and-forget — never blocks the scan)
      // and prune old rows roughly hourly.
      if (scanDecisions.length > 0) {
        void recordDecisions(this.userId, scanDecisions).catch(() => {});
      }
      if (Date.now() - this.lastDecisionPruneAt > 3600_000) {
        this.lastDecisionPruneAt = Date.now();
        void pruneDecisions(this.userId).catch(() => {});
      }
      // Keep the Binance stop-order budget clean (see -4045 self-heal in
      // enterTrade) — orphans also accumulate silently between entries.
      if (config.marketType === "futures" && this.exchange && Date.now() - this.lastOrphanSweepAt > 600_000) {
        this.lastOrphanSweepAt = Date.now();
        void this.sweepOrphanedProtectiveOrders(this.exchange).catch(() => {});
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

  /**
   * Execute a strategy's approved TradePlan. The engine is the hands, not the
   * brain: everything about the trade (entry, stop, target, size, leverage,
   * hold window) was decided by the strategy — this method only enforces
   * physical invariants (exchange minimums, margin sufficiency, protective-
   * stop placeability, liquidation buffer) and places the orders.
   */
  private async enterTrade(
    symbol: string,
    row: SignalRow,
    plan: TradePlan,
    config: Awaited<ReturnType<typeof this.loadConfig>>,
    now: Date,
    stratConfig?: StrategyConfig,
  ): Promise<{ entered: boolean; reason: string }> {
    const ex = this.exchange!;
    const market = this.toMarket(symbol);
    const side = plan.side;
    const strategyId: string | undefined = plan.strategyId;
    const strategyName: string | undefined = plan.strategyName;
    const entry = { entryPrice: plan.entryPrice, slPrice: plan.slPrice, tpPrice: plan.tpPrice, qty: plan.qty };
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
      let qty = parseFloat(ex.amountToPrecision(market, rawQty));
      // The PLAN's leverage — chosen by the strategy (≤ the user's cap), not
      // the raw account setting. Legacy-adapter plans carry the account value
      // so historical behavior is unchanged.
      let effectiveLeverage = plan.leverage;

      if (isFutures) {
        // Leverage/margin mode must be set on the exchange before the order
        // — Binance rejects an order whose implied notional exceeds what the
        // account's CURRENT leverage for this symbol allows. Binance also
        // caps leverage per symbol (varies widely by pair), so the
        // planned value may get clamped down — use whatever was actually
        // applied for everything below, not the requested value.
        effectiveLeverage = await configureFuturesLeverage(
          ex, market, plan.leverage, config.marginMode === "cross" ? "cross" : "isolated",
        );

        // Sizing was computed as notional = margin budget × PLANNED
        // leverage. If this symbol clamped leverage down (e.g. 70x → 25x on
        // INJ), keeping that notional would require notional/effectiveLev of
        // margin — silently overspending the user's per-trade budget. Scale
        // the quantity down proportionally instead: margin stays within
        // budget, and the dollar risk/target shrink in the same proportion
        // (always ≤ planned — the safe direction).
        if (effectiveLeverage < plan.leverage && plan.leverage > 0) {
          const scaled = qty * (effectiveLeverage / plan.leverage);
          const rescaledQty = parseFloat(ex.amountToPrecision(market, scaled));
          logger.info(
            { symbol, plannedLeverage: plan.leverage, effectiveLeverage, qty, rescaledQty },
            "Leverage clamped for this symbol — position scaled down to keep margin within the per-trade budget",
          );
          qty = rescaledQty;
          if (!(qty > 0)) {
            return { entered: false, reason: `Position too small after leverage clamp (${plan.leverage}x → ${effectiveLeverage}x)` };
          }
        }

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

      // ── Protective-stop placeability guard (futures) ─────────────────────
      // A STOP_MARKET whose trigger sits too close to the mark price is
      // rejected by Binance ("would immediately trigger" / PERCENT_PRICE
      // filter). If we fill first and only then discover the stop won't place,
      // the position is either flattened immediately (a wasted fee round-trip,
      // recorded emergency_stop) or slips through unprotected and gets
      // liquidated between scans (recorded reconciled_missing) — BOTH observed
      // live at 50x, where a $50 stop on ~$15k notional is only ~0.23% away.
      // Refuse the entry BEFORE filling when the stop distance is below the
      // minimum that reliably places. Raising leverage shrinks this distance,
      // so this is also the concrete reason very high leverage can't trade a
      // fixed-dollar stop: there's no room to place it.
      if (isFutures) {
        const stopDistPct = entry.entryPrice > 0
          ? (Math.abs(entry.entryPrice - entry.slPrice) / entry.entryPrice) * 100
          : 0;
        if (stopDistPct < MIN_PROTECTIVE_STOP_PCT) {
          logger.warn(
            { symbol, side, stopDistPct: stopDistPct.toFixed(3), min: MIN_PROTECTIVE_STOP_PCT, effectiveLeverage },
            "Stop-loss too close to entry to place a protective order — refusing entry (lower leverage or widen the stop)",
          );
          return {
            entered: false,
            reason: `Stop is only ${stopDistPct.toFixed(2)}% from entry — too tight to place a protective order at ${effectiveLeverage}x (min ${MIN_PROTECTIVE_STOP_PCT}%). Lower leverage or widen the stop.`,
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
        const why = liquidationIsUnsafe
          ? "stop-loss too close to the exchange's liquidation price"
          : "computed SL/TP invalid after fill";
        const cooled = this.cooldownAfterEntryFlatten(symbol, why);
        return {
          entered: false,
          reason: `Risk guard: ${why} — position closed immediately; symbol cooled down ${cooled}m to break the re-entry loop`,
        };
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

      // RELIABILITY: the market order above ALREADY FILLED — a position now
      // exists on the exchange. If this DB write fails, the engine has an
      // untracked position it can neither protect (place SL/TP) nor exit, and
      // it would only be discovered on the next startup reconcile. Rather than
      // leave an orphaned, unprotected position, flatten it immediately —
      // mirroring the SL/TP risk-guard above — and surface it to the user.
      let trade: typeof tradesTable.$inferSelect | undefined;
      try {
        [trade] = await db
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
            // Decision engine: the complete plan + its reasoning, verbatim —
            // the "why" behind this trade, for the Decisions feed and the
            // post-trade post-mortem.
            entryReason: plan.report.summary,
            tradePlan: plan,
            expectedHoldSeconds: Math.round(plan.expectedHoldSeconds),
            maxHoldSeconds: Math.round(plan.maxHoldSeconds),
            plannedLeverage: plan.leverage,
          })
          .returning();
      } catch (dbErr) {
        logger.error({ err: dbErr, symbol, filledQty },
          "DB insert failed after fill — closing the untracked position to protect capital");
        try {
          const closeQty = parseFloat(ex.amountToPrecision(market, filledQty));
          const closeParams = isFutures ? { reduceOnly: true } : undefined;
          await ex.createOrder(market, "market", closeSide, closeQty, undefined, closeParams);
        } catch (closeErr) {
          logger.error({ err: closeErr, symbol, filledQty },
            "Failed to close untracked position after DB failure — MANUAL INTERVENTION REQUIRED");
        }
        this.sendAlert(
          `🚨 ${side.toUpperCase()} ${symbol} filled at ${fillPrice.toFixed(6)} but could NOT be recorded ` +
          `(database error). The engine attempted to close it immediately. Please verify on Binance that no ` +
          `position remains open.`,
        ).catch(() => {});
        return { entered: false, reason: "Order filled but DB write failed — position closed to avoid an untracked/unprotected position" };
      }

      let tpOrderId = "";
      let slOrderId = "";
      let ocoOrderListId = "";

      if (isFutures) {
        // Futures Phase: no atomic OCO exists on USDⓈ-M Futures — always two
        // independent reduceOnly orders (STOP_MARKET + TAKE_PROFIT_MARKET).
        // ExitManager already treats a missing ocoOrderListId as "cancel the
        // other leg on fill" (its independent-orders fallback path for spot),
        // which is exactly correct here too — no changes needed there.
        let result = await placeFuturesStopAndTakeProfit(ex, market, openSide, filledQty, slPrice, tpPrice);
        if (!result) {
          // Self-heal for Binance -4045 "Reach max stop order limit": orphaned
          // stop orders (from restarts / reconciled positions) can exhaust the
          // account's stop-order budget, making every new position
          // unprotectable. Sweep the orphans and retry ONCE before giving up
          // — observed live turning a flatten-loop day into normal trading.
          const swept = await this.sweepOrphanedProtectiveOrders(ex);
          if (swept > 0) {
            logger.warn(
              { symbol, swept },
              "Protective placement failed — retrying after sweeping orphaned stop orders",
            );
            result = await placeFuturesStopAndTakeProfit(ex, market, openSide, filledQty, slPrice, tpPrice);
          }
        }
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

      // RISK RULE: no stop, no position. A filled position whose STOP-LOSS
      // could not be placed on the exchange has unbounded downside the moment
      // the engine stops or lags — the software price-monitor only runs while
      // the scan loop does. The old behavior (alert + software monitoring)
      // was observed failing live: a position whose protection was missing
      // sat unmonitored for 3 days after the engine went offline and blew
      // ~5× past its planned risk. Now the position is flattened immediately
      // (through the same validated close path, so the record and post-trade
      // analysis are still written), and the entry reports why.
      if (!slOrderId) {
        logger.error(
          { tradeId: trade!.id, symbol, tpOrderId: tpOrderId || "none" },
          "STOP-LOSS placement failed after fill — flattening immediately (no stop, no position)",
        );
        const outcome = await this.exitManager.closeManually(
          ex, trade!, market, now, Number(config.cooldownMinutes), "emergency_stop",
          { tpOrderId, slOrderId: "", ...(ocoOrderListId && { ocoOrderListId }) },
        );
        this.openOrderIds.delete(trade!.id);
        this.sendAlert(
          `🚨 ${side.toUpperCase()} ${symbol} filled at ${fillPrice.toFixed(6)} but the exchange STOP-LOSS could not ` +
          `be placed. Position was ${outcome.closed ? "flattened immediately (no stop, no position)" : "NOT closed — close it manually on Binance NOW"}.`,
        ).catch((e) => logger.warn({ err: e, tradeId: trade!.id }, "Failed to send stop-not-placed alert"));
        const cooled = this.cooldownAfterEntryFlatten(symbol, "protective stop-loss placement failed");
        return {
          entered: false,
          reason: outcome.closed
            ? `Stop-loss placement failed — position flattened immediately (no stop, no position); symbol cooled down ${cooled}m to break the re-entry loop`
            : `Stop-loss placement failed AND the protective flatten failed — manual intervention required; symbol cooled down ${cooled}m`,
        };
      }

      // Journal the executed decision with its trade link (best-effort).
      void recordDecisions(this.userId, [
        planToRecord(plan, "executed", { tradeId: trade!.id }),
      ]).catch(() => {});

      return {
        entered: true,
        reason: bothPlaced
          ? `market ${openSide.toUpperCase()} filled, TP + SL protection placed`
          : neitherPlaced
            ? `market ${openSide.toUpperCase()} filled, price-based exit monitoring (TP/SL orders failed)`
            : `market ${openSide.toUpperCase()} filled, partial exchange protection`,
      };
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      // Binance -2027: "Exceeded the maximum allowable position at current
      // leverage" — the exchange's per-symbol position cap for the account's
      // leverage bracket is full. Retrying next scan is guaranteed to fail
      // identically until a position on this symbol closes (or leverage is
      // lowered), and observed live it re-fired the same doomed order every
      // scan for 10+ minutes. Put the SYMBOL on a short cooldown so the engine
      // spends those scans on coins it can actually trade. The condition
      // clears when positions cycle, so keep the cooldown modest.
      if (message.includes('"code":-2027') || message.includes("-2027")) {
        this.setCooldown(symbol, 10);
        logger.warn(
          { symbol, leverage: config.leverage },
          "Entry rejected by exchange position cap (-2027) — symbol on 10m cooldown. " +
            "Lowering leverage raises Binance's per-symbol position limit.",
        );
        return {
          entered: false,
          reason: `Exchange position cap at ${config.leverage}x leverage (Binance -2027) — symbol cooled down 10m; lower leverage to raise the cap`,
        };
      }
      logger.error({ err, symbol }, "Failed to enter trade");
      return { entered: false, reason: `Order placement failed: ${message}` };
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
          const outcome = await this.exitManager.closeManually(ex, trade, market, now, cooldownMinutes, "emergency_stop", orderIds);
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

  /**
   * User-initiated close of ONE open trade (the "Close" button on the
   * dashboard). Funnels through ExitManager.closeManually — the same
   * cancel-legs → market-close → validated-write path as the emergency
   * flatten — so a manual close gets the identical audit trail (fees,
   * slippage, risk audit, post-trade analysis). Works even when the engine
   * is stopped: the exchange connection is initialized on demand, since a
   * user must always be able to flatten a position the bot opened.
   */
  async closeTradeManually(tradeId: number): Promise<{ ok: boolean; error?: string; exitPrice?: number; pnl?: number }> {
    const [trade] = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.id, tradeId), eq(tradesTable.userId, this.userId)));
    if (!trade) return { ok: false, error: "Trade not found" };
    if (trade.status !== "open") return { ok: false, error: "Trade is already closed" };

    try {
      const config = await this.loadConfig();
      const tradeMarketType = trade.marketType === "futures" ? "futures" : "spot";
      // Use the engine's live connection when it matches the trade's market;
      // otherwise build a DEDICATED client for this close. Never reuse a spot
      // client to close a futures trade (or vice versa), and never mutate the
      // engine's own activeMarketType/exchange for a one-off user action.
      const ex = this.exchange && this.activeMarketType === tradeMarketType
        ? this.exchange
        : await this.buildExchange(config.testnet, tradeMarketType);
      // Precision helpers inside the close path need market metadata; a
      // freshly created on-demand connection hasn't loaded it yet.
      if (!ex.markets || Object.keys(ex.markets).length === 0) {
        await ex.loadMarkets();
      }
      // symbolMaps was built for the engine's ACTIVE market type — only valid
      // here when the trade is on that same market; otherwise use the
      // format-rule fallback for the trade's own market type.
      const market = this.exchange && this.activeMarketType === tradeMarketType
        ? this.toMarket(trade.symbol)
        : unifiedFromPlainFallback(trade.symbol, tradeMarketType);
      const orderIds = this.openOrderIds.get(trade.id);
      const outcome = await this.exitManager.closeManually(
        ex, trade, market, new Date(), Number(config.cooldownMinutes), "manual", orderIds,
      );
      if (!outcome.closed) {
        return { ok: false, error: "Close order could not be executed — check the exchange and try again" };
      }
      this.openOrderIds.delete(trade.id);
      this.state.openPositions = Math.max(0, this.state.openPositions - 1);
      logger.info({ tradeId, symbol: trade.symbol, exitPrice: outcome.exitPrice, pnl: outcome.pnl }, "Trade closed manually by user");
      return { ok: true, exitPrice: outcome.exitPrice ?? undefined, pnl: outcome.pnl ?? undefined };
    } catch (err) {
      logger.error({ err, tradeId }, "Manual close failed");
      return { ok: false, error: String((err as Error)?.message ?? err) };
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

      // Verify each DB-open trade is actually backed by the exchange, in the
      // market-appropriate way: spot positions live in the wallet balance;
      // futures positions are margin-backed and tracked via fetchPositions.
      // The futures check was previously MISSING entirely ("skip straight to
      // re-placing resting orders") — so a futures position that closed or
      // was LIQUIDATED while the bot was down stayed "open" in the DB
      // forever, un-closeable (every reduceOnly close for it is rejected)
      // and re-alerting as "unprotected" on every restart. Observed live.
      let balance: any;
      if (marketType === "spot") {
        try {
          balance = await ex.fetchBalance();
        } catch (err) {
          logger.error({ err }, "Startup reconciliation: fetchBalance failed — cannot verify open trades against the exchange this cycle; will retry protective-order recovery only, using tracked quantities");
        }
      }
      let futuresPositions: any[] | null = null;
      if (marketType === "futures") {
        try {
          futuresPositions = await ex.fetchPositions();
        } catch (err) {
          logger.error({ err }, "Startup reconciliation: fetchPositions failed — cannot verify futures trades against the exchange this cycle; will retry protective-order recovery only");
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

        if (futuresPositions && trade.marketType === "futures") {
          const live = futuresPositions.find(
            (p) => p.symbol === market && Math.abs(Number(p.contracts ?? 0)) > 0,
          );
          if (!live) {
            await this.reconcileMissingPosition(trade, market, trackedQty, 0);
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
      // Fetch a few extra rows so administrative reconciliations (not real
      // outcomes — see ExitManager.closeTrade) can be filtered out while
      // still judging a full 10 genuine trades.
      const recentAll = await db
        .select()
        .from(tradesTable)
        .where(and(eq(tradesTable.userId, this.userId), eq(tradesTable.symbol, symbol), eq(tradesTable.status, "closed")))
        .orderBy(desc(tradesTable.exitTime))
        .limit(15);
      const recent = recentAll.filter((t) => t.exitReason !== "reconciled_missing").slice(0, 10);

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
    // Test mode wants volume above all — never sit out an hour.
    if (this.highFreqActive) return false;
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

  /**
   * Post-trade analysis → persistent memory. Re-reads the just-closed trade row
   * (so it sees the final written exit values), runs the deterministic,
   * evidence-based analyzer, and upserts the structured report into
   * trade_analyses. Purely derived from recorded facts — no fabrication.
   */
  private async recordTradeAnalysis(tradeId: number): Promise<void> {
    const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, tradeId)).limit(1);
    if (!trade || trade.status === "open") return;
    const a = analyzeTrade(trade);
    await db
      .insert(tradeAnalysesTable)
      .values({
        userId: this.userId,
        tradeId,
        outcome: a.outcome,
        rMultiple: a.rMultiple != null ? a.rMultiple.toFixed(4) : null,
        grade: a.grade,
        findings: JSON.stringify(a.findings),
        summary: a.summary,
      })
      .onConflictDoUpdate({
        target: [tradeAnalysesTable.userId, tradeAnalysesTable.tradeId],
        set: {
          outcome: a.outcome,
          rMultiple: a.rMultiple != null ? a.rMultiple.toFixed(4) : null,
          grade: a.grade,
          findings: JSON.stringify(a.findings),
          summary: a.summary,
        },
      });
    logger.info({ tradeId, outcome: a.outcome, grade: a.grade, rMultiple: a.rMultiple }, "Post-trade analysis recorded");
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
    const closedTodayAll = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.userId, this.userId), eq(tradesTable.status, "closed"), gte(tradesTable.exitTime, startOfDay)));

    // Administrative reconciliations (positions that actually died days ago,
    // swept into the books today) are NOT today's trading performance — if
    // they counted, sweeping a batch of stale liquidations would trip the
    // daily-loss circuit breaker and freeze real trading for the whole day.
    const closedToday = closedTodayAll.filter((t) => t.exitReason !== "reconciled_missing");

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

  /**
   * Raw config row — the user's stored settings, no test-mode overrides. Routes
   * (GET/PUT /config) MUST use this so the UI edits real values. The scan path
   * calls applyHighFreqOverrides() on top of this to get the effective config.
   */
  async loadConfig() {
    const rows = await db.select().from(botConfigTable).where(eq(botConfigTable.userId, this.userId)).limit(1);
    if (rows.length > 0) return rows[0]!;
    const [inserted] = await db.insert(botConfigTable).values({ userId: this.userId }).returning();
    return inserted!;
  }

  /**
   * High-frequency TEST mode (Demo Trading only). Real-money keys never take
   * this path — it is gated on `testnet` so it is impossible to churn a live
   * account. When active, override the config fields that throttle trade
   * volume so the live engine produces enough trades/day to surface bugs and
   * generate data. Called at the top of each scan; per-strategy holding time /
   * cooldown / concurrency are handled in getStrategyConfigs(); toxic-hour
   * skips in isToxicHour(). Both read this.highFreqActive, which this sets.
   */
  private applyHighFreqOverrides<T extends typeof botConfigTable.$inferSelect>(row: T): T {
    this.highFreqActive = row.highFrequencyTestMode && row.testnet;
    if (!this.highFreqActive) return row;
    return {
      ...row,
      cooldownMinutes: 0,                    // re-enter a symbol immediately after exit
      confidenceThreshold: 0,                // take every signal, weak ones included
      maxOpenPositions: this.HF_MAX_OPEN_POSITIONS,
      dailyLossLimitUsdt: "1000000000",      // circuit breaker effectively off
    };
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
