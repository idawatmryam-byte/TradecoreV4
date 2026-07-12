/**
 * TradeCore Pro — Backtest Engine  (Phase 1 Professional Engine)
 *
 * Replays historical candles using the EXACT same strategy logic as the live
 * BotEngine — buildSignalRow from strategy.ts + the same per-strategy
 * evaluate() functions (strategies/*.ts) the live engine uses.
 *
 * Key improvements over legacy engine:
 * - 5-timeframe support (1m / 3m / 5m / 15m / 1h) derived by aggregating
 *   the primary-timeframe download — no extra Binance requests.
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
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  buildSignalRow,
  type Candle,
  type MultiTimeframeCandles,
} from "./strategy";
import { strategySelector, computeTp1Tp2Ladder, type StrategyConfig, type PositionSide } from "./strategies";
import { computeTrailingStop } from "./tradeManager";
import { loadStrategyConfigs } from "./strategyConfigLoader";
import { buildEffectiveBacktestConfigs, buildPerStrategyBacktestConfigs } from "./backtestConfig";
import { ensureCandles, loadCandles } from "./historicalData";
import { logger } from "./logger";
import { MIN_VIABLE_TAKE_PROFIT_PERCENT, DEFAULT_FEE_RATE, DEFAULT_SLIPPAGE_RATE } from "./tradingCosts";
import { estimateLiquidationPrice, stopTooCloseToLiquidation } from "./futuresMath";

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
  /** Binance taker fee, default 0.1% */
  feeRate?: number;
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

  // ── Futures leverage modeling (spot is the default when unset) ─────────────
  /** "spot" (no leverage/liquidation) | "futures". Default "spot". */
  marketType?: "spot" | "futures";
  /** Futures leverage. Only affects liquidation risk — NOT position size, to
   *  match the live engine's notional-based sizing. Default 1. */
  leverage?: number;
  /** Reserved for future cross-margin modeling; backtest currently models
   *  isolated-margin liquidation regardless. */
  marginMode?: "isolated" | "cross";
}

interface PartialExitRecord {
  reason: "tp1" | "tp2";
  qty: number;
  price: number;
  fees: number;
  pnl: number;
  time: Date;
}

interface OpenPosition {
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  /** Current stop — mutates via break-even move (Phase 4B) and trailing (Phase 4B). */
  slPrice: number;
  /** Final target — immutable after entry, exactly like live's `trades.takeProfit`. */
  tpPrice: number;
  /** Original planned stop before any break-even/trailing move — R-multiples
   *  for TP1/TP2/trailing are always measured from this, matching
   *  TradeManager's use of `trades.plannedStopLoss` (Phase 4A parity). */
  plannedSlPrice: number;
  /** Original full entry size — immutable. */
  qty: number;
  /** Shrinks as TP1/TP2 partials fill. What's left to close via the final exit. */
  remainingQty: number;
  entryTime: Date;
  confidence: number;
  /** Entry-side fee only; exit-side fees are computed per-slice at close time. */
  fees: number;
  slippage: number;
  /** Futures only: estimated isolated-margin liquidation price. Undefined for
   *  spot / 1x, where liquidation can't occur. */
  liquidationPrice?: number;
  strategyId?: string;
  strategyName?: string;
  regime?: string;
  /** Phase 4C: running Maximum Favorable/Adverse Excursion, in USDT, updated every bar. */
  mfe: number;
  mae: number;
  // ── Phase 7: trade-management ladder (mirrors trades.* / TradeManager) ─────
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

/**
 * Aggregate candles into larger time slots (e.g. 1m → 15m, 1m → 1h).
 * Works for any primary timeframe and any target slot size.
 */
function aggregateCandles(candles: Candle[], targetMs: number): Candle[] {
  if (candles.length === 0) return [];
  const result: Candle[] = [];
  let slotTs = -1;
  let o = 0, h = -Infinity, l = Infinity, c = 0, v = 0;

  for (const candle of candles) {
    const slot = Math.floor(candle[0] / targetMs) * targetMs;
    if (slot !== slotTs) {
      if (slotTs >= 0) result.push([slotTs, o, h, l, c, v]);
      slotTs = slot;
      o = candle[1]; h = candle[2]; l = candle[3]; c = candle[4]; v = candle[5];
    } else {
      if (candle[2] > h) h = candle[2];
      if (candle[3] < l) l = candle[3];
      c = candle[4];
      v += candle[5];
    }
  }
  if (slotTs >= 0) result.push([slotTs, o, h, l, c, v]);
  return result;
}

/**
 * Binary-search the aggregated candle array for the window of `windowSize`
 * bars whose last bar has timestamp ≤ primaryTs.
 * Returns null when there is insufficient warmup data.
 */
function getAggregatedWindow(
  aggCandles: Candle[],
  primaryTs: number,
  windowSize = 51
): Candle[] | null {
  if (aggCandles.length < windowSize) return null;
  let lo = 0, hi = aggCandles.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (aggCandles[mid]![0] <= primaryTs) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < windowSize - 1) return null;
  return aggCandles.slice(idx - windowSize + 1, idx + 1);
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
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalReturn =
    startingBalance > 0 ? (endingBalance - startingBalance) / startingBalance : 0;

  const averageWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const averageLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
  const expectancy = totalTrades > 0 ? totalPnl / totalTrades : 0;

  let maxDrawdown = 0;
  let peak = equityCurve[0] ?? startingBalance;
  for (const bal of equityCurve) {
    if (bal > peak) peak = bal;
    const dd = peak > 0 ? (peak - bal) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

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
    const stWins = st.filter((t) => t.pnl > 0);
    const stLosses = st.filter((t) => t.pnl <= 0);
    const stGrossProfit = stWins.reduce((s, t) => s + t.pnl, 0);
    const stGrossLoss = Math.abs(stLosses.reduce((s, t) => s + t.pnl, 0));
    return {
      strategyId, strategyName,
      trades: st.length,
      winRate: st.length > 0 ? stWins.length / st.length : 0,
      pnl: st.reduce((s, t) => s + t.pnl, 0),
      profitFactor: stGrossLoss > 0 ? stGrossProfit / stGrossLoss : stGrossProfit > 0 ? 999 : 0,
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
  const {
    symbols, timeframe, startDate, endDate, startingBalance,
    feeRate = DEFAULT_FEE_RATE, slippageRate = DEFAULT_SLIPPAGE_RATE,
  } = params;

  // Futures leverage modeling. Leverage affects ONLY liquidation risk here,
  // not position size — matching the live engine's notional-based sizing (see
  // futuresMath.ts). Spot (default) leaves leverage at 1 → no liquidation and
  // zero behavior change from before this feature.
  const isFutures = params.marketType === "futures";
  const leverage = isFutures ? Math.max(1, Math.floor(params.leverage ?? 1)) : 1;
  const modelsLiquidation = isFutures && leverage > 1;
  let liquidationRejectedEntries = 0; // entries the live liquidation guard would refuse

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

    const WARMUP = 51; // candle windows need 51 bars
    const warmupMs = WARMUP * tfMs;
    // Minimum 3-day warmup so EMA50(1h) has ≥ 51 hourly bars available
    const downloadStart = startMs - Math.max(warmupMs * 3, 3 * DAY_MS);

    for (let i = 0; i < symbols.length; i++) {
      if (cancelledRuns.has(runId)) throw new Error("cancelled");
      await ensureCandles(symbols[i]!, timeframe, downloadStart, endMs);
      await db
        .update(backtestRunsTable)
        .set({ progress: Math.round(((i + 1) / symbols.length) * 40) })
        .where(eq(backtestRunsTable.id, runId));
    }

    // ── Phase 2: Load candles and build aggregated TF maps ────────────────────
    logger.info({ runId }, "Backtest: loading candles and building multi-TF arrays");

    const symbolCandles = new Map<string, Candle[]>();
    // Aggregated arrays for 3m / 5m / 15m / 1h derived from primary TF
    const sym3m  = new Map<string, Candle[]>();
    const sym5m  = new Map<string, Candle[]>();
    const sym15m = new Map<string, Candle[]>();
    const sym1h  = new Map<string, Candle[]>();

    for (const symbol of symbols) {
      const candles = await loadCandles(symbol, timeframe, downloadStart, endMs);
      symbolCandles.set(symbol, candles);

      if (tfMs <= 60_000) {
        // Primary is 1m — aggregate up to all required timeframes
        sym3m.set(symbol,  aggregateCandles(candles, 3 * 60_000));
        sym5m.set(symbol,  aggregateCandles(candles, 5 * 60_000));
        sym15m.set(symbol, aggregateCandles(candles, 15 * 60_000));
        sym1h.set(symbol,  aggregateCandles(candles, HOUR_MS));
      } else if (tfMs < HOUR_MS) {
        // Primary is 3m / 5m / 15m — aggregate only the coarser TFs
        sym3m.set(symbol,  tfMs <= 3 * 60_000 ? aggregateCandles(candles, 3 * 60_000) : candles);
        sym5m.set(symbol,  tfMs <= 5 * 60_000 ? aggregateCandles(candles, 5 * 60_000) : candles);
        sym15m.set(symbol, tfMs <= 15 * 60_000 ? aggregateCandles(candles, 15 * 60_000) : candles);
        sym1h.set(symbol,  aggregateCandles(candles, HOUR_MS));
      } else {
        // Primary is 1h or coarser — use as-is for all timeframes
        sym3m.set(symbol, candles);
        sym5m.set(symbol, candles);
        sym15m.set(symbol, candles);
        sym1h.set(symbol, candles);
      }
    }

    // ── Strategy configs from DB (with defaults for any missing strategy) ──────
    const dbStrategyConfigs = await loadStrategyConfigs(userId);

    // Diagnostic checkpoint 2: what's actually sitting in Postgres right now
    // (this is the LIVE bot's configuration too — loadStrategyConfigs() is
    // shared with botEngine.ts). Logged BEFORE the override below so a
    // diff against BACKTEST_EFFECTIVE_CONFIG shows exactly what changed.
    logger.info(
      {
        runId,
        dbConfigs: [...dbStrategyConfigs.entries()].map(([id, c]) => ({
          strategyId: id, stopLossPercent: c.stopLossPercent, takeProfitPercent: c.takeProfitPercent,
          confidenceThreshold: c.confidenceThreshold, riskPercent: c.riskPercent, enabled: c.enabled,
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
      ? buildPerStrategyBacktestConfigs(dbStrategyConfigs)
      : buildEffectiveBacktestConfigs(dbStrategyConfigs, params);
    const strategyConfigs = effectiveConfig.configs;

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
    const equityTimeSeries: Array<{ ts: Date; balance: number; drawdown: number }> = [];

    const openPositions: OpenPosition[] = [];
    let dailyPnl = 0;
    let lastDailyReset = startDate.toISOString().split("T")[0]!;
    // Audit finding: the backtest previously had NO cooldown modeling at all
    // — a symbol could be re-entered on the very next candle after closing,
    // whereas live trading enforces a per-symbol cooldown after every exit.
    // Mirrors botEngine's symbolCooldowns Map<symbol, expiryTimestampMs>.
    const symbolCooldownExpiry = new Map<string, number>();

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
      const now = new Date(ts);
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

        // Futures Phase: a short's favorable direction is DOWN (mirror of
        // long) — every directional calc in this loop branches on this.
        const isShort = pos.side === "short";

        // Phase 4C: update running MFE/MAE with this bar's range before
        // evaluating exits, so a bar that both makes a new excursion AND
        // triggers the exit still has that excursion counted.
        const favorableExcursion = isShort ? (pos.entryPrice - low) * pos.qty : (high - pos.entryPrice) * pos.qty;
        const adverseExcursion = isShort ? (pos.entryPrice - high) * pos.qty : (low - pos.entryPrice) * pos.qty;
        if (favorableExcursion > pos.mfe) pos.mfe = favorableExcursion;
        if (adverseExcursion < pos.mae) pos.mae = adverseExcursion;

        const posStratCfg = pos.strategyId ? strategyConfigs.get(pos.strategyId) : undefined;

        // ── Phase 7: trade management (TP1 → TP2 → trailing) ────────────────
        // Mirrors TradeManager.manage()'s control flow exactly (same order,
        // same conditions) — see tradeManager.ts. Runs BEFORE the final
        // exit check below so a partial fill / break-even move / trailing
        // tighten this same candle is reflected in that check, exactly as
        // it would be live (TradeManager runs before ExitManager each tick).
        if (posStratCfg && posStratCfg.tp1RMultiple > 0) {
          // TP1: partial close + move stop to break-even. Long TP1 sits above
          // entry (triggered by a high); short TP1 sits below (triggered by
          // a low) — mirror of live's TradeManager.
          if (!pos.tp1Filled && pos.tp1Price > 0 && (isShort ? low <= pos.tp1Price : high >= pos.tp1Price)) {
            // Worse fill = lower for a long's sell-to-exit, higher for a
            // short's buy-to-cover.
            const fillP = pos.tp1Price * (isShort ? 1 + slippageRate : 1 - slippageRate);
            const qty = Math.min(pos.tp1Qty, pos.remainingQty);
            if (qty > 0) {
              const entryFeeShare = pos.entryPrice * qty * feeRate;
              const exitFee = fillP * qty * feeRate;
              const fees = entryFeeShare + exitFee;
              const pnl = (isShort ? pos.entryPrice - fillP : fillP - pos.entryPrice) * qty - fees;
              pos.partialExits.push({ reason: "tp1", qty, price: fillP, fees, pnl, time: now });
              pos.remainingQty -= qty;
              pos.tp1Filled = true;
              pos.tp1FillPrice = fillP;
              pos.tp1FillTime = now;
              pos.slPrice = pos.entryPrice; // break-even move
              pos.breakEvenActive = true;
            }
          }
          // TP2 (only when tp3Enabled): partial close of another slice.
          // Remainder keeps targeting the strategy's own final tpPrice
          // (untouched) — TP1/TP2 are interior waypoints, never beyond it.
          if (posStratCfg.tp3Enabled && pos.tp1Filled && !pos.tp2Filled && pos.tp2Price > 0 && (isShort ? low <= pos.tp2Price : high >= pos.tp2Price)) {
            const fillP = pos.tp2Price * (isShort ? 1 + slippageRate : 1 - slippageRate);
            const qty = Math.min(pos.tp2Qty, pos.remainingQty);
            if (qty > 0) {
              const entryFeeShare = pos.entryPrice * qty * feeRate;
              const exitFee = fillP * qty * feeRate;
              const fees = entryFeeShare + exitFee;
              const pnl = (isShort ? pos.entryPrice - fillP : fillP - pos.entryPrice) * qty - fees;
              pos.partialExits.push({ reason: "tp2", qty, price: fillP, fees, pnl, time: now });
              pos.remainingQty -= qty;
              pos.tp2Filled = true;
              pos.tp2FillPrice = fillP;
              pos.tp2FillTime = now;
              // TP2 does not move the stop further — only TP1 does (matches TradeManager).
            }
          }
          // Trailing stop (normal or emergency) — same formula as live
          // (computeTrailingStop, shared from tradeManager.ts), only ever
          // tightens the stop (raises it for a long, lowers it for a short),
          // never loosens it.
          const currentClose = currentCandle[4];
          const originalRiskDistance = isShort ? pos.plannedSlPrice - pos.entryPrice : pos.entryPrice - pos.plannedSlPrice;
          if (originalRiskDistance > 0) {
            const unrealizedR = (isShort ? pos.entryPrice - currentClose : currentClose - pos.entryPrice) / originalRiskDistance;
            const trailingArmed = pos.tp1Filled || !posStratCfg.trailingAfterTp1Only;
            const emergencyArmed =
              !trailingArmed &&
              posStratCfg.emergencyTrailingRMultiple > 0 &&
              unrealizedR >= posStratCfg.emergencyTrailingRMultiple;
            if ((trailingArmed && posStratCfg.trailingStopMode !== "none") || emergencyArmed) {
              const mode = emergencyArmed ? "emergency" : posStratCfg.trailingStopMode;
              // Documented limitation (see Q3 in the Phase 6 audit): the
              // backtest has no independently-loaded true 1-minute candle
              // series — `candles` here is whatever primary timeframe the
              // user selected, same convention already used for tf1m
              // elsewhere in this file. ATR-based trailing on a coarser
              // primary timeframe will be proportionally wider than live's
              // (which always computes ATR on real 1m data). Flagged in
              // CHANGES.md as a Phase 8 follow-up, not silently assumed correct.
              const candidate = computeTrailingStop(mode, currentClose, candles.slice(0, idx + 1), posStratCfg, emergencyArmed, isShort);
              if (isShort ? candidate < pos.slPrice : candidate > pos.slPrice) {
                pos.slPrice = candidate;
                pos.trailingStopActive = true;
                pos.trailingStopMode = mode;
              }
            }
          }
        }

        // ── Final exit check: stop / target / timeout ────────────────────────
        // NOTE: if a single candle's range touches both the stop and the
        // target, OHLC data alone can't tell us which was hit first (no tick
        // data). When multiple conditions are true in the same candle, we
        // resolve using the strategy's configured `exitPriority` (Phase 7 —
        // previously this order was hardcoded stop→target→timeout regardless
        // of config, and `exitPriority` was loaded but never actually read
        // anywhere, live or backtest — see Phase 6 audit). Falls back to the
        // historical stop→target→timeout order — the conservative,
        // never-overstates-results assumption — when exitPriority is empty
        // or doesn't cover what triggered.
        // A short's stop sits ABOVE entry (hit by a high) and target sits
        // BELOW (hit by a low) — mirror of long.
        const stopTouched = isShort ? high >= pos.slPrice : low <= pos.slPrice;
        const targetTouched = isShort ? low <= pos.tpPrice : high >= pos.tpPrice;
        const holdSecs = (now.getTime() - pos.entryTime.getTime()) / 1000;
        const timedOut = !!posStratCfg && holdSecs >= posStratCfg.maxHoldingSeconds;

        // Worse fill for the CLOSING trade: lower for a long (sells to
        // close), higher for a short (buys to close).
        const closeSlippageMult = isShort ? 1 + slippageRate : 1 - slippageRate;
        const stopLabel = pos.trailingStopActive ? "trailing_stop" : pos.breakEvenActive ? "break_even" : "stop_loss";
        type Candidate = { key: string; reason: string; exitPrice: number };
        const candidates: Candidate[] = [];
        if (stopTouched) candidates.push({ key: "stop_loss", reason: stopLabel, exitPrice: pos.slPrice * closeSlippageMult });
        if (stopTouched && pos.trailingStopActive) candidates.push({ key: "trailing_stop", reason: stopLabel, exitPrice: pos.slPrice * closeSlippageMult });
        if (targetTouched) candidates.push({ key: "take_profit", reason: "take_profit", exitPrice: pos.tpPrice * closeSlippageMult });
        if (timedOut) candidates.push({ key: "timeout", reason: "timeout", exitPrice: currentCandle[4] * closeSlippageMult });
        // Futures liquidation: a forced close at the liquidation price (loss ≈
        // the posted margin). The entry guard keeps the stop INSIDE the
        // liquidation price, so any candle reaching liquidation also reached
        // the (closer) stop — the priority list resolves that co-touch to the
        // stop, which fills first on the way there. Liquidation is therefore
        // only chosen when it's the sole trigger. It's kept out of the
        // priority list intentionally so it never pre-empts a nearer stop.
        if (pos.liquidationPrice !== undefined) {
          const liqTouched = isShort ? high >= pos.liquidationPrice : low <= pos.liquidationPrice;
          if (liqTouched) candidates.push({ key: "liquidation", reason: "liquidation", exitPrice: pos.liquidationPrice * closeSlippageMult });
        }

        let chosen: Candidate | null = null;
        if (candidates.length === 1) {
          chosen = candidates[0]!;
        } else if (candidates.length > 1) {
          const priority = posStratCfg?.exitPriority?.length ? posStratCfg.exitPriority : ["stop_loss", "take_profit", "trailing_stop", "timeout"];
          for (const key of priority) {
            const match = candidates.find((c) => c.key === key);
            if (match) { chosen = match; break; }
          }
          chosen ??= candidates[0]!; // safety net — should be unreachable given the fallback priority list above
        }

        if (chosen && chosen.exitPrice > 0) {
          const { reason: exitReason, exitPrice } = chosen;
          const exitQty = pos.remainingQty;
          const exitFees = exitPrice * exitQty * feeRate;
          const finalSlicePnl = (isShort ? pos.entryPrice - exitPrice : exitPrice - pos.entryPrice) * exitQty - exitFees;
          const partialPnl = pos.partialExits.reduce((s, p) => s + p.pnl, 0);
          const partialFees = pos.partialExits.reduce((s, p) => s + p.fees, 0);
          const pnl = finalSlicePnl + partialPnl; // NET total across every slice
          const grossPnl = (isShort ? pos.entryPrice - exitPrice : exitPrice - pos.entryPrice) * exitQty
            + pos.partialExits.reduce((s, p) => s + (isShort ? pos.entryPrice - p.price : p.price - pos.entryPrice) * p.qty, 0);
          const totalFees = pos.fees + exitFees + partialFees;
          const durationSeconds = Math.round((now.getTime() - pos.entryTime.getTime()) / 1000);
          // Note: this ratio is direction-agnostic — for a short, both
          // (tpPrice - entryPrice) and (entryPrice - plannedSlPrice) are
          // negative, so the ratio comes out the same sign as long's.
          const riskReward =
            pos.entryPrice - pos.plannedSlPrice !== 0
              ? (pos.tpPrice - pos.entryPrice) / (pos.entryPrice - pos.plannedSlPrice)
              : 0;
          const notional = pos.entryPrice * pos.qty;

          balance += pnl;
          dailyPnl += pnl;
          if (balance > peakBalance) peakBalance = balance;

          allTrades.push({
            symbol, side: pos.side, entryTime: pos.entryTime, exitTime: now,
            entryPrice: pos.entryPrice, exitPrice,
            qty: pos.qty, slPrice: pos.slPrice, tpPrice: pos.tpPrice,
            fees: totalFees,
            slippage: Math.abs(pos.slippage) + Math.abs(exitPrice * exitQty * slippageRate),
            pnl, grossPnl,
            // Phase 6 audit fix: net-of-fees now, not gross — previously this
            // could show a positive % on a net-losing trade (confirmed in
            // bt6: 30/30 take-profit exits were net losers with a positive
            // pnlPercent under the old gross-only formula).
            pnlPercent: notional > 0 ? (pnl / notional) * 100 : 0,
            confidence: pos.confidence, exitReason, durationSeconds,
            strategyId: pos.strategyId,
            strategyName: pos.strategyName,
            regime: pos.regime,
            mfe: pos.mfe, mae: pos.mae, riskReward,
            tp1Price: pos.tp1Price, tp1Qty: pos.tp1Qty, tp1Filled: pos.tp1Filled,
            tp1FillPrice: pos.tp1FillPrice, tp1FillTime: pos.tp1FillTime,
            tp2Price: pos.tp2Price, tp2Qty: pos.tp2Qty, tp2Filled: pos.tp2Filled,
            tp2FillPrice: pos.tp2FillPrice, tp2FillTime: pos.tp2FillTime,
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

      // ── Entry signal ──────────────────────────────────────────────────────
      const circuitBreakerActive = dailyPnl <= -Math.abs(params.dailyLossLimitUsdt);
      const atMaxPositions = openPositions.length >= params.maxOpenPositions;
      const alreadyInSymbol = openPositions.some((p) => p.symbol === symbol);
      const onCooldown = (symbolCooldownExpiry.get(symbol) ?? 0) > now.getTime();

      if (circuitBreakerActive || atMaxPositions || alreadyInSymbol || onCooldown) continue;

      // Build 51-candle windows for each timeframe at this timestamp
      const primaryWindow = candles.slice(idx - WARMUP, idx + 1);

      const window3m  = getAggregatedWindow(sym3m.get(symbol)!,  ts, WARMUP) ?? primaryWindow;
      const window5m  = getAggregatedWindow(sym5m.get(symbol)!,  ts, WARMUP) ?? primaryWindow;
      const window15m = getAggregatedWindow(sym15m.get(symbol)!, ts, WARMUP) ?? primaryWindow;
      const window1h  = getAggregatedWindow(sym1h.get(symbol)!,  ts, WARMUP) ?? primaryWindow;

      const mtf: MultiTimeframeCandles = {
        tf1m:  primaryWindow,
        tf3m:  window3m,
        tf5m:  window5m,
        tf15m: window15m,
        tf1h:  window1h,
      };

      // Phase 2: multi-strategy evaluation — pass current balance for risk-based sizing
      const row = buildSignalRow(symbol, mtf);
      const signals = strategySelector.evaluateSymbol(
        symbol, mtf, row, strategyConfigs, balance, params.positionSizeUsdt
      );
      if (signals.length === 0) continue;
      const bestSignal = signals[0]!;

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
        (Math.abs(bestSignal.entryPrice - bestSignal.suggestedSL) / bestSignal.entryPrice) * 100;

      // Entry slippage direction mirrors the real fill mechanics: a long
      // BUYs to open (pays slightly more), a short SELLs to open (receives
      // slightly less) — same convention botEngine.ts uses for live fills.
      const fillPrice = bestSignal.entryPrice * (isShortSignal ? 1 - slippageRate : 1 + slippageRate);
      const entryFees = fillPrice * bestSignal.qty * feeRate;
      const entrySlippage = (fillPrice - bestSignal.entryPrice) * bestSignal.qty;

      // Diagnostic: the actual stopLossPercent/takeProfitPercent/confidenceThreshold/
      // riskPercent this specific strategy used to produce this specific trade — the
      // direct answer to "values actually passed into every strategy."
      const usedConfig = strategyConfigs.get(bestSignal.strategyId);
      logger.debug(
        {
          runId, symbol, strategyId: bestSignal.strategyId,
          stopLossPercent: usedConfig?.stopLossPercent, takeProfitPercent: usedConfig?.takeProfitPercent,
          confidenceThreshold: usedConfig?.confidenceThreshold, riskPercent: usedConfig?.riskPercent,
          entryPrice: bestSignal.entryPrice, suggestedSL: bestSignal.suggestedSL, suggestedTP: bestSignal.suggestedTP,
          confidence: bestSignal.confidence, slDistancePercent: slDistancePercent.toFixed(3),
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
      const slDistance = isShortSignal ? bestSignal.suggestedSL - signalEntry : signalEntry - bestSignal.suggestedSL;
      const tpDistance = isShortSignal ? signalEntry - bestSignal.suggestedTP : bestSignal.suggestedTP - signalEntry;
      const realSlPrice = isShortSignal ? fillPrice + slDistance : fillPrice - slDistance;
      const realTpPrice = isShortSignal ? fillPrice - tpDistance : fillPrice + tpDistance;

      // Futures liquidation guard (parity with live botEngine.enterTrade): a
      // leveraged position whose stop sits too close to the liquidation price
      // would be liquidated before the stop can protect it, so the live engine
      // refuses the entry. Replicate that here so a too-aggressive leverage
      // (e.g. 50x with a 1.5% stop) shows the SAME "few/no trades" outcome the
      // live bot would produce, instead of pretending the trades happen.
      let liquidationPrice: number | undefined;
      if (modelsLiquidation) {
        liquidationPrice = estimateLiquidationPrice(fillPrice, bestSignal.side, leverage);
        if (stopTooCloseToLiquidation(realSlPrice, liquidationPrice, bestSignal.side)) {
          liquidationRejectedEntries++;
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

      openPositions.push({
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
      });
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
      const finalSlicePnl = (isShort ? pos.entryPrice - exitPrice : exitPrice - pos.entryPrice) * exitQty - exitFees;
      const partialPnl = pos.partialExits.reduce((s, p) => s + p.pnl, 0);
      const partialFees = pos.partialExits.reduce((s, p) => s + p.fees, 0);
      const pnl = finalSlicePnl + partialPnl;
      const grossPnl =
        (isShort ? pos.entryPrice - exitPrice : exitPrice - pos.entryPrice) * exitQty +
        pos.partialExits.reduce((s, p) => s + (isShort ? pos.entryPrice - p.price : p.price - pos.entryPrice) * p.qty, 0);
      const totalFees = pos.fees + exitFees + partialFees;
      const riskReward =
        pos.entryPrice - pos.plannedSlPrice !== 0
          ? (pos.tpPrice - pos.entryPrice) / (pos.entryPrice - pos.plannedSlPrice)
          : 0;
      const notional = pos.entryPrice * pos.qty;
      balance += pnl;
      allTrades.push({
        symbol: pos.symbol, entryTime: pos.entryTime, exitTime: new Date(lastCandle[0]),
        entryPrice: pos.entryPrice, exitPrice,
        qty: pos.qty, slPrice: pos.slPrice, tpPrice: pos.tpPrice,
        fees: totalFees, slippage: pos.slippage,
        pnl, grossPnl,
        pnlPercent: notional > 0 ? (pnl / notional) * 100 : 0,
        confidence: pos.confidence, exitReason: "end_of_backtest",
        durationSeconds: Math.round((lastCandle[0] - pos.entryTime.getTime()) / 1000),
        strategyId: pos.strategyId,
        strategyName: pos.strategyName,
        regime: pos.regime,
        mfe: pos.mfe, mae: pos.mae, riskReward,
        tp1Price: pos.tp1Price, tp1Qty: pos.tp1Qty, tp1Filled: pos.tp1Filled,
        tp1FillPrice: pos.tp1FillPrice, tp1FillTime: pos.tp1FillTime,
        tp2Price: pos.tp2Price, tp2Qty: pos.tp2Qty, tp2Filled: pos.tp2Filled,
        tp2FillPrice: pos.tp2FillPrice, tp2FillTime: pos.tp2FillTime,
        breakEvenActive: pos.breakEvenActive,
        trailingStopActive: pos.trailingStopActive,
        trailingStopMode: pos.trailingStopMode,
        partialExits: pos.partialExits,
        side: pos.side,
      });
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
          runId, symbol: t.symbol, side: t.side === "short" ? ("sell" as const) : ("buy" as const),
          entryTime: t.entryTime, exitTime: t.exitTime,
          entryPrice: t.entryPrice.toFixed(8), exitPrice: t.exitPrice.toFixed(8),
          quantity: t.qty.toFixed(8), stopLoss: t.slPrice.toFixed(8),
          takeProfit: t.tpPrice.toFixed(8), fees: t.fees.toFixed(8),
          slippage: t.slippage.toFixed(8), pnl: t.pnl.toFixed(8),
          grossPnl: t.grossPnl.toFixed(8),
          pnlPercent: t.pnlPercent.toFixed(4), confidence: t.confidence.toFixed(2),
          exitReason: t.exitReason, durationSeconds: t.durationSeconds,
          mfe: t.mfe.toFixed(8), mae: t.mae.toFixed(8), riskReward: t.riskReward.toFixed(4),
          ...(t.strategyId   && { strategyId: t.strategyId }),
          ...(t.strategyName && { strategyName: t.strategyName }),
          ...(t.regime       && { marketRegime: t.regime }),
          // Phase 7: trade-management parity fields
          ...(t.tp1Price > 0 && { tp1Price: t.tp1Price.toFixed(8), tp1Quantity: t.tp1Qty.toFixed(8) }),
          tp1Filled: t.tp1Filled,
          ...(t.tp1FillPrice != null && { tp1FillPrice: t.tp1FillPrice.toFixed(8) }),
          ...(t.tp1FillTime != null && { tp1FillTime: t.tp1FillTime }),
          ...(t.tp2Price > 0 && { tp2Price: t.tp2Price.toFixed(8), tp2Quantity: t.tp2Qty.toFixed(8) }),
          tp2Filled: t.tp2Filled,
          ...(t.tp2FillPrice != null && { tp2FillPrice: t.tp2FillPrice.toFixed(8) }),
          ...(t.tp2FillTime != null && { tp2FillTime: t.tp2FillTime }),
          breakEvenActive: t.breakEvenActive,
          trailingStopActive: t.trailingStopActive,
          ...(t.trailingStopMode && { trailingStopMode: t.trailingStopMode }),
        }));
        const inserted = await db.insert(backtestTradesTable).values(batch).returning({ id: backtestTradesTable.id });
        for (let j = 0; j < inserted.length; j++) {
          const partials = chunk[j]!.partialExits;
          if (partials.length > 0) {
            pendingPartialExits.push({ backtestTradeId: inserted[j]!.id, partials });
          }
        }
      }
    }

    if (pendingPartialExits.length > 0) {
      const flatRows = pendingPartialExits.flatMap(({ backtestTradeId, partials }) =>
        partials.map((p) => ({
          backtestTradeId, reason: p.reason, quantity: p.qty.toFixed(8),
          price: p.price.toFixed(8), fees: p.fees.toFixed(8), pnl: p.pnl.toFixed(8), time: p.time,
        })),
      );
      for (let i = 0; i < flatRows.length; i += 200) {
        await db.insert(backtestTradePartialExitsTable).values(flatRows.slice(i, i + 200));
      }
    }

    const equityCurveData = downsample(equityTimeSeries, 2000);
    if (equityCurveData.length > 0) {
      for (let i = 0; i < equityCurveData.length; i += 500) {
        const batch = equityCurveData.slice(i, i + 500).map((p) => ({
          runId, timestamp: p.ts,
          balance: p.balance.toFixed(2), drawdown: p.drawdown.toFixed(4),
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
        status: "completed", progress: 100,
        endingBalance: balance.toFixed(2),
        totalReturn:   metrics.totalReturn.toFixed(4),
        totalPnl:      metrics.totalPnl.toFixed(2),
        totalTrades:   metrics.totalTrades,
        winningTrades: metrics.winningTrades,
        losingTrades:  metrics.losingTrades,
        winRate:       metrics.winRate.toFixed(4),
        profitFactor:  metrics.profitFactor.toFixed(4),
        sharpeRatio:   metrics.sharpeRatio.toFixed(4),
        sortinoRatio:  metrics.sortinoRatio.toFixed(4),
        maxDrawdown:   metrics.maxDrawdown.toFixed(4),
        averageWin:    metrics.averageWin.toFixed(8),
        averageLoss:   metrics.averageLoss.toFixed(8),
        expectancy:    metrics.expectancy.toFixed(8),
        largestWin:    metrics.largestWin.toFixed(8),
        largestLoss:   metrics.largestLoss.toFixed(8),
        dailyReturns:  metrics.dailyReturns,
        monthlyReturns: metrics.monthlyReturns,
        strategyComparison: metrics.strategyComparison,
        tp1HitRate: metrics.tp1HitRate.toFixed(4),
        tp2HitRate: metrics.tp2HitRate.toFixed(4),
        breakEvenRate: metrics.breakEvenRate.toFixed(4),
        trailingStopRate: metrics.trailingStopRate.toFixed(4),
      })
      .where(eq(backtestRunsTable.id, runId));

    logger.info(
      { runId, ...metrics, effectiveConfigApplied: effectiveConfig.runLevelOverrides },
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
