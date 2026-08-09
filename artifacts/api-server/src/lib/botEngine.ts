/**
 * TradeCore Pro â€” Bot Engine  (Phase 2 Multi-Strategy Engine)
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
} from "ccxt";
import { db } from "@workspace/db";
import {
  tradesTable,
  botConfigTable,
  blacklistTable,
  hourlyStatsTable,
  tradePartialExitsTable,
  tradeAnalysesTable,
  notificationsTable,
} from "@workspace/db";
import { analyzeTrade } from "./tradeAnalysis";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getBinanceCredentials } from "./binanceCredentials";
import { getOandaCredentials } from "./oandaCredentials";
import { OandaAdapter } from "./brokers/oandaAdapter";
import type { MarketType } from "./brokers/brokerAdapter";
import { buildBinanceClient } from "./brokers/binanceClient";
import { actionableConnectionError } from "./brokers/connectionTest";
import {
  buildSignalRow,
  type MultiTimeframeCandles,
  type SignalRow,
  type MarketRegime,
  type IndicatorVote,
} from "./strategy";
import { strategySelector, strategiesForSection, computeTp1Tp2Ladder, type StrategyConfig, type PositionSide, type TradePlan } from "./strategies";
import { recordDecisions, pruneDecisions, planToRecord, rejectionToRecord, type DecisionRecord } from "./decisionRecorder";
import { DEFAULT_FEE_RATE, FUTURES_FEE_RATE, FOREX_COST_RATE, DEFAULT_SLIPPAGE_RATE, FOREX_SLIPPAGE_RATE } from "./tradingCosts";
import { requiredMarginUsd, minStopDistancePrice } from "./forexSizing";
import { isInstrumentOpen, nextInstrumentOpen, instrumentClassOf, type InstrumentClass } from "./marketHours";
import { loadStrategyConfigs } from "./strategyConfigLoader";
import { loadCustomStrategies, liveEligible } from "./customStrategyLoader";
import type { Strategy } from "./strategies";
import { ExitManager, type OpenOrderIds } from "./exitManager";
import type { ExecutionResult, TradeExecutor } from "./execution/executor";
import { LiveExecutor, ResearchExecutor } from "./execution/liveExecutor";
import { DemoExecutor } from "./execution/demoExecutor";
import { expireStaleRecommendations, RecommendExecutor } from "./execution/recommendExecutor";
import { simulateDemoExit } from "./execution/demoExit";
import { buildDemoMarketData } from "./execution/demoMarketData";
import type { FillCosts } from "./execution/fillModel";
import { advanceIntent, attachTrade, openIntent, type IntentHandle } from "./execution/intentLog";
import {
  buildHeatMap, correlation, dailyLogReturns, evaluateCorrelation, validateSizing,
  MIN_CORRELATION_OBSERVATIONS, type HeatMapCell,
} from "./risk/portfolioRisk";
import { planFingerprint } from "./plan/fingerprint";
import { evaluateInfluence } from "./memory/influence";
import { loadMemoryPermission, logInfluence } from "./memory/memoryState";
import {
  captureDecisions, configVersionOf, recordScanCounters,
  type CaptureDecision, type CaptureSnapshot,
} from "./capture/captureLog";
import type { Section } from "./engineRegistry";
import { TradeManager } from "./tradeManager";
import { placeSellOco, cancelOco } from "./binanceOco";
import { placeFuturesStopAndTakeProfit, closeFuturesPositionMarket, configureFuturesLeverage, getLiquidationPrice } from "./binanceFutures";
import { stopTooCloseToLiquidation, MIN_PROTECTIVE_STOP_PCT } from "./futuresMath";
import { buildDailyReport, formatDailyReportText } from "./dailyReport";
import {
  buildSymbolMarketMaps,
  supportsShortEntries,
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
import { buildMarketStateResult } from "./intelligence/market-state/builder";
import type { MarketStateResult } from "./intelligence/market-state/types";
import { buildSpecialistCouncilSnapshot, type SpecialistCouncilSnapshot } from "./intelligence/specialists";
import { recordSpecialistOpinions } from "./intelligence/specialists/store";
import { DecisionCouncil, type ShadowCouncilRun } from "./intelligence/council";
import { approvedHistoricalEvidence } from "./intelligence/evidence";
import {
  assemblePortfolioProjection,
  type PairCorrelationInput,
  type PortfolioIntelligenceProjection,
  type PortfolioPositionInput,
} from "./intelligence/portfolio";
import { recordShadowCouncilRun } from "./intelligence/council/store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ccxt OHLCV candle: [timestamp, open, high, low, close, volume]
type Candle = [number, number, number, number, number, number];

// Keyless ccxt clients for PUBLIC market data (chart candles) â€” shared across
// all engines, created lazily. Used when an engine has no live authenticated
// connection of the right market type (candles need no credentials).
const publicClients: Partial<Record<"spot" | "futures", any>> = {};


/** Normalize the DB's free-text marketType column to the typed union. */
function toMarketType(raw: string): MarketType {
  return raw === "futures" ? "futures" : raw === "forex" ? "forex" : "spot";
}

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
  /** Futures Phase: long or short â€” undefined until a strategy signal exists for this symbol. */
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
  /** False means existing positions are still managed, but no new Live order
   * may be submitted until broker/database/protection state reconciles. */
  newEntriesAllowed: boolean;
  entryBlockReason: string | null;
  mode: "live" | "testnet" | "backtest";
  startedAt: string | null;
  lastScanAt: string | null;
}

// In-memory order tracking: tradeDbId â†’ { tpOrderId, slOrderId }
// (OpenOrderIds is defined in ./exitManager â€” the single consumer of this
// shape besides the map declaration below â€” so both stay in sync.)

// ---------------------------------------------------------------------------
// BotEngine singleton
// ---------------------------------------------------------------------------

class BotEngine {
  // Futures Phase: spot (`binance`) and futures (`binanceusdm`) are distinct
  // ccxt exchange classes with slightly different method surfaces (e.g. only
  // futures has fetchPositions/setLeverage) â€” typed loosely here, matching
  // the existing `ex: any` convention already used throughout
  // ExitManager/TradeManager's host callbacks for the same reason.
  private exchange: any = null;
  /** Identity of the cached provider client. Configuration is re-read every
   * scan, so the cache must be keyed by every value that selects an endpoint
   * or credential source; otherwise Demo can retain a Live client. */
  private exchangeIdentity: string | null = null;
  private availableMarkets: Set<string> = new Set();
  /** Exact DB-symbol âŸ· unified-symbol maps, built from loadMarkets() at start(). */
  private symbolMaps: SymbolMarketMaps | null = null;
  /** Market type of the ACTIVE exchange connection (set at start()). */
  private activeMarketType: MarketType = "spot";
  private scannerData: Map<string, ScannerRow> = new Map();
  /** Phase 2 observational state; never read by strategy, risk, or execution. */
  private marketStates: Map<string, MarketStateResult> = new Map();
  /** Phase 3 specialist opinions translated from the unchanged Brain V0 outputs. */
  private specialistCouncils: Map<string, SpecialistCouncilSnapshot> = new Map();
  /** Phase 4 remains observational and has no executor or broker dependency. */
  private shadowCouncilRuns: Map<string, ShadowCouncilRun> = new Map();
  private readonly decisionCouncil = new DecisionCouncil();
  /** Bounded process-local guard; database constraints remain the durable dedupe. */
  private readonly capturedShadowRunIds = new Set<string>();
  private openOrderIds: Map<number, OpenOrderIds> = new Map();

  // â”€â”€ Correlation inputs (P6) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  /**
   * Daily log returns per symbol, keyed by UTC day. Cached because these are
   * DAILY numbers read on a 15-second scan loop: recomputing per scan would
   * mean thousands of pointless candle fetches a day and would not fit the
   * scan budget. A stale-by-an-hour correlation is still an honest
   * correlation â€” the underlying series only gains one point per day.
   */
  private dailyReturnsCache: Map<string, { at: number; returns: Map<number, number> }> = new Map();
  private static readonly CORRELATION_CACHE_TTL_MS = 60 * 60_000;
  /** Days of history requested for correlation (30 returns needs 31 closes). */
  private static readonly CORRELATION_LOOKBACK_DAYS = 31;

  // â”€â”€ Verification surfaces: decision trace + live market monitor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // Symbol cooldowns: symbol â†’ expiry timestamp (ms)
  private symbolCooldowns: Map<string, number> = new Map();
  /** Consecutive entry-time flattens per symbol (risk-guard / stop-placement
   *  failures at birth). Without a cooldown these re-fire every scan â€” the
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
  // Test-mode caps â€” deliberately aggressive so the engine actually churns.
  private readonly HF_MAX_HOLD_SECONDS = 600;      // force fast position cycling
  private readonly HF_MAX_OPEN_POSITIONS = 30;     // allow every pair open at once
  private readonly HF_MAX_CONCURRENT_PER_STRAT = 10;
  /** Last resolved market regime per symbol â€” feeds regime hysteresis so the
   *  regime (and thus which strategies are eligible) can't flip every 15s
   *  scan tick on a metric hovering at a threshold. See detectMarketRegime. */
  private lastRegime: Map<string, MarketRegime> = new Map();
  /** UTC day ("YYYY-MM-DD") the scan loop last saw â€” a change triggers the
   *  daily-report webhook push for the day that just ended. */
  private lastDailyReportDate: string | null = null;

  // Single-flight guard: prevents overlapping scan executions
  private scanning = false;
  /** Deduplicates concurrent Start requests while provider setup is in flight. */
  private startPromise: Promise<void> | null = null;
  /** Resolved when the active scan releases all provider references. */
  private scanIdleWaiters: Array<() => void> = [];
  /** Prevent timer callbacks from starting while a connection mutation is
   * quiescing the engine. */
  private connectionSuspended = false;
  /** Serializes credential/config-driven reconnects for this engine. */
  private connectionMutation: Promise<void> = Promise.resolve();
  private lastReconciliationAttemptAt = 0;
  private readonly RECONCILIATION_RETRY_MS = 60_000;

  private notifyProviderWorkIdle(): void {
    if (this.scanning || this.tickerPolling) return;
    const waiters = this.scanIdleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private waitForProviderWorkIdle(): Promise<void> {
    if (!this.scanning && !this.tickerPolling) return Promise.resolve();
    return new Promise((resolve) => this.scanIdleWaiters.push(resolve));
  }

  // Cached account balance for risk-based position sizing
  private cachedBalance = 0;
  private lastBalanceFetch = 0;
  private readonly BALANCE_CACHE_MS = 60_000;

  // Strategy config cache (60-second TTL)
  private strategyConfigs: Map<string, StrategyConfig> = new Map();
  private lastStrategyConfigLoad = 0;
  private rëvîÚ$z{-®éÜj×ÖF6†–ærÆ—fRFF&6RG&FR&Vf÷&P¢¢÷Væ–ærF†RVçG'’vFRâF†—2FVÆ–&W&FVÇ’&VgW6W2FòWFòÖF÷BÖçVÂ÷ ¢¢Ö&–wV÷W6Ç’W'6—7FVB÷6—F–öç2â¢ğ¢&—fFR7–æ2FWFV7EVçG&6¶VDFW&—fF—fU÷6—F–öç2€¢÷VåG&FW3¢‡G—VöbG&FW5F&ÆRâF–æfW%6VÆV7B•µÒÀ¢“¢&öÖ—6SÇfö–Câ°¢6öç7B÷6—F–öç3¢ç•µÒÒv—BF†—2æW†6†ævRæfWF6…÷6—F–öç2‚“°¢6öç7BG&6¶VE7–Ö&öÇ2ÒæWr6WB†÷VåG&FW2æÖ‚‡G&FR’ÓâG&FRç7–Ö&öÂ’“°¢6öç7BVçG&6¶VBÒ÷6—F–öç2æf–ÇFW"‚‡÷6—F–öâ’Óâ°¢–b„ÖF‚æ'2„çVÖ&W"‡÷6—F–öâæ6öçG&7G2óò’’ÃÒ’&WGW&âfÇ6S°¢6öç7B7–Ö&öÂÒF†—2æg&öÔÖ&¶WB…7G&–ær‡÷6—F–öâç7–Ö&öÂ’“°¢&WGW&âG&6¶VE7–Ö&öÇ2æ†2‡7–Ö&öÂ“°¢Ò“°¢–b‡VçG&6¶VBæÆVæwF‚ÓÓÒ’&WGW&ã° ¢ÆövvW"æW'&÷"€¢²÷6—F–öç3¢VçG&6¶VBæÖ‚‡÷6—F–öâ’Óâ‡²7–Ö&öÃ¢÷6—F–öâç7–Ö&öÂÂ6öçG&7G3¢÷6—F–öâæ6öçG&7G2Ò’’ÒÀ¢%$T4ôä4”ÄUõTåE$4´TC¢W†6†ævR†2gWGW&W2÷6—F–öç2'6VçBg&öÒF†RFF&6R"À¢“°¢v—BF†—2ç6VæDÆW'B€¢	ùª‚$T4ôä4”Ä”D”ôã¢&–ææ6RgWGW&W2†2G·VçG&6¶VBæÆVæwF‡Ò÷6—F–öâ‡2’v—F‚æòÖF6†–ærG&FT6÷&RFF&6R&V6÷&Bâ°¢$æWrVçG&–W2&R&Æö6¶VC²&Wf–WrF†RW†6†ævRÖçVÆÇ’v†–ÆRW†—7F–ærG&6¶VB÷6—F–öç2&VÖ–âÖævVBâ"À¢“°¢F‡&÷ræWrW'&÷"‚%VçG&6¶VBgWGW&W2÷6—F–öç2&WV—&RÖçVÂ&V6öæ6–Æ–F–öâ"“°¢Ğ Ğ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞĞ¢òòFF—fRÆV&æ–æpĞ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞĞ Ğ¢&—fFR7–æ2WFFT&Æ6¶Æ—7B€Ğ¢—'3¢7G&–æuµÒÀĞ¢æ÷s¢FFRÀĞ¢Ç&VG”&Æ6¶Æ—7FVC¢6WCÇ7G&–æsâÀĞ¢“¢&öÖ—6SÇfö–Câ°Ğ¢f÷"†6öç7B7–Ö&öÂöb—'2’°Ğ¢òòfWF6‚fWrW‡G&&÷w26òFÖ–æ—7G&F—fR&V6öæ6–Æ–F–öç2†æ÷B&VÀĞ¢òò÷WF6öÖW2(	B6VRW†—DÖævW"æ6Æ÷6UG&FR’6â&Rf–ÇFW&VB÷WBv†–ÆPĞ¢òò7F–ÆÂ§VFv–ærgVÆÂvVçV–æRG&FW2àĞ¢6öç7B&V6VçDÆÂÒv—BF Ğ¢ç6VÆV7B‚Ğ¢æg&öÒ‡G&FW5F&ÆRĞ¢çv†W&R†æB†W‡G&FW5F&ÆRçW6W$–BÂF†—2çW6W$–B’ÂW‡G&FW5F&ÆRç6V7F–öâÂF†—2ç6V7F–öâ’ÂW‡G&FW5F&ÆRç7–Ö&öÂÂ7–Ö&öÂ’ÂW‡G&FW5F&ÆRç7FGW2Â&6Æ÷6VB"’’Ğ¢æ÷&FW$'’†FW62‡G&FW5F&ÆRæW†—EF–ÖR’Ğ¢æÆ–Ö—BƒR“°Ğ¢6öç7B&V6VçBÒ&V6VçDÆÂæf–ÇFW"‚‡B’ÓâBæW†—E&V6öâÓÒ'&V6öæ6–ÆVEöÖ—76–ær"’ç6Æ–6RƒÂ“°Ğ Ğ¢–b‡&V6VçBæÆVæwF‚Â’6öçF–çVS°Ğ Ğ¢6öç7Bv–ç2Ò&V6VçBæf–ÇFW"‚‡B’ÓâçVÖ&W"‡BçæÂóò’â’æÆVæwFƒ°Ğ¢6öç7Bv–å&FRÒv–ç2ò&V6VçBæÆVæwFƒ°Ğ Ğ¢–b‡v–å&FRÂãB’°Ğ¢6öç7BW‡—&W4BÒæWrFFR†æ÷rævWEF–ÖR‚’²#B¢c¢c¢“°Ğ¢v—BF Ğ¢æ–ç6W'B†&Æ6¶Æ—7EF&ÆRĞ¢çfÇVW2‡²W6W$–C¢F†—2çW6W$–BÂ6V7F–öã¢F†—2ç6V7F–öâÂ7–Ö&öÂÂv–å&FS¢v–å&FRçFôf—†VBƒB’ÂG&FT6÷VçC¢&V6VçBæÆVæwF‚Â&Æ6¶Æ—7FVDC¢æ÷rÂW‡—&W4BÒĞ¢æöä6öæfÆ–7DFõWFFR‡°Ğ¢F&vWC¢¶&Æ6¶Æ—7EF&ÆRçW6W$–BÂ&Æ6¶Æ—7EF&ÆRç6V7F–öâÂ&Æ6¶Æ—7EF&ÆRç7–Ö&öÅÒÀĞ¢6WC¢²v–å&FS¢v–å&FRçFôf—†VBƒB’ÂG&FT6÷VçC¢&V6VçBæÆVæwF‚Â&Æ6¶Æ—7FVDC¢æ÷rÂW‡—&W4BÒÀĞ¢Ò“°Ğ¢òòöæÇ’Æörv†VâF†R7–Ö&öÂ—2æWvÇ’&Æ6¶Æ—7FVB(	Bæ÷BöâWfW'’R×6V6öæB66âF–6°Ğ¢–b‚Ç&VG”&Æ6¶Æ—7FVBæ†2‡7–Ö&öÂ’’°Ğ¢ÆövvW"çv&â‡²7–Ö&öÂÂv–å&FRÒÂ%7–Ö&öÂ&Æ6¶Æ—7FVBf÷"#F‚"“°Ğ¢ĞĞ¢ĞĞ¢ĞĞ¢ĞĞ Ğ¢&—fFR7–æ2ÆöD7F—fT&Æ6¶Æ—7B†æ÷s¢FFR“¢&öÖ—6SÅ6WCÇ7G&–æsãâ°Ğ¢6öç7B&÷w2Òv—BF Ğ¢ç6VÆV7B‚Ğ¢æg&öÒ†&Æ6¶Æ—7EF&ÆRĞ¢çv†W&R†æB†W†&Æ6¶Æ—7EF&ÆRçW6W$–BÂF†—2çW6W$–B’ÂW†&Æ6¶Æ—7EF&ÆRç6V7F–öâÂF†—2ç6V7F–öâ’ÂwFR†&Æ6¶Æ—7EF&ÆRæW‡—&W4BÂæ÷r’’“°Ğ¢&WGW&âæWr6WB‡&÷w2æÖ‚‡"’Óâ"ç7–Ö&öÂ’“°Ğ¢ĞĞ Ğ¢&—fFR7–æ2—5F÷†–4†÷W"††÷W#¢çVÖ&W"“¢&öÖ—6SÆ&ööÆVãâ°Ğ¢òòFW7BÖöFRvçG2föÇVÖR&÷fRÆÂ(	BæWfW"6—B÷WBâ†÷W"àĞ¢–b‡F†—2æ†–v„g&W7F—fR’&WGW&âfÇ6S°Ğ¢6öç7BF‡&VTF—4vòÒæWrFFR„FFRææ÷r‚’Ò2¢#B¢c¢c¢’çFô•4õ7G&–ær‚’ç7Æ—B‚%B"•³Ò°Ğ¢6öç7B&÷w2Òv—BF Ğ¢ç6VÆV7B‚Ğ¢æg&öÒ††÷W&Ç•7FG5F&ÆRĞ¢çv†W&R†æB€Ğ¢W††÷W&Ç•7FG5F&ÆRçW6W$–BÂF†—2çW6W$–B’ÀĞ¢W††÷W&Ç•7FG5F&ÆRç6V7F–öâÂF†—2ç6V7F–öâ’ÀĞ¢W††÷W&Ç•7FG5F&ÆRæ†÷W"Â†÷W"’ÀĞ¢wFR††÷W&Ç•7FG5F&ÆRæFFRÂF‡&VTF—4vò’ÀĞ¢’“°Ğ¢–b‡&÷w2æÆVæwF‚ÓÓÒ’&WGW&âfÇ6S°Ğ¢&WGW&â&÷w2ç&VGV6R‚‡7VÒÂ"’Óâ7VÒ²çVÖ&W"‡"çæÂ’Â’Â°Ğ¢ĞĞ Ğ¢ò¢ Ğ¢¢÷7B×G&FRæÇ—6—2(i"W'6—7FVçBÖVÖ÷'’â&R×&VG2F†R§W7BÖ6Æ÷6VBG&FR&÷pĞ¢¢‡6ò—B6VW2F†Rf–æÂw&—GFVâW†—BfÇVW2’Â'Vç2F†RFWFW&Ö–æ—7F–2ÀĞ¢¢Wf–FVæ6RÖ&6VBæÇ—¦W"ÂæBW6W'G2F†R7G'V7GW&VB&W÷'B–çFğĞ¢¢G&FUöæÇ—6W2âW&VÇ’FW&—fVBg&öÒ&V6÷&FVBf7G2(	Bæòf'&–6F–öâàĞ¢¢ğĞ¢&—fFR7–æ2&V6÷&EG&FTæÇ—6—2‡G&FT–C¢çVÖ&W"“¢&öÖ—6SÇfö–Câ°Ğ¢6öç7B·G&FUÒÒv—BF"ç6VÆV7B‚’æg&öÒ‡G&FW5F&ÆR’çv†W&R†W‡G&FW5F&ÆRæ–BÂG&FT–B’’æÆ–Ö—Bƒ“°Ğ¢–b‚G&FRÇÂG&FRç7FGW2ÓÓÒ&÷Vâ"’&WGW&ã°Ğ¢6öç7BÒæÇ—¦UG&FR‡G&FR“°Ğ¢v—BF Ğ¢æ–ç6W'B‡G&FTæÇ—6W5F&ÆRĞ¢çfÇVW2‡°Ğ¢W6W$–C¢F†—2çW6W$–BÀĞ¢G&FT–BÀĞ¢÷WF6öÖS¢æ÷WF6öÖRÀĞ¢$×VÇF—ÆS¢ç$×VÇF—ÆRÒçVÆÂòç$×VÇF—ÆRçFôf—†VBƒB’¢çVÆÂÀĞ¢w&FS¢æw&FRÀĞ¢f–æF–æw3¢¥4ôâç7G&–æv–g’†æf–æF–æw2’ÀĞ¢7VÖÖ'“¢ç7VÖÖ'’ÀĞ¢ÒĞ¢æöä6öæfÆ–7DFõWFFR‡°Ğ¢F&vWC¢·G&FTæÇ—6W5F&ÆRçW6W$–BÂG&FTæÇ—6W5F&ÆRçG&FT–EÒÀĞ¢6WC¢°Ğ¢÷WF6öÖS¢æ÷WF6öÖRÀĞ¢$×VÇF—ÆS¢ç$×VÇF—ÆRÒçVÆÂòç$×VÇF—ÆRçFôf—†VBƒB’¢çVÆÂÀĞ¢w&FS¢æw&FRÀĞ¢f–æF–æw3¢¥4ôâç7G&–æv–g’†æf–æF–æw2’ÀĞ¢7VÖÖ'“¢ç7VÖÖ'’ÀĞ¢ÒÀĞ¢Ò“°Ğ¢ÆövvW"æ–æfò‡²G&FT–BÂ÷WF6öÖS¢æ÷WF6öÖRÂw&FS¢æw&FRÂ$×VÇF—ÆS¢ç$×VÇF—ÆRÒÂ%÷7B×G&FRæÇ—6—2&V6÷&FVB"“°Ğ¢ĞĞ Ğ¢&—fFR7–æ2&V6÷&D†÷W&Ç•7FB†æ÷s¢FFRÂæÃ¢çVÖ&W"Âv–ã¢&ööÆVâ“¢&öÖ—6SÇfö–Câ°Ğ¢6öç7BFFRÒæ÷rçFô•4õ7G&–ær‚’ç7Æ—B‚%B"•³Ò°Ğ¢6öç7B†÷W"Òæ÷rævWEUD4†÷W'2‚“°Ğ¢v—BF"æW†V7WFR€Ğ¢7Æ”å4U%B”åDò†÷W&Ç•÷7FG2‡W6W%ö–BÂ6V7F–öâÂFFRÂ†÷W"ÂæÂÂG&FUö6÷VçBÂv–åö6÷VçBĞ¢dÅTU2‚G·F†—2çW6W$–GÒÂG·F†—2ç6V7F–öçÒÂG¶FFWÒÂG¶†÷W'ÒÂG·æÇÒÂÂG·v–âò¢ÒĞ¢ôâ4ôädÄ”5B‡W6W%ö–BÂ6V7F–öâÂFFRÂ†÷W"Ğ¢DòUDDR4U@Ğ¢æÂÒ†÷W&Ç•÷7FG2çæÂ²U„4ÅTDTBçæÂÀĞ¢G&FUö6÷VçBÒ†÷W&Ç•÷7FG2çG&FUö6÷VçB²ÀĞ¢v–åö6÷VçBÒ†÷W&Ç•÷7FG2çv–åö6÷VçB²U„4ÅTDTBçv–åö6÷VçBÀĞ¢WFFVEöBÒæ÷r‚– Ğ¢“°Ğ¢ĞĞ Ğ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞĞ¢òòF–Ç’7FFR&Vg&W6€Ğ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞĞ Ğ¢&—fFR7–æ2&Vg&W6„F–Ç•7FFR†æ÷s¢FFR“¢&öÖ—6SÇfö–Câ°Ğ¢6öç7B7F'DödF’ÒæWrFFR†æ÷rçFô•4õ7G&–ær‚’ç7Æ—B‚%B"•³Ò²%C££¢"“°Ğ¢6öç7B6Æ÷6VEFöF”ÆÂÒv—BF Ğ¢ç6VÆV7B‚Ğ¢æg&öÒ‡G&FW5F&ÆRĞ¢çv†W&R†æB†W‡G&FW5F&ÆRçW6W$–BÂF†—2çW6W$–B’ÂW‡G&FW5F&ÆRç6V7F–öâÂF†—2ç6V7F–öâ’ÂW‡G&FW5F&ÆRç7FGW2Â&6Æ÷6VB"’ÂwFR‡G&FW5F&ÆRæW†—EF–ÖRÂ7F'DödF’’’“°Ğ Ğ¢òòFÖ–æ—7G&F—fR&V6öæ6–Æ–F–öç2‡÷6—F–öç2F†B7GVÆÇ’F–VBF—2vòÀĞ¢òò7vWB–çFòF†R&öö·2FöF’’&RäõBFöF’w2G&F–ærW&f÷&Öæ6R(	B–`Ğ¢òòF†W’6÷VçFVBÂ7vVW–ær&F6‚öb7FÆRÆ—V–FF–öç2v÷VÆBG&—F†PĞ¢òòF–Ç’ÖÆ÷726—&7V—B'&V¶W"æBg&VW¦R&VÂG&F–ærf÷"F†Rv†öÆRF’àĞ¢6öç7B6Æ÷6VEFöF’Ò6Æ÷6VEFöF”ÆÂæf–ÇFW"‚‡B’ÓâBæW†—E&V6öâÓÒ'&V6öæ6–ÆVEöÖ—76–ær"“°Ğ Ğ¢6öç7BF÷FÅæÂÒ6Æ÷6VEFöF’ç&VGV6R‚‡7VÒÂB’Óâ7VÒ²çVÖ&W"‡BçæÂóò’Â“°Ğ¢6öç7Bv–ç2Ò6Æ÷6VEFöF’æf–ÇFW"‚‡B’ÓâçVÖ&W"‡BçæÂóò’â’æÆVæwFƒ°Ğ¢F†—2ç7FFRæF–Ç•æÂÒF÷FÅæÃ°Ğ¢F†—2ç7FFRçF÷FÅG&FW5FöF’Ò6Æ÷6VEFöF’æÆVæwFƒ°Ğ¢F†—2ç7FFRçv–å&FUFöF’Ò6Æ÷6VEFöF’æÆVæwF‚âòv–ç2ò6Æ÷6VEFöF’æÆVæwF‚¢°Ğ¢ĞĞ Ğ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞĞ¢òò†VÇW'0Ğ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞĞ Ğ¢&—fFRvWE—'2†6öæf–s¢²—'3¢7G&–ærÒ“¢7G&–æuµÒ°Ğ¢&WGW&â6öæf–rç—'0Ğ¢ç7Æ—B‚"Â"Ğ¢æÖ‚‡¢7G&–ær’ÓâçG&–Ò‚’Ğ¢æf–ÇFW"„&ööÆVâ“°Ğ¢ĞĞ Ğ¢ò¢ Ğ¢¢&r6öæf–r&÷r(	BF†RW6W"w27F÷&VB6WGF–æw2ÂæòFW7BÖÖöFR÷fW'&–FW2â&÷WFW0Ğ¢¢„tUBõUBö6öæf–r’ÕU5BW6RF†—26òF†RT’VF—G2&VÂfÇVW2âF†R66âF€Ğ¢¢6ÆÇ2Ç”†–v„g&W÷fW'&–FW2‚’öâF÷öbF†—2FòvWBF†RVffV7F—fR6öæf–ràĞ¢¢ğĞ¢7–æ2ÆöD6öæf–r‚’°Ğ¢6öç7B&÷w2Òv—BF Ğ¢ç6VÆV7B‚Ğ¢æg&öÒ†&÷D6öæf–uF&ÆRĞ¢çv†W&R†æB†W†&÷D6öæf–uF&ÆRçW6W$–BÂF†—2çW6W$–B’ÂW†&÷D6öæf–uF&ÆRç6V7F–öâÂF†—2ç6V7F–öâ’’Ğ¢æÆ–Ö—Bƒ“°Ğ¢–b‡&÷w2æÆVæwF‚â’&WGW&â&÷w5³Ò°Ğ¢6öç7B¶–ç6W'FVEÒÒv—BF Ğ¢æ–ç6W'B†&÷D6öæf–uF&ÆRĞ¢çfÇVW2‡°Ğ¢W6W$–C¢F†—2çW6W$–BÀĞ¢6V7F–öã¢F†—2ç6V7F–öâÀĞ¢òòF†Rf÷&W‚6V7F–öâ—2ôäDöf÷&W‚g&öÒ&—'F‚(	Bv—F†÷WBF†—2Âg&W6€Ğ¢òòf÷&W‚6öæf–rv÷VÆB–æ†W&—BF†R6öÇVÖâFVfVÇG2†&–ææ6R÷7÷B’æ@Ğ¢òòF†RVæv–æRv÷VÆBG'’FòG&FR&–ææ6Rg&öÒF†Rf÷&W‚F"àĞ¢'&ö¶W#¢F†—2ç6V7F–öâÓÓÒ&f÷&W‚"ò&öæF"¢&&–ææ6R"ÀĞ¢âââ‡F†—2ç6V7F–öâÓÓÒ&f÷&W‚"bb²Ö&¶WEG—S¢&f÷&W‚"Â—'3¢$UU%õU4BÄt%õU4BÄTEõU4BÄå¤EõU4BÅ„UõU4B"Ò’ÀĞ¢òòäUr6V7F–öâ7F'G2–âF†RFVÖò6–×VÆF–öâÂ6òâ66÷VçB6âG&FPĞ¢òòv—F†–âÖ–çWFW2öb6–væ–ærWæB&V6†–ær&VÂÖöæW’—2FVÆ–&W&FPĞ¢òò7FW&F†W"F†âF†RöæÇ’÷F–öââF†R4ôÅTÔâFVfVÇB7F—2&Æ—fR"öàĞ¢òòW'÷6R(	BF†Bv÷fW&ç2&6¶f–ÆÂöb&RÖW†—7F–ær&÷w2ÂæBæö&öG’v†ğĞ¢òòv2Ç&VG’G&F–ærf÷"&VÂvWG26–ÆVçFÇ’Ö÷fVBFòW"àĞ¢W†V7WF–öåF&vWC¢&FVÖò"ÀĞ¢òòæB–â6òÕ–Æ÷C¢æWr66÷VçB6VW2F†RVæv–æRw2&V6öæ–æræ@Ğ¢òòFV6–FW2f÷"—G6VÆb&Vf÷&RF†RVæv–æR—2G'W7FVBFò7BÆöæRâF†PĞ¢òò4ôÅTÔâFVfVÇB7F—2&WF÷–Æ÷B"6òW†—7F–ær&÷w2¶VWF†R&V†f–÷W Ğ¢òòF†W’Ç&VG’†BàĞ¢ÖöFS¢&6÷–Æ÷B"ÀĞ¢òòf÷&W‚&7F–6R66÷VçG2&R6öçfVçF–öæÆÇ’×V6‚Æ&vW"F†â7'—FğĞ¢òòöæW3²Ö—'&÷'2F†R&Ææ6W2F†R&VBÖöæÇ’6†÷w&ööÒFVÖòF—7Æ—2àĞ¢FVÖõ7F'F–æt&Ææ6UW6GC¢F†—2ç6V7F–öâÓÓÒ&f÷&W‚"ò#"¢#"ÀĞ¢òò6ÖR&6¶f–ÆÂ×g2Ö7&VF–öâ7Æ—B2F†RGvò&÷fS¢F†R4ôÅTÔâFVfVÇ@Ğ¢òò—2G'VV6ò&RÖW†—7F–ær&÷w2¶VWF†V—"F"Âv†–ÆR&÷r7&VFV@Ğ¢òò†W&R—2ÖW&VÇ’6–FRVffV7Böb6öÖWF†–ær&VF–ærF†—26V7F–öâw0Ğ¢òò6öæf–r(	B÷Væ–ærFBÖ&¶WBæB&6¶–ær÷WBÆæG2W†7FÇ’†W&R(	Bæ@Ğ¢òò×W7Bæ÷B6÷VçB2F†RW6W"†f–ær6†÷6VâF†—2Ö&¶WBâw&—F–ær6öæf–pĞ¢òò…UBö6öæf–r’÷"7F'F–ærF†RVæv–æR—2v†BÖ¶W2—B&VÂàĞ¢7F—fFVC¢fÇ6RÀĞ¢ÒĞ¢ç&WGW&æ–ær‚“°Ğ¢&WGW&â–ç6W'FVB°Ğ¢ĞĞ Ğ¢ò¢ Ğ¢¢†–v‚Ög&WVVæ7’DU5BÖöFR„FVÖòG&F–æröæÇ’’â&VÂÖÖöæW’¶W—2æWfW"F¶PĞ¢¢F†—2F‚(	B—B—2vFVBöâFW7FæWF6ò—B—2–×÷76–&ÆRFò6‡W&âÆ—fPĞ¢¢66÷VçBâv†Vâ7F—fRÂ÷fW'&–FRF†R6öæf–rf–VÆG2F†BF‡&÷GFÆRG&FPĞ¢¢föÇVÖR6òF†RÆ—fRVæv–æR&öGV6W2Væ÷Vv‚G&FW2öF’Fò7W&f6R'Vw2æ@Ğ¢¢vVæW&FRFFâ6ÆÆVBBF†RF÷öbV6‚66ã²W"×7G&FVw’†öÆF–ærF–ÖRğĞ¢¢6ööÆF÷vâò6öæ7W'&Væ7’&R†æFÆVB–âvWE7G&FVw”6öæf–w2‚“²F÷†–2Ö†÷W Ğ¢¢6¶—2–â—5F÷†–4†÷W"‚’â&÷F‚&VBF†—2æ†–v„g&W7F—fRÂv†–6‚F†—26WG2àĞ¢¢ğĞ¢&—fFRÇ”†–v„g&W÷fW'&–FW3ÅBW‡FVæG2G—Vöb&÷D6öæf–uF&ÆRâF–æfW%6VÆV7Câ‡&÷s¢B“¢B°Ğ¢F†—2æ†–v„g&W7F—fRÒ&÷ræ†–v„g&WVVæ7•FW7DÖöFRbb&÷rçFW7FæWC°Ğ¢–b‚F†—2æ†–v„g&W7F—fR’&WGW&â&÷s°Ğ¢&WGW&â°Ğ¢ââç&÷rÀĞ¢6ööÆF÷väÖ–çWFW3¢Âòò&RÖVçFW"7–Ö&öÂ–ÖÖVF–FVÇ’gFW"W†—@Ğ¢6öæf–FVæ6UF‡&W6†öÆC¢ÂòòF¶RWfW'’6–væÂÂvV²öæW2–æ6ÇVFV@Ğ¢Ö„÷Vå÷6—F–öç3¢F†—2ä„eôÔ…ôõTåõõ4•D”ôå2ÀĞ¢F–Ç”Æ÷74Æ–Ö—EW6GC¢#"Âòò6—&7V—B'&V¶W"VffV7F—fVÇ’öf`Ğ¢Ó°Ğ¢ĞĞ Ğ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞĞ¢òò†6R"ãS¢&—6²ÆW'BvV&†öö°Ğ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞĞ Ğ¢ò¢ Ğ¢¢õ5B&—6²ÆW'BFòF†R6öæf–wW&VBF—66÷&BòFVÆVw&Òò6Æ6²vV&†öö²ÀĞ¢¢äBW'6—7B—B2â–âÖæ÷F–f–6F–öâ(	BF†RvV&†öö²—2÷BÖ–àĞ¢¢‡&WV—&W26öæf–wW&VBU$Â’æBV7’FòÖ—726WGF–ærW²F†R–âÖ Ğ¢¢6÷’ÖVç2WfW'’W6W"6VW2F†RÆW'BöâF†V—"æW‡BF6†&ö&Bf—6—@Ğ¢¢&Vv&FÆW72âöæR6†ö¶Wö–çBÂWfW'’ÆW'BÇ&VG’fÆ÷w2F‡&÷Vv‚—BàĞ¢¢7W÷'G2&÷F‚F—66÷&B†6öçFVçB’æBvVæW&–2¥4ôâ‡FW‡B’vV&†öö²f÷&ÖG2àĞ¢¢–bÆW'EvV&†ööµW&Â—2æ÷B6WBÂÆöw2F†RÆW'BÖW76vR–ç7FVBàĞ¢¢ğĞ¢&—fFR7–æ26VæDÆW'B†ÖW76vS¢7G&–ær“¢&öÖ—6SÇfö–Câ°Ğ¢F"æ–ç6W'B†æ÷F–f–6F–öç5F&ÆRĞ¢çfÇVW2‡²W6W$–C¢F†—2çW6W$–BÂ6V7F–öã¢F†—2ç6V7F–öâÂÖW76vRÒĞ¢æ6F6‚‚†W'"’ÓâÆövvW"çv&â‡²W'"ÒÂ$f–ÆVBFòW'6—7B–âÖæ÷F–f–6F–öâ†æöâÖfFÂ’"’“°Ğ Ğ¢G'’°Ğ¢6öç7B6öæf–rÒv—BF†—2æÆöD6öæf–r‚“°Ğ¢6öç7BvV&†ööµW&ÂÒ6öæf–ræÆW'EvV&†ööµW&Ã°Ğ¢–b‚vV&†ööµW&Â’°Ğ¢ÆövvW"çv&â€Ğ¢²ÖW76vRÒÀĞ¢%&—6²ÆW'C¢æòÆW'EvV&†ööµW&Â6öæf–wW&VB(	B6WBöæR–âVæv–æR6öæf–wW&F–öâFò&V6V—fRÆW'G2 Ğ¢“°Ğ¢&WGW&ã°Ğ¢ĞĞ¢6öç7B&W7öç6RÒv—BfWF6‚‡vV&†ööµW&ÂÂ°Ğ¢ÖWF†öC¢%õ5B"ÀĞ¢†VFW'3¢²$6öçFVçBÕG—R#¢&Æ–6F–öâö§6öâ"ÒÀĞ¢&öG“¢¥4ôâç7G&–æv–g’‡²6öçFVçC¢ÖW76vRÂFW‡C¢ÖW76vRÒ’ÀĞ¢Ò“°Ğ¢–b‚&W7öç6Ræö²’°Ğ¢ÆövvW"çv&â€Ğ¢²7FGW3¢&W7öç6Rç7FGW2Â7FGW5FW‡C¢&W7öç6Rç7FGW5FW‡BÒÀĞ¢%&—6²ÆW'BvV&†öö²&WGW&æVBæöâÓ'‡‚(	BÖW76vRÖ’æ÷B†fR&VVâFVÆ—fW&VB Ğ¢“°Ğ¢ÒVÇ6R°Ğ¢ÆövvW"æ–æfò‡²W&Ã¢vV&†ööµW&Âç&WÆ6R‚õÂõµâõÒ²BòÂ"ò¢¢¢"’ÒÂ%&—6²ÆW'B6VçBFòvV&†öö²"“°Ğ¢ĞĞ¢Ò6F6‚†W'"’°Ğ¢ÆövvW"çv&â‡²W'"ÒÂ$f–ÆVBFò6VæB&—6²ÆW'BvV&†öö²"“°Ğ¢ĞĞ¢ĞĞ Ğ¢ò¢ Ğ¢¢&W6WBF†R&—6²W6R7FFRâ6ÆÂF†—2gFW"–çfW7F–vF–ærf–öÆF–öç2àĞ¢¢W‡÷6VB6ògWGW&R’VæGö–çB÷"ÖçVÂ–çFW'fVçF–öâ6â6ÆV"—BàĞ¢¢ğĞ¢7–æ2&W6WE&—6µW6R‚“¢&öÖ—6SÇfö–Câ°Ğ¢F†—2ç&—6µf–öÆF–öä6÷VçBÒ°Ğ¢F†—2ç&—6µW6VBÒfÇ6S°Ğ¢ÆövvW"æ–æfò‚%&—6²W6RÖçVÆÇ’6ÆV&VB(	BG&F–ærv–ÆÂ&W7VÖRöâæW‡B66â"“°Ğ¢v—BF†—2çW'6—7E&—6µW6U7FFR‚“°Ğ¢ĞĞ Ğ¢&—fFR7–æ2W'6—7E&—6µW6U7FFR‚“¢&öÖ—6SÇfö–Câ°Ğ¢G'’°Ğ¢v—BF Ğ¢çWFFR†&÷D6öæf–uF&ÆRĞ¢ç6WB‡²&—6µW6VC¢F†—2ç&—6µW6VBÂ&—6µf–öÆF–öä6÷VçC¢F†—2ç&—6µf–öÆF–öä6÷VçBÒĞ¢çv†W&R†æB†W†&÷D6öæf–uF&ÆRçW6W$–BÂF†—2çW6W$–B’ÂW†&÷D6öæf–uF&ÆRç6V7F–öâÂF†—2ç6V7F–öâ’’“°Ğ¢Ò6F6‚†W'"’°Ğ¢ÆövvW"æW'&÷"‡²W'"ÒÂ$f–ÆVBFòW'6—7B&—6²×W6R7FFR(	B–âÖÖVÖ÷'’7FFR—27F–ÆÂ6÷'&V7BÂ'WB&W7F'B&Vf÷&RF†RæW‡B7V66W76gVÂw&—FRv÷VÆBÆ÷6R—B"“°Ğ¢ĞĞ¢ĞĞ Ğ¢vWE&—6µ7FGW2‚“¢²W6VC¢&ööÆVã²f–öÆF–öä6÷VçC¢çVÖ&W#²Ö…f–öÆF–öç3¢çVÖ&W"Ò°Ğ¢&WGW&â°Ğ¢W6VC¢F†—2ç&—6µW6VBÀĞ¢f–öÆF–öä6÷VçC¢F†—2ç&—6µf–öÆF–öä6÷VçBÀĞ¢Ö…f–öÆF–öç3¢F†—2äÔ…õ$•4µõd”ôÄD”ôå2ÀĞ¢Ó°Ğ¢ĞĞ§ĞĞ Ğ¦W‡÷'B²&÷DVæv–æRÓ°Ğ