/**
 * TradeCore Pro — Backtest Engine  (Phase 1 Professional Engine)
 *
 * Replays historical candles using the EXACT same strategy logic as the live
 * BotEngine — buildSignalRow from strategy.ts + the same per-strategy
 * evaluate() functions (strategies/*.ts) the live engine uses.
 *
 * Key improvements over legacy engine:
 * - 5-timeframe support (1m / 3m / 5m / 15m / 1h) derived from 1m history.
 *   The selected timeframe controls entry cadence; exits run every minute.
 * - Extended warmup buffer (3 days minimum) ensures EMA50(1h) is valid.
 * - Risk-based position sizing when params.riskPercent > 0.
 * - All symbols in a single chronological event stream for portfolio-correct
 *   balance, circuit-breaker, and open-position state.
 */

import { db } from "@workspace/db";
import {
  backtestRunsTable,
  backtestTradesTable,
  backtestTradePartialExitsTable,
  equityCurveTable,
  customStrategiesTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  buildSignalRow,
  type Candle,
  type MultiTimeframeCandles,
  type MarketRegime,
} from "./strategy";
import { strategySelector, computeTp1Tp2Ladder, type StrategyConfig, type PositionSide } from "./strategies";
import {
  manageBar, settleBar, updateExcursion,
  type BarContext, type FillCosts, type PartialExitRecord, type SimulatedPosition,
} from "./execution/fillModel";
import {
  expectancyPerTrade,
  isWin,
  maxDrawdownFraction,
  profitFactor as profitFactorOf,
  winRateOrZero,
} from "./metrics/kernel";
import { loadStrategyConfigs } from "./strategyConfigLoader";
import { loadCustomStrategies, invalidateCustomStrategies } from "./customStrategyLoader";
import { buildEffectiveBacktestConfigs, buildPerStrategyBacktestConfigs } from "./backtestConfig";
import { ensureCandles, loadCandles } from "./historicalData";
import { ensureForexCandles } from "./oandaHistoricalData";
import { logger } from "./logger";
import { MIN_VIABLE_TAKE_PROFIT_PERCENT, DEFAULT_FEE_RATE, DEFAULT_SLIPPAGE_RATE, FOREX_COST_RATE, FOREX_SLIPPAGE_RATE } from "./tradingCosts";
import { estimateLiquidationPrice, stopTooCloseToLiquidation } from "./futuresMath";
import { type RiskModel } from "./dollarRisk";
import { type DollarRiskContext } from "./strategies/selector";
import { supportsShortEntries } from "./marketSymbols";
import { aggregateCandles, getClosedWindow } from "./candleTiming";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BacktestParams {
  symbols: string[];
  timeframe: string;
  startDate: Date;
  endDate: Date;
  startingBalance: number;
  confidenceThreshold: number;
  /** Stop-loss distance as a % below entry (Phase 5A — replaces atrMultiplierSl) */
  stopLossPercent: number;
  /** Take-profit distance as a % above entry (Phase 5A — replaces atrMultiplierTp) */
  takeProfitPercent: number;
  positionSizeUsdt: number;
  maxOpenPositions: number;
  dailyLossLimitUsdt: number;
  /** % of balance to risk per trade (0 = fixed positionSizeUsdt) */
  riskPercent?: number;
  /** Binance taker fee, default 0.1% (spot) / 0.05% (futures). Charged on
   *  aggressive fills: market entries, stop-losses, timeouts, liquidations. */
  feeRate?: number;
  /** Binance MAKER fee, default 0.1% (spot) / 0.02% (futures). Charged on
   *  PASSIVE fills — take-profit limit exits always, and maker entries when
   *  makerEntry is on. Defaults to feeRate when unset (no maker benefit). */
  makerFeeRate?: number;
  /**
   * Model entries as post-only MAKER limit orders instead of taker markets.
   * HONEST fill modeling: the limit rests at the signal price and only fills
   * if a LATER candle trades through it within makerEntryFillWindowMinutes;
   * if price never comes back, the trade is SKIPPED (a missed entry). On fill
   * there is no adverse entry slippage (you were the passive side) and the
   * maker fee applies. This trades cheaper/better fills AGAINST missed trades
   * — charging maker fees while still filling every signal at market would be
   * a free lunch that manufactures a false edge. Default false (taker entry).
   */
  makerEntry?: boolean;
  /** How long a maker-entry limit rests before it's cancelled unfilled.
   *  Default 30 min. Only used when makerEntry is on. */
  makerEntryFillWindowMinutes?: number;
  /** Slippage fraction, default 0.05% */
  slippageRate?: number;
  /**
   * Faithful mode: use each strategy's OWN configured SL/TP/confidence/risk
   * (what the live bot trades with) instead of flattening every strategy to
   * the run-level stopLossPercent/takeProfitPercent/confidenceThreshold. Used
   * by the backtest-validation harness; the interactive UI leaves this off
   * (its flat form is a single-config sweep). See backtestConfig.ts.
   */
  perStrategyConfigs?: boolean;
  /** Faithful mode only: reshape every strategy to TP = its own SL × this
   *  ratio (e.g. 3 → 1:3 reward:risk), keeping all other per-strategy config
   *  faithful. 0/undefined = off. */
  rrRatio?: number;
  /** Faithful mode only: disable TP1/break-even/trailing so trades resolve
   *  only at the full SL or TP — required to evaluate asymmetric-R:R styles
   *  the management layer would otherwise clip at ~1R. */
  pureExits?: boolean;
  /** Faithful mode only: multiply every strategy's maxHoldingSeconds (swing-
   *  profile test — adaptive targets grow ~√hold, amortizing fees). 1 = off. */
  holdMultiplier?: number;
  /** Optimization Autopsy (faithful mode only): patch ONE strategy's config
   *  for this run — the candidate parameter set under test. Never persisted. */
  strategyOverride?: { strategyId: string; patch: Record<string, unknown> };

  // ── Futures leverage modeling (spot is the default when unset) ─────────────
  /** "spot" (no leverage/liquidation) | "futures" | "forex" (OANDA candles,
   *  forex costs, no leverage/liquidation — like spot with FX rates).
   *  Default "spot". */
  marketType?: "spot" | "futures" | "forex";
  /** Futures leverage. Only affects liquidation risk — NOT position size, to
   *  match the live engine's notional-based sizing. Default 1. */
  leverage?: number;
  /** Reserved for future cross-margin modeling; backtest currently models
   *  isolated-margin liquidation regardless. */
  marginMode?: "isolated" | "cross";

  // ── Dollar-based risk model (Phase 8) ──────────────────────────────────────
  /**
   * "percent" (default): SL/TP come from stopLossPercent/takeProfitPercent.
   * "dollar": the strategy's %-based SL/TP/size are overridden by the fixed
   * max-loss / target-profit plan (lib/dollarRisk.ts) — the SAME planner the
   * live engine uses, so a dollar-model backtest reflects live trading exactly.
   */
  riskModel?: RiskModel;
  /** Dollar mode only: max dollars to lose per trade (net of fees). */
  maxLossUsdt?: number;
  /** Dollar mode only: desired dollar profit per trade (net of fees). */
  targetProfitUsdt?: number;

  /**
   * Test ONE strategy in isolation. When set, that strategy is force-ENABLED
   * (even if it's disabled for live) and every other strategy is disabled for
   * this run — so the result is purely that strategy's, using its own saved
   * config (SL/TP or dollar plan). Undefined = every enabled strategy runs.
   */
  onlyStrategyId?: string;
}

// The simulated position shape and the whole bar-by-bar fill model now live
// in execution/fillModel.ts, shared verbatim with the built-in Demo account so
// a demo fill and a backtest fill cannot drift apart.
type OpenPosition = SimulatedPosition;


interface SimTrade {
  symbol: string;
  side: PositionSide;
  entryTime: Date;
  exitTime: Date;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  slPrice: number;
  tpPrice: number;
  fees: number;
  slippage: number;
  /** NET of all fees (entry + every partial + final). */
  pnl: number;
  /** Gross (pre-fee) profit — see grossPnl comment on the DB column for why
   *  this is tracked separately from pnl (Phase 6 audit finding: pnlPercent
   *  used to be computed gross-of-fees while pnl was net, an inconsistent,
   *  misleading pair). */
  grossPnl: number;
  /** Now net-of-fees, computed from `pnl` — see Phase 6 audit / CHANGES.md. */
  pnlPercent: number;
  confidence: number;
  exitReason: string;
  durationSeconds: number;
  strategyId?: string;
  strategyName?: string;
  regime?: string;
  /** Decision engine: per-trade leverage / reasoning carried to persistence. */
  leverage?: number;
  entryReason?: string;
  tradePlan?: unknown;
  /** Phase 4C */
  mfe: number;
  mae: number;
  riskReward: number;
  // ── Phase 7 ──────────────────────────────────────────────────────────────
  tp1Price: number;
  tp1Qty: number;
  tp1Filled: boolean;
  tp1FillPrice?: number;
  tp1FillTime?: Date;
  tp2Price: number;
  tp2Qty: number;
  tp2Filled: boolean;
  tp2FillPrice?: number;
  tp2FillTime?: Date;
  breakEvenActive: boolean;
  trailingStopActive: boolean;
  trailingStopMode?: string;
  partialExits: PartialExitRecord[];
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

const cancelledRuns = new Set<number>();

export function cancelBacktestRun(runId: number): void {
  cancelledRuns.add(runId);
}

// ---------------------------------------------------------------------------
// Timeframe helpers
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function getTimeframeMs(tf: string): number {
  const map: Record<string, number> = {
    "1m":  60_000,
    "3m":  3 * 60_000,
    "5m":  5 * 60_000,
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
    "1h":  HOUR_MS,
    "4h":  4 * HOUR_MS,
    "1d":  DAY_MS,
  };
  return map[tf] ?? HOUR_MS;
}


// ---------------------------------------------------------------------------
// Summary metrics
// ---------------------------------------------------------------------------

function computeMetrics(
  trades: SimTrade[],
  startingBalance: number,
  endingBalance: number,
  equityCurve: number[]
) {
  const totalTrades = trades.length;
  const wins = trades.filter((t) => isWin(t.pnl));
  const losses = trades.filter((t) => !isWin(t.pnl));
  const winRate = winRateOrZero(wins.length, totalTrades);

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalReturn =
    startingBalance > 0 ? (endingBalance - startingBalance) / startingBalance : 0;

  const averageWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const averageLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = profitFactorOf(grossProfit, grossLoss);
  const expectancy = expectancyPerTrade(totalPnl, totalTrades);

  const maxDrawdown = maxDrawdownFraction(equityCurve, startingBalance);

  // Annualised Sharpe / Sortino from equity-curve returns
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    if ((equityCurve[i - 1] ?? 0) > 0) {
      dailyReturns.push(((equityCurve[i] ?? 0) - (equityCurve[i - 1] ?? 0)) / (equityCurve[i - 1] ?? 1));
    }
  }
  const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const variance =
    dailyReturns.length > 1
      ? dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (dailyReturns.length - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const downsideVariance =
    dailyReturns.length > 1
      ? dailyReturns.filter((r) => r < 0).reduce((s, r) => s + r ** 2, 0) / dailyReturns.length
      : 0;
  const downsideStd = Math.sqrt(downsideVariance);
  const annFactor = Math.sqrt(365);
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * annFactor : 0;
  const sortinoRatio = downsideStd > 0 ? (avgReturn / downsideStd) * annFactor : 0;

  const largestWin = wins.length > 0 ? Math.max(...wins.map((t) => t.pnl)) : 0;
  const largestLoss = losses.length > 0 ? Math.min(...losses.map((t) => t.pnl)) : 0;

  // ── Phase 4C: calendar daily/monthly return series, grouped by exit date ──
  // (Approximation: return % is pnl / startingBalance for that period, not
  // compounded against the running balance — simple and transparent, but
  // note it isn't a true time-weighted return.)
  const dailyBuckets = new Map<string, number>();
  const monthlyBuckets = new Map<string, number>();
  for (const t of trades) {
    const iso = t.exitTime.toISOString();
    const day = iso.slice(0, 10);
    const month = iso.slice(0, 7);
    dailyBuckets.set(day, (dailyBuckets.get(day) ?? 0) + t.pnl);
    monthlyBuckets.set(month, (monthlyBuckets.get(month) ?? 0) + t.pnl);
  }
  const dailyReturnsSeries = [...dailyBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, pnl]) => ({
      date, pnl,
      return: startingBalance > 0 ? pnl / startingBalance : 0,
    }));
  const monthlyReturnsSeries = [...monthlyBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, pnl]) => ({
      month, pnl,
      return: startingBalance > 0 ? pnl / startingBalance : 0,
    }));

  // ── Phase 4C: per-strategy comparison ──────────────────────────────────────
  const byStrategy = new Map<string, { strategyName: string; trades: SimTrade[] }>();
  for (const t of trades) {
    const id = t.strategyId ?? "unknown";
    if (!byStrategy.has(id)) byStrategy.set(id, { strategyName: t.strategyName ?? id, trades: [] });
    byStrategy.get(id)!.trades.push(t);
  }
  const strategyComparison = [...byStrategy.entries()].map(([strategyId, { strategyName, trades: st }]) => {
    const stWins = st.filter((t) => isWin(t.pnl));
    const stLosses = st.filter((t) => !isWin(t.pnl));
    const stGrossProfit = stWins.reduce((s, t) => s + t.pnl, 0);
    const stGrossLoss = Math.abs(stLosses.reduce((s, t) => s + t.pnl, 0));
    return {
      strategyId, strategyName,
      trades: st.length,
      winRate: winRateOrZero(stWins.length, st.length),
      pnl: st.reduce((s, t) => s + t.pnl, 0),
      profitFactor: profitFactorOf(stGrossProfit, stGrossLoss),
    };
  }).sort((a, b) => b.pnl - a.pnl);

  // ── Phase 7: trade-management ladder stats — how often did TP1/TP2/
  // break-even/trailing actually engage, vs. a plain binary SL/TP/timeout?
  // Directly answers "does the backtest exercise the same staged-exit
  // machinery live trading does" rather than just asserting it does.
  const tp1HitRate = totalTrades > 0 ? trades.filter((t) => t.tp1Filled).length / totalTrades : 0;
  const tp2HitRate = totalTrades > 0 ? trades.filter((t) => t.tp2Filled).length / totalTrades : 0;
  const breakEvenRate = totalTrades > 0 ? trades.filter((t) => t.breakEvenActive).length / totalTrades : 0;
  const trailingStopRate = totalTrades > 0 ? trades.filter((t) => t.trailingStopActive).length / totalTrades : 0;

  return {
    totalTrades, winningTrades: wins.length, losingTrades: losses.length,
    winRate, totalPnl, totalReturn, averageWin, averageLoss,
    profitFactor, expectancy, maxDrawdown, sharpeRatio, sortinoRatio,
    largestWin, largestLoss,
    dailyReturns: dailyReturnsSeries, monthlyReturns: monthlyReturnsSeries,
    strategyComparison,
    tp1HitRate, tp2HitRate, breakEvenRate, trailingStopRate,
  };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runBacktest(runId: number, params: BacktestParams, userId: number): Promise<void> {
  const { symbols, timeframe, startDate, endDate, startingBalance } = params;
  // Cost defaults follow the market being simulated: FX spreads/slippage are
  // ~10× tighter than crypto — charging crypto costs against FX-scale targets
  // fails every plan at the reward:risk floor (the live-engine bug, mirrored).
  const isForex = params.marketType === "forex";
  const feeRate = params.feeRate ?? (isForex ? FOREX_COST_RATE : DEFAULT_FEE_RATE);
  const slippageRate = params.slippageRate ?? (isForex ? FOREX_SLIPPAGE_RATE : DEFAULT_SLIPPAGE_RATE);
  // Maker fee defaults to taker when unset (i.e. no maker benefit) so existing
  // callers are unchanged. Passive fills (TP limits; maker entries) use it.
  const makerFeeRate = params.makerFeeRate ?? feeRate;
  const makerEntry = params.makerEntry ?? false;
  const makerEntryFillWindowMs = (params.makerEntryFillWindowMinutes ?? 30) * 60_000;
  /** Cost model handed to the shared fill model — one object, same semantics
   *  as the Demo account's. */
  const fillCosts: FillCosts = { feeRate, makerFeeRate, slippageRate };

  // Futures leverage modeling — same semantics as the live engine:
  //   sizing:      positionSizeUsdt is the MARGIN budget per trade, so the
  //                notional cap = size × leverage (spot: they're identical).
  //   liquidation: per-position isolated-margin liquidation price, with the
  //                same distance-proportional entry guard (futuresMath.ts).
  // Spot (default) leaves leverage at 1 → zero behavior change.
  const isFutures = params.marketType === "futures";
  const leverage = isFutures ? Math.max(1, Math.floor(params.leverage ?? 1)) : 1;
  const modelsLiquidation = isFutures && leverage > 1;
  const notionalCapUsdt = params.positionSizeUsdt * leverage;
  let liquidationRejectedEntries = 0; // entries the live liquidation guard would refuse

  // Dollar-risk context (always passed — parity with the live engine): a
  // strategy carrying its own trade plan trades the dollar model with those
  // numbers; otherwise the run-level dollar config applies when riskModel =
  // "dollar"; otherwise legacy %-based behavior.
  const dollarRisk: DollarRiskContext = {
    marketType: isFutures ? "futures" : "spot",
    leverage,
    feeRate,
    slippageRate,
    globalTradeAmountUsdt: params.positionSizeUsdt,
    ...(params.riskModel === "dollar" && {
      globalMaxLossUsdt: params.maxLossUsdt ?? 0,
      globalTargetProfitUsdt: params.targetProfitUsdt ?? 0,
    }),
  };

  // Diagnostic checkpoint 1: exactly what runBacktest() received, before
  // anything else touches it. Compare against the route's log of what the
  // UI submitted (routes/backtests.ts) and this log to confirm nothing is
  // lost in transit — see CHANGES.md for the bug this class of logging is
  // there to make impossible to miss again.
  logger.info(
    {
      runId,
      submittedParams: {
        confidenceThreshold: params.confidenceThreshold,
        stopLossPercent: params.stopLossPercent,
        takeProfitPercent: params.takeProfitPercent,
        riskPercent: params.riskPercent,
        positionSizeUsdt: params.positionSizeUsdt,
        maxOpenPositions: params.maxOpenPositions,
        dailyLossLimitUsdt: params.dailyLossLimitUsdt,
      },
    },
    "BACKTEST_PARAMS_RECEIVED (checkpoint 1/3 — see BACKTEST_DB_CONFIG and BACKTEST_EFFECTIVE_CONFIG below)",
  );

  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  const tfMs = getTimeframeMs(timeframe);

  await db
    .update(backtestRunsTable)
    .set({ status: "running", progress: 0 })
    .where(eq(backtestRunsTable.id, runId));

  try {
    // ── Phase 1: Download candles (0–40%) ────────────────────────────────────
    logger.info({ runId, symbols, timeframe }, "Backtest: downloading candles");

    // PARITY FIX: match the LIVE engine's window size. The live scanner passes
    // 100 candles per timeframe into buildSignalRow (fetchOHLCV(..., 100)),
    // whereas the backtest previously used 51-bar windows. Recursive indicators
    // (EMA50, Wilder ATR/RSI) seed differently at 51 vs 100 bars, so the two
    // engines could compute different values on identical prices — enough to
    // flip macroBullish / regime near a boundary. Using 100 in both makes them
    // agree.
    const WARMUP = 100; // candle windows are 100 bars, matching live
    // Six days provide the 100 closed hourly bars required by the indicators.
    // This is independent of scan cadence because the source is always 1m.
    const downloadStart = startMs - 6 * DAY_MS;

    for (let i = 0; i < symbols.length; i++) {
      if (cancelledRuns.has(runId)) throw new Error("cancelled");
      // Forex candles come from OANDA with the user's stored credentials
      // (there is no public OANDA data API); crypto from Binance public REST.
      if (isForex)
        await ensureForexCandles(
          userId,
          symbols[i]!,
          "1m",
          downloadStart,
          endMs,
        );
      else await ensureCandles(symbols[i]!, "1m", downloadStart, endMs);
      await db
        .update(backtestRunsTable)
        .set({ progress: Math.round(((i + 1) / symbols.length) * 40) })
        .where(eq(backtestRunsTable.id, runId));
    }

    // ── Phase 2: Load candles and build aggregated TF maps ────────────────────
    logger.info({ runId }, "Backtest: loading candles and building multi-TF arrays");

    const symbolCandles = new Map<string, Candle[]>();
    // Complete 3m / 5m / 15m / 1h arrays derived from the 1m source.
    const sym3m = new Map<string, Candle[]>();
    const sym5m  = new Map<string, Candle[]>();
    const sym15m = new Map<string, Candle[]>();
    const sym1h  = new Map<string, Candle[]>();

    for (const symbol of symbols) {
      const candles = (
        await loadCandles(symbol, "1m", downloadStart, endMs)
      ).filter((candle) => candle[0] + 60_000 <= endMs);
      symbolCandles.set(symbol, candles);
      sym3m.set(symbol, aggregateCandles(candles, 180_000));
      sym5m.set(symbol, aggregateCandles(candles, 300_000));
      sym15m.set(symbol, aggregateCandles(candles, 900_000));
      sym1h.set(symbol, aggregateCandles(candles, HOUR_MS));
    }

    // ── Strategy configs from DB (with defaults for any missing strategy) ──────
    // Forex runs must replay the FOREX section's tuning — crypto and forex
    // keep completely separate strategy configs (different dollar plans).
    const dbStrategyConfigs = await loadStrategyConfigs(userId, isForex ? "forex" : "crypto");

    // The user's custom strategies (no-code builder). The BACKTEST accepts
    // ALL of them — this is precisely where a never-backtested strategy earns
    // its live eligibility — while the live engine only accepts backtested
    // ones. Loaded once per run; injected per decideSymbol call, never into
    // the shared built-in roster.
    const customStrategies = (await loadCustomStrategies(userId, isForex ? "forex" : "crypto")).map((l) => l.strategy);

    // Diagnostic checkpoint 2: what's actually sitting in Postgres right now
    // (this is the LIVE bot's configuration too — loadStrategyConfigs() is
    // shared with botEngine.ts). Logged BEFORE the override below so a
    // diff against BACKTEST_EFFECTIVE_CONFIG shows exactly what changed.
    logger.info(
      {
        runId,
        dbConfigs: [...dbStrategyConfigs.entries()].map(([id, c]) => ({
          strategyId: id,
          stopLossPercent: c.stopLossPercent,
          takeProfitPercent: c.takeProfitPercent,
          confidenceThreshold: c.confidenceThreshold,
          riskPercent: c.riskPercent,
          enabled: c.enabled,
        })),
      },
      "BACKTEST_DB_CONFIG (checkpoint 2/3)",
    );

    // ⚠️ THE FIX: previously this Map was passed straight into
    // strategySelector.evaluateSymbol() below, completely unmodified — every
    // strategy's stopLossPercent/takeProfitPercent/confidenceThreshold/riskPercent
    // silently stayed at whatever was in the DB, no matter what the Backtest
    // UI submitted. buildEffectiveBacktestConfigs() applies those submitted
    // values on top of a FRESH clone (loadStrategyConfigs() never returns
    // shared/cached objects, so this can't affect the live bot's config or
    // write back to the database). See lib/backtestConfig.ts for the full
    // root-cause writeup. Checkpoint 3/3 is logged inside that function.
    const effectiveConfig = params.perStrategyConfigs
      ? buildPerStrategyBacktestConfigs(
          dbStrategyConfigs,
          Math.max(0, params.confidenceThreshold || 0),
          Math.max(0, params.rrRatio || 0),
          params.pureExits === true,
          Math.max(0, params.holdMultiplier || 1),
          params.strategyOverride as Parameters<typeof buildPerStrategyBacktestConfigs>[5],
        )
      : buildEffectiveBacktestConfigs(dbStrategyConfigs, params);
    const strategyConfigs = effectiveConfig.configs;

    // Single-strategy isolation: force the chosen strategy ON and every other
    // OFF, so "backtest just this strategy" needs no numbers typed — it runs
    // with the strategy's own saved config (incl. its dollar plan). Works even
    // on strategies disabled for live (e.g. the 20-minute strategy).
    if (params.onlyStrategyId) {
      for (const [id, cfg] of strategyConfigs) {
        strategyConfigs.set(id, {
          ...cfg,
          enabled: id === params.onlyStrategyId,
        });
      }
      logger.info({ runId, onlyStrategyId: params.onlyStrategyId }, "BACKTEST_SINGLE_STRATEGY isolation active");
    }

    // Persist the exact effective configuration used, BEFORE the simulation
    // runs, so it's on the record even if the run later fails/is cancelled —
    // this is what powers the "Effective Backtest Configuration" UI panel,
    // the completed-run report, and the CSV/JSON/HTML export.
    await db
      .update(backtestRunsTable)
      .set({
        effectiveConfig: {
          summary: effectiveConfig.summary,
          runLevelOverrides: effectiveConfig.runLevelOverrides,
        } as unknown as object,
      })
      .where(eq(backtestRunsTable.id, runId));

    // ── Phase 3: Chronological event stream ───────────────────────────────────
    interface Event { ts: number; symbol: string; idx: number; }
    const events: Event[] = [];

    for (const [symbol, candles] of symbolCandles) {
      for (let i = WARMUP; i < candles.length; i++) {
        events.push({ ts: candles[i]![0], symbol, idx: i });
      }
    }
    events.sort((a, b) => a.ts !== b.ts ? a.ts - b.ts : a.symbol.localeCompare(b.symbol));

    // ── Phase 4: Simulation (40–90%) ──────────────────────────────────────────
    logger.info({ runId, events: events.length }, "Backtest: running simulation");

    let balance = startingBalance;
    let peakBalance = startingBalance;
    const allTrades: SimTrade[] = [];
    // Aggregated decision telemetry (strategy × stage × reason → count),
    // persisted once on the run row as `decisionStats`.
    const decisionAgg = new Map<string, { strategyId: string; stage: string; reason: string; count: number }>();
    const equityTimeSeries: Array<{ ts: Date; balance: number; drawdown: number }> = [];

    const openPositions: OpenPosition[] = [];
    // Maker-entry mode only: resting limit orders awaiting a fill. Keyed by
    // symbol (at most one pending per symbol, same as one position per symbol).
    // Each holds the fully-built position (priced/fee'd as a maker fill) plus
    // the limit price it's waiting on and the timestamp it expires unfilled.
    interface PendingEntry { limitPrice: number; side: PositionSide; expiresAtMs: number; pos: OpenPosition; }
    const pendingEntries: Map<string, PendingEntry> = new Map();
    let makerEntriesMissed = 0; // limits that expired without ever filling
    let dailyPnl = 0;
    let lastDailyReset = startDate.toISOString().split("T")[0]!;
    // Audit finding: the backtest previously had NO cooldown modeling at all
    // — a symbol could be re-entered on the very next candle after closing,
    // whereas live trading enforces a per-symbol cooldown after every exit.
    // Mirrors botEngine's symbolCooldowns Map<symbol, expiryTimestampMs>.
    const symbolCooldownExpiry = new Map<string, number>();
    // Per-symbol last regime for hysteresis (deferred-work #2) — mirrors
    // BotEngine.lastRegime so backtest and live resolve regime identically.
    const symbolRegime = new Map<string, MarketRegime>();

    const progressStep = Math.max(1, Math.floor(events.length / 50));

    for (let ei = 0; ei < events.length; ei++) {
      if (ei % progressStep === 0) {
        if (cancelledRuns.has(runId)) throw new Error("cancelled");
        const pct = 40 + Math.round((ei / events.length) * 50);
        await db
          .update(backtestRunsTable)
          .set({ progress: pct })
          .where(eq(backtestRunsTable.id, runId));
      }

      const { ts, symbol, idx } = events[ei]!;
      const candles = symbolCandles.get(symbol)!;
      const currentCandle = candles[idx]!;
      const [, , high, low] = currentCandle;
      const now = new Date(ts + 60_000);
      const dayKey = now.toISOString().split("T")[0]!;

      // Daily circuit-breaker reset
      if (dayKey !== lastDailyReset) {
        dailyPnl = 0;
        lastDailyReset = dayKey;
      }

      // ── Manage + check exits for open positions on this symbol ────────────
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi]!;
        if (pos.symbol !== symbol) continue;

        // ── Shared fill model (execution/fillModel.ts) ──────────────────────
        // Excursion tracking, TP1/TP2 partials, break-even, trailing, and the
        // exit decision are no longer inline here: they are the SAME functions
        // the Demo account runs, so a simulated fill means one thing across
        // the product. Extracted verbatim — the harness Δ0 gate is the proof.
        const posStratCfg = pos.strategyId
          ? strategyConfigs.get(pos.strategyId)
          : undefined;
        const barCtx: BarContext = {
          candle: currentCandle,
          history: candles.slice(0, idx + 1),
          now,
        };

        updateExcursion(pos, high, low);
        manageBar(pos, barCtx, posStratCfg, fillCosts);
        const settled = settleBar(pos, barCtx, posStratCfg, fillCosts);

        if (settled) {
          balance += settled.pnl;
          dailyPnl += settled.pnl;
          if (balance > peakBalance) peakBalance = balance;

          allTrades.push({
            symbol,
            side: pos.side,
            entryTime: pos.entryTime,
            exitTime: now,
            entryPrice: pos.entryPrice,
            exitPrice: settled.exitPrice,
            qty: pos.qty,
            slPrice: pos.slPrice,
            tpPrice: pos.tpPrice,
            fees: settled.totalFees,
            slippage: settled.totalSlippage,
            pnl: settled.pnl,
            grossPnl: settled.grossPnl,
            pnlPercent: settled.pnlPercent,
            confidence: pos.confidence,
            exitReason: settled.exitReason,
            durationSeconds: settled.durationSeconds,
            strategyId: pos.strategyId,
            strategyName: pos.strategyName,
            regime: pos.regime,
            leverage: pos.leverage,
            entryReason: pos.entryReason,
            tradePlan: pos.tradePlan,
            mfe: pos.mfe,
            mae: pos.mae,
            riskReward: settled.riskReward,
            tp1Price: pos.tp1Price,
            tp1Qty: pos.tp1Qty,
            tp1Filled: pos.tp1Filled,
            tp1FillPrice: pos.tp1FillPrice,
            tp1FillTime: pos.tp1FillTime,
            tp2Price: pos.tp2Price,
            tp2Qty: pos.tp2Qty,
            tp2Filled: pos.tp2Filled,
            tp2FillPrice: pos.tp2FillPrice,
            tp2FillTime: pos.tp2FillTime,
            breakEvenActive: pos.breakEvenActive,
            trailingStopActive: pos.trailingStopActive,
            trailingStopMode: pos.trailingStopMode,
            partialExits: pos.partialExits,
          });

          // Start this symbol's cooldown, sized by whichever strategy closed
          // it (falls back to 30min if unresolvable — matches botEngine's
          // global default for the same edge case).
          symbolCooldownExpiry.set(symbol, now.getTime() + (posStratCfg?.cooldownMinutes ?? 30) * 60_000);

          openPositions.splice(pi, 1);
        }
      }

      // Skip timestamps before requested backtest start
      if (ts < startMs) continue;

      // ── Record equity curve ───────────────────────────────────────────────
      const drawdown = peakBalance > 0 ? (peakBalance - balance) / peakBalance : 0;
      equityTimeSeries.push({ ts: now, balance, drawdown });

      // ── Maker-entry: resolve any resting limit for this symbol ────────────
      // Runs BEFORE the entry section (which may place a new one), and only on
      // candles strictly after placement, so a signal candle can never fill
      // its own limit — no look-ahead. A long limit fills when a later bar's
      // low trades down to it; a short limit when a high trades up to it. On
      // fill the position enters at the limit price (no adverse slippage — we
      // were passive). If it never trades through before expiry, the entry is
      // MISSED, not filled — the honest cost of posting maker instead of taker.
      const pending = pendingEntries.get(symbol);
      if (pending) {
        const filled =
          pending.side === "short"
            ? high >= pending.limitPrice
            : low <= pending.limitPrice;
        if (now.getTime() >= pending.expiresAtMs) {
          pendingEntries.delete(symbol);
          makerEntriesMissed++;
        } else if (filled) {
          // Only take it if there's still room and the day isn't halted —
          // exactly the gates the immediate-entry path applies below.
          const roomToOpen =
            openPositions.length < params.maxOpenPositions &&
            dailyPnl > -Math.abs(params.dailyLossLimitUsdt) &&
            !openPositions.some((p) => p.symbol === symbol);
          if (roomToOpen) {
            pending.pos.entryTime = now; // holding time starts at the fill, not placement
            openPositions.push(pending.pos);
          } else {
            makerEntriesMissed++;
          }
          pendingEntries.delete(symbol);
        }
      }

      // ── Entry signal ──────────────────────────────────────────────────────
      const circuitBreakerActive = dailyPnl <= -Math.abs(params.dailyLossLimitUsdt);
      const atMaxPositions = openPositions.length >= params.maxOpenPositions;
      const alreadyInSymbol = openPositions.some((p) => p.symbol === symbol);
      const onCooldown = (symbolCooldownExpiry.get(symbol) ?? 0) > now.getTime();
      // Don't stack a second resting limit on a symbol that already has one.
      const hasPendingEntry = pendingEntries.has(symbol);

      if (
        circuitBreakerActive ||
        atMaxPositions ||
        alreadyInSymbol ||
        onCooldown ||
        hasPendingEntry
      )
        continue;

      // Build 100 closed candles per timeframe at the decision time.
      // The selected timeframe controls entry cadence. Indicators and exits
      // always use real 1m data, so a 5m scan never masquerades as a 1m signal.
      if (now.getTime() % tfMs !== 0) continue;
      const primaryWindow = candles.slice(idx - WARMUP + 1, idx + 1);
      const window3m = getClosedWindow(
        sym3m.get(symbol)!,
        180_000,
        now.getTime(),
        WARMUP,
      );
      const window5m = getClosedWindow(
        sym5m.get(symbol)!,
        300_000,
        now.getTime(),
        WARMUP,
      );
      const window15m = getClosedWindow(
        sym15m.get(symbol)!,
        900_000,
        now.getTime(),
        WARMUP,
      );
      const window1h = getClosedWindow(
        sym1h.get(symbol)!,
        HOUR_MS,
        now.getTime(),
        WARMUP,
      );
      // Missing higher-timeframe history is unavailable, never a 1m substitute.
      if (!window3m || !window5m || !window15m || !window1h) continue;

      const mtf: MultiTimeframeCandles = {
        tf1m:  primaryWindow,
        tf3m:  window3m,
        tf5m:  window5m,
        tf15m: window15m,
        tf1h:  window1h,
      };

      // Phase 2: multi-strategy evaluation — pass current balance for risk-based sizing
      const row = buildSignalRow(symbol, mtf, symbolRegime.get(symbol));
      symbolRegime.set(symbol, row.regime);
      const { plans, rejections } = strategySelector.decideSymbol(
        symbol, mtf, row, strategyConfigs, balance, notionalCapUsdt, dollarRisk, customStrategies
      );
      // Decision telemetry — AGGREGATED, never row-per-event (a 2-week 1m run
      // evaluates ~45k candles; per-event rows would explode the table).
      for (const r of rejections) {
        const key = `${r.strategyId}|${r.stage}|${r.reason}`;
        const agg = decisionAgg.get(key);
        if (agg) agg.count++;
        else
          decisionAgg.set(key, {
            strategyId: r.strategyId,
            stage: r.stage,
            reason: r.reason,
            count: 1,
          });
      }
      // PARITY FIX: spot has no short-selling mechanism — the live engine drops
      // short signals in spot mode (botEngine.ts), so the backtest must too, or
      // a spot backtest takes sell trades that live could never place.
      let signals = plans;
      if (!supportsShortEntries(params.marketType ?? "spot")) {
        signals = signals.filter((s) => s.side === "long");
      }
      if (signals.length === 0) continue;

      // PARITY with botEngine's fair per-strategy allocation: take the
      // highest-confidence signal whose OWN strategy still has concurrency
      // budget, instead of only signals[0] — so a dominant strategy at its cap
      // doesn't block other strategies from trading this symbol. Each strategy
      // works its own maxConcurrentPositions budget independently.
      let bestSignal: (typeof signals)[number] | undefined;
      for (const cand of signals) {
        const cfg = strategyConfigs.get(cand.strategyId);
        const maxC = cfg?.maxConcurrentPositions ?? 2;
        const open = openPositions.filter((p) => p.strategyId === cand.strategyId).length;
        if (open < maxC) { bestSignal = cand; break; }
      }
      if (!bestSignal) continue; // every signalling strategy is at its cap

      // Phase 5A: SL distance is now a direct % of entry (stopLossPercent),
      // set deterministically by computePercentSLTP() — there's no more ATR-
      // multiplier sweep that could produce a wild stop distance, so the old
      // "maxSlPercent" portfolio-level sanity cap (analogous to
      // maxOpenPositions/dailyLossLimitUsdt above) is no longer needed and has
      // been removed. slDistancePercent is still computed and logged below as
      // a diagnostic — it should always equal the strategy's configured
      // stopLossPercent; any drift would indicate a config-plumbing bug.
      const isShortSignal = bestSignal.side === "short";
      const slDistancePercent =
        (Math.abs(bestSignal.entryPrice - bestSignal.slPrice) /
          bestSignal.entryPrice) *
        100;
      // Per-trade leverage from the plan — legacy-adapter plans carry the
      // run's leverage, so historical runs are bit-identical; native decide()
      // strategies may choose LOWER than the cap per trade.
      const tradeLeverage = isFutures
        ? Math.max(1, Math.floor(bestSignal.leverage))
        : 1;

      // Entry fill mechanics:
      //   taker (default): cross the spread now — adverse slippage, taker fee.
      //     A long BUYs to open (pays slightly more), a short SELLs to open
      //     (receives slightly less) — same convention botEngine.ts uses live.
      //   maker (makerEntry): post a limit AT the signal price — no adverse
      //     slippage (we're the passive side), maker fee — but it only becomes
      //     a position if a later bar trades through it (handled above).
      const fillPrice = makerEntry
        ? bestSignal.entryPrice
        : bestSignal.entryPrice *
          (isShortSignal ? 1 - slippageRate : 1 + slippageRate);
      const entryFees = fillPrice * bestSignal.qty * (makerEntry ? makerFeeRate : feeRate);
      const entrySlippage = makerEntry
        ? 0
        : (fillPrice - bestSignal.entryPrice) * bestSignal.qty;

      // Diagnostic: the actual stopLossPercent/takeProfitPercent/confidenceThreshold/
      // riskPercent this specific strategy used to produce this specific trade — the
      // direct answer to "values actually passed into every strategy."
      const usedConfig = strategyConfigs.get(bestSignal.strategyId);
      logger.debug(
        {
          runId,
          symbol,
          strategyId: bestSignal.strategyId,
          stopLossPercent: usedConfig?.stopLossPercent,
          takeProfitPercent: usedConfig?.takeProfitPercent,
          confidenceThreshold: usedConfig?.confidenceThreshold,
          riskPercent: usedConfig?.riskPercent,
          entryPrice: bestSignal.entryPrice,
          suggestedSL: bestSignal.slPrice,
          suggestedTP: bestSignal.tpPrice,
          confidence: bestSignal.confidence,
          slDistancePercent: slDistancePercent.toFixed(3),
          plannedLeverage: tradeLeverage,
        },
        "BACKTEST_TRADE_CONFIG_USED",
      );

      // Phase 6 audit / CHANGES.md Flaw 1 FIX: previously this anchored SL/TP
      // to the pre-slippage signal price (bestSignal.suggestedSL/suggestedTP)
      // while the position's recorded entryPrice was the post-slippage fill
      // — a systematic distortion that scaled inversely with configured SL/TP
      // tightness (confirmed empirically: at very tight %, it was the
      // DOMINANT source of error, not a minor one). Fixed by exactly
      // replicating the fix botEngine.ts already applies on the live side
      // (see its "FIX (bug #1 / #2)" comment): preserve the strategy's
      // intended absolute $ risk/reward distance, then re-anchor both SL and
      // TP to the actual fill price, rather than recomputing a fresh
      // percentage from either price (those are subtly different formulas —
      // this matches live's exact approach, not just an approximation of it).
      // For a short, suggestedSL sits ABOVE entry and suggestedTP sits BELOW
      // entry, so both distances are negated to keep slDistance/tpDistance
      // positive, then re-applied in the opposite direction around fillPrice
      // — mirrors botEngine.ts enterTrade's side-aware re-anchoring exactly.
      const signalEntry = bestSignal.entryPrice;
      const slDistance = isShortSignal
        ? bestSignal.slPrice - signalEntry
        : signalEntry - bestSignal.slPrice;
      const tpDistance = isShortSignal
        ? signalEntry - bestSignal.tpPrice
        : bestSignal.tpPrice - signalEntry;
      const realSlPrice = isShortSignal
        ? fillPrice + slDistance
        : fillPrice - slDistance;
      const realTpPrice = isShortSignal
        ? fillPrice - tpDistance
        : fillPrice + tpDistance;

      // Futures liquidation guard (parity with live botEngine.enterTrade): a
      // leveraged position whose stop sits too close to the liquidation price
      // would be liquidated before the stop can protect it, so the live engine
      // refuses the entry. Replicate that here so a too-aggressive leverage
      // (e.g. 50x with a 1.5% stop) shows the SAME "few/no trades" outcome the
      // live bot would produce, instead of pretending the trades happen.
      let liquidationPrice: number | undefined;
      if (isFutures && tradeLeverage > 1) {
        liquidationPrice = estimateLiquidationPrice(fillPrice, bestSignal.side, tradeLeverage);
        if (
          stopTooCloseToLiquidation(fillPrice, realSlPrice, liquidationPrice)
        ) {
          liquidationRejectedEntries++;
          const key = `${bestSignal.strategyId}|liquidation-guard|stop too close to liquidation at ${tradeLeverage}x`;
          const agg = decisionAgg.get(key);
          if (agg) agg.count++;
          else
            decisionAgg.set(key, {
              strategyId: bestSignal.strategyId,
              stage: "liquidation-guard",
              reason: `stop too close to liquidation at ${tradeLeverage}x`,
              count: 1,
            });
          continue; // live would not open this trade
        }
      }

      // Phase 7: TP1/TP2 interior-waypoint ladder — same shared formula
      // botEngine.ts uses (computeTp1Tp2Ladder in strategies/base.ts), so the
      // backtest now simulates the same staged exit structure live trading
      // actually runs, instead of a single binary SL/TP.
      const ladder = usedConfig
        ? computeTp1Tp2Ladder(
            fillPrice, realSlPrice, realTpPrice, bestSignal.qty, usedConfig,
            (p) => p, (q) => q, bestSignal.side,
          )
        : { tp1Price: 0, tp1Qty: 0, tp2Price: 0, tp2Qty: 0 };

      const newPos: OpenPosition = {
        symbol,
        entryPrice: fillPrice,
        slPrice: realSlPrice,
        tpPrice: realTpPrice,
        plannedSlPrice: realSlPrice,
        qty: bestSignal.qty,
        remainingQty: bestSignal.qty,
        entryTime: now,
        confidence: bestSignal.confidence,
        fees: entryFees,
        slippage: entrySlippage,
        liquidationPrice,
        strategyId: bestSignal.strategyId,
        strategyName: bestSignal.strategyName,
        regime: bestSignal.regime,
        leverage: tradeLeverage,
        maxHoldSeconds: Math.round(bestSignal.maxHoldSeconds),
        expectedHoldSeconds: Math.round(bestSignal.expectedHoldSeconds),
        entryReason: bestSignal.report.summary,
        tradePlan: bestSignal,
        mfe: 0,
        mae: 0,
        tp1Price: ladder.tp1Price,
        tp1Qty: ladder.tp1Qty,
        tp1Filled: false,
        tp2Price: ladder.tp2Price,
        tp2Qty: ladder.tp2Qty,
        tp2Filled: false,
        breakEvenActive: false,
        trailingStopActive: false,
        partialExits: [],
        side: bestSignal.side,
      };

      if (makerEntry) {
        // Post the limit and wait — it fills on a later bar (or expires). See
        // the pending-resolution block above.
        pendingEntries.set(symbol, {
          limitPrice: fillPrice,
          side: bestSignal.side,
          expiresAtMs: now.getTime() + makerEntryFillWindowMs,
          pos: newPos,
        });
      } else {
        openPositions.push(newPos);
      }
    }

    // ── Close remaining open positions at last candle close ────────────────────
    // Phase 6 audit Flaw 2 fix: these are NOT genuine maxHoldingSeconds
    // timeouts — the backtest's date range simply ended while the position
    // was still open. Previously mislabeled "timeout", inflating that exit
    // reason's count. Now uses the distinct "end_of_backtest" reason (added
    // to exitTypes.ts) so exit-reason statistics aren't polluted with a
    // category that isn't a real trading outcome.
    for (const pos of openPositions) {
      const isShort = pos.side === "short";
      const candles = symbolCandles.get(pos.symbol)!;
      const lastCandle = candles[candles.length - 1]!;
      const exitPrice = lastCandle[4] * (isShort ? 1 + slippageRate : 1 - slippageRate);
      const exitQty = pos.remainingQty;
      const exitFees = exitPrice * exitQty * feeRate;
      const finalSlicePnl =
        (isShort ? pos.entryPrice - exitPrice : exitPrice - pos.entryPrice) *
          exitQty -
        exitFees;
      const partialPnl = pos.partialExits.reduce((s, p) => s + p.pnl, 0);
      const partialFees = pos.partialExits.reduce((s, p) => s + p.fees, 0);
      // Same entry-fee accounting fix as the main exit block above.
      const entryFeeShareFinal = pos.qty > 0 ? pos.fees * (exitQty / pos.qty) : pos.fees;
      const pnl = finalSlicePnl + partialPnl - entryFeeShareFinal;
      const grossPnl =
        (isShort ? pos.entryPrice - exitPrice : exitPrice - pos.entryPrice) *
          exitQty +
        pos.partialExits.reduce(
          (s, p) =>
            s +
            (isShort ? pos.entryPrice - p.price : p.price - pos.entryPrice) *
              p.qty,
          0,
        );
      const totalFees = entryFeeShareFinal + exitFees + partialFees;
      const riskReward =
        pos.entryPrice - pos.plannedSlPrice !== 0
          ? (pos.tpPrice - pos.entryPrice) /
            (pos.entryPrice - pos.plannedSlPrice)
          : 0;
      const notional = pos.entryPrice * pos.qty;
      balance += pnl;
      allTrades.push({
        symbol: pos.symbol,
        entryTime: pos.entryTime,
        exitTime: new Date(lastCandle[0] + 60_000),
        entryPrice: pos.entryPrice,
        exitPrice,
        qty: pos.qty,
        slPrice: pos.slPrice,
        tpPrice: pos.tpPrice,
        fees: totalFees,
        slippage: pos.slippage,
        pnl,
        grossPnl,
        pnlPercent: notional > 0 ? (pnl / notional) * 100 : 0,
        confidence: pos.confidence,
        exitReason: "end_of_backtest",
        durationSeconds: Math.round(
          (lastCandle[0] + 60_000 - pos.entryTime.getTime()) / 1000,
        ),
        strategyId: pos.strategyId,
        strategyName: pos.strategyName,
        regime: pos.regime,
        leverage: pos.leverage,
        entryReason: pos.entryReason,
        tradePlan: pos.tradePlan,
        mfe: pos.mfe,
        mae: pos.mae,
        riskReward,
        tp1Price: pos.tp1Price,
        tp1Qty: pos.tp1Qty,
        tp1Filled: pos.tp1Filled,
        tp1FillPrice: pos.tp1FillPrice,
        tp1FillTime: pos.tp1FillTime,
        tp2Price: pos.tp2Price,
        tp2Qty: pos.tp2Qty,
        tp2Filled: pos.tp2Filled,
        tp2FillPrice: pos.tp2FillPrice,
        tp2FillTime: pos.tp2FillTime,
        breakEvenActive: pos.breakEvenActive,
        trailingStopActive: pos.trailingStopActive,
        trailingStopMode: pos.trailingStopMode,
        partialExits: pos.partialExits,
        side: pos.side,
      });
    }

    if (makerEntry) {
      logger.info(
        {
          runId,
          makerEntry: true,
          makerFeeRate,
          makerEntriesMissed,
          filled: allTrades.length,
        },
        `Backtest maker-entry mode: ${makerEntriesMissed} limit entries expired unfilled (price never traded back to them) — the honest cost of posting maker instead of taker.`,
      );
    }

    // ── Phase 5: Persist results (90–100%) ────────────────────────────────────
    if (modelsLiquidation) {
      logger.info(
        { runId, marketType: "futures", leverage, liquidationRejectedEntries },
        `Backtest futures mode: ${leverage}x leverage — ${liquidationRejectedEntries} entries were refused because the stop sat too close to liquidation (matches the live engine's guard).`,
      );
    }

    logger.info({ runId, trades: allTrades.length }, "Backtest: persisting results");

    if (cancelledRuns.has(runId)) throw new Error("cancelled");

    allTrades.sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());

    const pendingPartialExits: Array<{ backtestTradeId: number; partials: SimTrade["partialExits"] }> = [];

    if (allTrades.length > 0) {
      for (let i = 0; i < allTrades.length; i += 200) {
        const chunk = allTrades.slice(i, i + 200);
        const batch = chunk.map((t) => ({
          runId,
          symbol: t.symbol,
          side: t.side === "short" ? ("sell" as const) : ("buy" as const),
          entryTime: t.entryTime,
          exitTime: t.exitTime,
          entryPrice: t.entryPrice.toFixed(8),
          exitPrice: t.exitPrice.toFixed(8),
          quantity: t.qty.toFixed(8),
          stopLoss: t.slPrice.toFixed(8),
          takeProfit: t.tpPrice.toFixed(8),
          fees: t.fees.toFixed(8),
          slippage: t.slippage.toFixed(8),
          pnl: t.pnl.toFixed(8),
          grossPnl: t.grossPnl.toFixed(8),
          pnlPercent: t.pnlPercent.toFixed(4),
          confidence: t.confidence.toFixed(2),
          exitReason: t.exitReason,
          durationSeconds: t.durationSeconds,
          mfe: t.mfe.toFixed(8),
          mae: t.mae.toFixed(8),
          riskReward: t.riskReward.toFixed(4),
          ...(t.strategyId && { strategyId: t.strategyId }),
          ...(t.strategyName && { strategyName: t.strategyName }),
          ...(t.regime && { marketRegime: t.regime }),
          // Decision engine: per-trade leverage + the plan's reasoning
          ...(t.leverage != null && { leverage: t.leverage }),
          ...(t.entryReason && { entryReason: t.entryReason }),
          ...(t.tradePlan != null && { tradePlan: t.tradePlan }),
          // Phase 7: trade-management parity fields
          ...(t.tp1Price > 0 && {
            tp1Price: t.tp1Price.toFixed(8),
            tp1Quantity: t.tp1Qty.toFixed(8),
          }),
          tp1Filled: t.tp1Filled,
          ...(t.tp1FillPrice != null && {
            tp1FillPrice: t.tp1FillPrice.toFixed(8),
          }),
          ...(t.tp1FillTime != null && { tp1FillTime: t.tp1FillTime }),
          ...(t.tp2Price > 0 && {
            tp2Price: t.tp2Price.toFixed(8),
            tp2Quantity: t.tp2Qty.toFixed(8),
          }),
          tp2Filled: t.tp2Filled,
          ...(t.tp2FillPrice != null && {
            tp2FillPrice: t.tp2FillPrice.toFixed(8),
          }),
          ...(t.tp2FillTime != null && { tp2FillTime: t.tp2FillTime }),
          breakEvenActive: t.breakEvenActive,
          trailingStopActive: t.trailingStopActive,
          ...(t.trailingStopMode && { trailingStopMode: t.trailingStopMode }),
        }));
        const inserted = await db
          .insert(backtestTradesTable)
          .values(batch)
          .returning({ id: backtestTradesTable.id });
        for (let j = 0; j < inserted.length; j++) {
          const partials = chunk[j]!.partialExits;
          if (partials.length > 0) {
            pendingPartialExits.push({
              backtestTradeId: inserted[j]!.id,
              partials,
            });
          }
        }
      }
    }

    if (pendingPartialExits.length > 0) {
      const flatRows = pendingPartialExits.flatMap(
        ({ backtestTradeId, partials }) =>
          partials.map((p) => ({
            backtestTradeId,
            reason: p.reason,
            quantity: p.qty.toFixed(8),
            price: p.price.toFixed(8),
            fees: p.fees.toFixed(8),
            pnl: p.pnl.toFixed(8),
            time: p.time,
          })),
      );
      for (let i = 0; i < flatRows.length; i += 200) {
        await db
          .insert(backtestTradePartialExitsTable)
          .values(flatRows.slice(i, i + 200));
      }
    }

    const equityCurveData = downsample(equityTimeSeries, 2000);
    if (equityCurveData.length > 0) {
      for (let i = 0; i < equityCurveData.length; i += 500) {
        const batch = equityCurveData.slice(i, i + 500).map((p) => ({
          runId,
          timestamp: p.ts,
          balance: p.balance.toFixed(2),
          drawdown: p.drawdown.toFixed(4),
        }));
        await db.insert(equityCurveTable).values(batch);
      }
    }

    const metrics = computeMetrics(
      allTrades, startingBalance, balance,
      equityTimeSeries.map((p) => p.balance)
    );

    await db
      .update(backtestRunsTable)
      .set({
        status: "completed",
        progress: 100,
        endingBalance: balance.toFixed(2),
        totalReturn: metrics.totalReturn.toFixed(4),
        totalPnl: metrics.totalPnl.toFixed(2),
        totalTrades: metrics.totalTrades,
        winningTrades: metrics.winningTrades,
        losingTrades: metrics.losingTrades,
        winRate: metrics.winRate.toFixed(4),
        profitFactor: metrics.profitFactor.toFixed(4),
        sharpeRatio: metrics.sharpeRatio.toFixed(4),
        sortinoRatio: metrics.sortinoRatio.toFixed(4),
        maxDrawdown: metrics.maxDrawdown.toFixed(4),
        averageWin: metrics.averageWin.toFixed(8),
        averageLoss: metrics.averageLoss.toFixed(8),
        expectancy: metrics.expectancy.toFixed(8),
        largestWin: metrics.largestWin.toFixed(8),
        largestLoss: metrics.largestLoss.toFixed(8),
        dailyReturns: metrics.dailyReturns,
        monthlyReturns: metrics.monthlyReturns,
        strategyComparison: metrics.strategyComparison,
        // Decision telemetry: strategy × stage × reason rejection counts,
        // most frequent first — "why the run DIDN'T trade more".
        decisionStats: {
          rejections: [...decisionAgg.values()].sort(
            (a, b) => b.count - a.count,
          ),
        },
        tp1HitRate: metrics.tp1HitRate.toFixed(4),
        tp2HitRate: metrics.tp2HitRate.toFixed(4),
        breakEvenRate: metrics.breakEvenRate.toFixed(4),
        trailingStopRate: metrics.trailingStopRate.toFixed(4),
      })
      .where(eq(backtestRunsTable.id, runId));

    // Backtest-first live gate: a COMPLETED single-strategy run of a CUSTOM
    // strategy is what earns it live eligibility. Stamp lastBacktestAt on
    // the row (scoped to this run's user + section) and drop the loader
    // cache so the live engine sees the promotion within one config refresh.
    if (params.onlyStrategyId?.startsWith("custom_")) {
      const section = isForex ? ("forex" as const) : ("crypto" as const);
      try {
        await db
          .update(customStrategiesTable)
          .set({ lastBacktestAt: new Date() })
          .where(and(
            eq(customStrategiesTable.userId, userId),
            eq(customStrategiesTable.section, section),
            eq(customStrategiesTable.strategyId, params.onlyStrategyId),
          ));
        invalidateCustomStrategies(userId, section);
        logger.info({ runId, strategyId: params.onlyStrategyId, section }, "Custom strategy backtest completed — lastBacktestAt stamped (live-eligible once enabled)");
      } catch (err) {
        logger.warn({ err, runId, strategyId: params.onlyStrategyId }, "Failed to stamp custom strategy lastBacktestAt (non-fatal)");
      }
    }

    logger.info(
      {
        runId,
        ...metrics,
        effectiveConfigApplied: effectiveConfig.runLevelOverrides,
      },
      "Backtest complete (checkpoint 3/3 — compare effectiveConfigApplied above against BACKTEST_PARAMS_RECEIVED at the start of this run's logs to confirm the submitted values were actually used)",
    );
  } catch (err: any) {
    const isCancelled = err?.message === "cancelled";
    cancelledRuns.delete(runId);
    await db
      .update(backtestRunsTable)
      .set({
        status: isCancelled ? "cancelled" : "failed",
        error: isCancelled ? null : String(err?.message ?? err),
      })
      .where(eq(backtestRunsTable.id, runId));
    if (!isCancelled) {
      logger.error({ err, runId }, "Backtest failed");
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function downsample<T>(arr: T[], maxLen: number): T[] {
  if (arr.length <= maxLen) return arr;
  const step = Math.ceil(arr.length / maxLen);
  const result: T[] = [];
  for (let i = 0; i < arr.length; i += step) result.push(arr[i]!);
  if (result[result.length - 1] !== arr[arr.length - 1]) {
    result.push(arr[arr.length - 1]!);
  }
  return result;
}
