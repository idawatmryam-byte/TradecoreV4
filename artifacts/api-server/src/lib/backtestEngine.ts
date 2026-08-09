/**
 * TradeCore Pro â€” Backtest Engine  (Phase 1 Professional Engine)
 *
 * Replays historical candles using the EXACT same strategy logic as the live
 * BotEngine â€” buildSignalRow from strategy.ts + the same per-strategy
 * evaluate() functions (strategies/*.ts) the live engine uses.
 *
 * Key improvements over legacy engine:
 * - 5-timeframe support (1m / 3m / 5m / 15m / 1h) derived by aggregating
 *   the primary-timeframe download â€” no extra Binance requests.
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
  /** Stop-loss distance as a % below entry (Phase 5A â€” replaces atrMultiplierSl) */
  stopLossPercent: number;
  /** Take-profit distance as a % above entry (Phase 5A â€” replaces atrMultiplierTp) */
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
   *  PASSIVE fills â€” take-profit limit exits always, and maker entries when
   *  makerEntry is on. Defaults to feeRate when unset (no maker benefit). */
  makerFeeRate?: number;
  /**
   * Model entries as post-only MAKER limit orders instead of taker markets.
   * HONEST fill modeling: the limit rests at the signal price and only fills
   * if a LATER candle trades through it within makerEntryFillWindowMinutes;
   * if price never comes back, the trade is SKIPPED (a missed entry). On fill
   * there is no adverse entry slippage (you were the passive side) and the
   * maker fee applies. This trades cheaper/better fills AGAINST missed trades
   * â€” charging maker fees while still filling every signal at market would be
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
  /** Faithful mode only: reshape every strategy to TP = its own SL Ã— this
   *  ratio (e.g. 3 â†’ 1:3 reward:risk), keeping all other per-strategy config
   *  faithful. 0/undefined = off. */
  rrRatio?: number;
  /** Faithful mode only: disable TP1/break-even/trailing so trades resolve
   *  only at the full SL or TP â€” required to evaluate asymmetric-R:R styles
   *  the management layer would otherwise clip at ~1R. */
  pureExits?: boolean;
  /** Faithful mode only: multiply every strategy's maxHoldingSeconds (swing-
   *  profile test â€” adaptive targets grow ~âˆšhold, amortizing fees). 1 = off. */
  holdMultiplier?: number;
  /** Optimization Autopsy (faithful mode only): patch ONE strategy's config
   *  for this run â€” the candidate parameter set under test. Never persisted. */
  strategyOverride?: { strategyId: string; patch: Record<string, unknown> };

  // â”€â”€ Futures leverage modeling (spot is the default when unset) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  /** "spot" (no leverage/liquidation) | "futures" | "forex" (OANDA candles,
   *  forex costs, no leverage/liquidation â€” like spot with FX rates).
   *  Default "spot". */
  marketType?: "spot" | "futures" | "forex";
  /** Futures leverage. Only affects liquidation risk â€” NOT position size, to
   *  match the live engine's notional-based sizing. Default 1. */
  leverage?: number;
  /** Reserved for future cross-margin modeling; backtest currently models
   *  isolated-margin liquidation regardless. */
  marginMode?: "isolated" | "cross";

  // â”€â”€ Dollar-based risk model (Phase 8) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  /**
   * "percent" (default): SL/TP come from stopLossPercent/takeProfitPercent.
   * "dollar": the strategy's %-based SL/TP/size are overridden by the fixed
   * max-loss / target-profit plan (lib/dollarRisk.ts) â€” the SAME planner the
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
   * this run â€” so the result is purely that strategy's, using its own saved
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
  /** Gross (pre-fee) profit â€” see grossPnl comment on the DB column for why
   *  this is tracked separately from pnl (Phase 6 audit finding: pnlPercent
   *  used to be computed gross-of-fees while pnl was net, an inconsistent,
   *  misleading pair). */
  grossPnl: number;
  /** Now net-of-fees, computed from `pnl` â€” see Phase 6 audit / CHANGES.md. */
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
  // â”€â”€ Phase 7 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
 * Aggregate candles into larger time slots (e.g. 1m â†’ 15m, 1m â†’ 1h).
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
 * bars whose last bar has timestamp â‰¤ primaryTs.
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

  // â”€â”€ Phase 4C: calendar daily/monthly return series, grouped by exit date â”€â”€
  // (Approximation: return % is pnl / startingBalance for that period, not
  // compounded against the running balance â€” simple and transparent, but
  // note it isn't a true time-weighted return.)
  const dailyBuckets = new Map<string, number>();
  const monthlyBuckets = new Map<string, number>();
  for (const t of trades) {
    const iso = t.exitTime.toISOString();
    const day = iso.slice(0, 10);
    const month = iso.slice(0, 7);
    dailyBuckets.set(day, (dailyBuckets.get(day) ?? 0) + t.pnl);
    monthlyBuckets.set×N»âÚ$z{-®éÜj×6öç7B¶W’ÒG¶&W7E6–væÂç7G&FVw”–G×ÆÆ—V–FF–öâÖwV&GÇ7F÷Föò6Æ÷6RFòÆ—V–FF–öâBG·G&FTÆWfW&vW×†°Ğ¢6öç7BvrÒFV6—6–öävrævWB†¶W’“°Ğ¢–b†vr’vræ6÷VçB²³°Ğ¢VÇ6RFV6—6–öävrç6WB†¶W’Â²7G&FVw”–C¢&W7E6–væÂç7G&FVw”–BÂ7FvS¢&Æ—V–FF–öâÖwV&B"Â&V6öã¢7F÷Föò6Æ÷6RFòÆ—V–FF–öâBG·G&FTÆWfW&vW×†Â6÷VçC¢Ò“°Ğ¢6öçF–çVS²òòÆ—fRv÷VÆBæ÷B÷VâF†—2G&FPĞ¢ĞĞ¢ĞĞ Ğ¢òò†6Rs¢EõE"–çFW&–÷"×v—ö–çBÆFFW"(	B6ÖR6†&VBf÷&×VÆĞ¢òò&÷DVæv–æRçG2W6W2†6ö×WFUGG$ÆFFW"–â7G&FVv–W2ö&6RçG2’Â6òF†PĞ¢òò&6·FW7Bæ÷r6–×VÆFW2F†R6ÖR7FvVBW†—B7G'V7GW&RÆ—fRG&F–æpĞ¢òò7GVÆÇ’'Vç2Â–ç7FVBöb6–ævÆR&–æ'’4ÂõEàĞ¢6öç7BÆFFW"ÒW6VD6öæf–pĞ¢ò6ö×WFUGG$ÆFFW"€Ğ¢f–ÆÅ&–6RÂ&VÅ6Å&–6RÂ&VÅG&–6RÂ&W7E6–væÂçG’ÂW6VD6öæf–rÀĞ¢‡’ÓâÂ‡’ÓâÂ&W7E6–væÂç6–FRÀĞ¢Ğ¢¢²G&–6S¢ÂGG“¢ÂG%&–6S¢ÂG%G“¢Ó°Ğ Ğ¢6öç7BæWu÷3¢÷Vå÷6—F–öâÒ°Ğ¢7–Ö&öÂÀĞ¢VçG'•&–6S¢f–ÆÅ&–6RÀĞ¢6Å&–6S¢&VÅ6Å&–6RÀĞ¢G&–6S¢&VÅG&–6RÀĞ¢ÆææVE6Å&–6S¢&VÅ6Å&–6RÀĞ¢G“¢&W7E6–væÂçG’ÀĞ¢&VÖ–æ–æuG“¢&W7E6–væÂçG’ÀĞ¢VçG'•F–ÖS¢æ÷rÀĞ¢6öæf–FVæ6S¢&W7E6–væÂæ6öæf–FVæ6RÀĞ¢fVW3¢VçG'”fVW2ÀĞ¢6Æ—vS¢VçG'•6Æ—vRÀĞ¢Æ—V–FF–öå&–6RÀĞ¢7G&FVw”–C¢&W7E6–væÂç7G&FVw”–BÀĞ¢7G&FVw”æÖS¢&W7E6–væÂç7G&FVw”æÖRÀĞ¢&Vv–ÖS¢&W7E6–væÂç&Vv–ÖRÀĞ¢ÆWfW&vS¢G&FTÆWfW&vRÀĞ¢Ö„†öÆE6V6öæG3¢ÖF‚ç&÷VæB†&W7E6–væÂæÖ„†öÆE6V6öæG2’ÀĞ¢W‡V7FVD†öÆE6V6öæG3¢ÖF‚ç&÷VæB†&W7E6–væÂæW‡V7FVD†öÆE6V6öæG2’ÀĞ¢VçG'•&V6öã¢&W7E6–væÂç&W÷'Bç7VÖÖ'’ÀĞ¢G&FUÆã¢&W7E6–væÂÀĞ¢ÖfS¢ÀĞ¢ÖS¢ÀĞ¢G&–6S¢ÆFFW"çG&–6RÀĞ¢GG“¢ÆFFW"çGG’ÀĞ¢Gf–ÆÆVC¢fÇ6RÀĞ¢G%&–6S¢ÆFFW"çG%&–6RÀĞ¢G%G“¢ÆFFW"çG%G’ÀĞ¢G$f–ÆÆVC¢fÇ6RÀĞ¢'&V´WfVä7F—fS¢fÇ6RÀĞ¢G&–Æ–æu7F÷7F—fS¢fÇ6RÀĞ¢'F–ÄW†—G3¢µÒÀĞ¢6–FS¢&W7E6–væÂç6–FRÀĞ¢Ó°Ğ Ğ¢–b†Ö¶W$VçG'’’°Ğ¢òò÷7BF†RÆ–Ö—BæBv—B(	B—Bf–ÆÇ2öâÆFW"&"†÷"W‡—&W2’â6VPĞ¢òòF†RVæF–ær×&W6öÇWF–öâ&Æö6²&÷fRàĞ¢VæF–ætVçG&–W2ç6WB‡7–Ö&öÂÂ°Ğ¢Æ–Ö—E&–6S¢f–ÆÅ&–6RÀĞ¢6–FS¢&W7E6–væÂç6–FRÀĞ¢W‡—&W4D×3¢æ÷rævWEF–ÖR‚’²Ö¶W$VçG'”f–ÆÅv–æF÷t×2ÀĞ¢÷3¢æWu÷2ÀĞ¢Ò“°Ğ¢ÒVÇ6R°Ğ¢÷Vå÷6—F–öç2çW6‚†æWu÷2“°Ğ¢ĞĞ¢ĞĞ Ğ¢òò)H)H6Æ÷6R&VÖ–æ–ær÷Vâ÷6—F–öç2BÆ7B6æFÆR6Æ÷6R)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H Ğ¢òò†6RbVF—BfÆr"f—ƒ¢F†W6R&RäõBvVçV–æRÖ„†öÆF–æu6V6öæG0Ğ¢òòF–ÖV÷WG2(	BF†R&6·FW7Bw2FFR&ævR6–×Ç’VæFVBv†–ÆRF†R÷6—F–öàĞ¢òòv27F–ÆÂ÷Vââ&Wf–÷W6Ç’Ö—6Æ&VÆVB'F–ÖV÷WB"Â–æfÆF–ærF†BW†—@Ğ¢òò&V6öâw26÷VçBâæ÷rW6W2F†RF—7F–æ7B&VæEööeö&6·FW7B"&V6öâ†FFV@Ğ¢òòFòW†—EG—W2çG2’6òW†—B×&V6öâ7FF—7F–72&VâwBöÆÇWFVBv—F‚Ğ¢òò6FVv÷'’F†B—6âwB&VÂG&F–ær÷WF6öÖRàĞ¢f÷"†6öç7B÷2öb÷Vå÷6—F–öç2’°Ğ¢6öç7B—56†÷'BÒ÷2ç6–FRÓÓÒ'6†÷'B#°Ğ¢6öç7B6æFÆW2Ò7–Ö&öÄ6æFÆW2ævWB‡÷2ç7–Ö&öÂ’°Ğ¢6öç7BÆ7D6æFÆRÒ6æFÆW5¶6æFÆW2æÆVæwF‚ÒÒ°Ğ¢6öç7BW†—E&–6RÒÆ7D6æFÆU³EÒ¢†—56†÷'Bò²6Æ—vU&FR¢Ò6Æ—vU&FR“°Ğ¢6öç7BW†—EG’Ò÷2ç&VÖ–æ–æuG“°Ğ¢6öç7BW†—DfVW2ÒW†—E&–6R¢W†—EG’¢fVU&FS°Ğ¢6öç7Bf–æÅ6Æ–6UæÂÒ†—56†÷'Bò÷2æVçG'•&–6RÒW†—E&–6R¢W†—E&–6RÒ÷2æVçG'•&–6R’¢W†—EG’ÒW†—DfVW3°Ğ¢6öç7B'F–ÅæÂÒ÷2ç'F–ÄW†—G2ç&VGV6R‚‡2Â’Óâ2²çæÂÂ“°Ğ¢6öç7B'F–ÄfVW2Ò÷2ç'F–ÄW†—G2ç&VGV6R‚‡2Â’Óâ2²æfVW2Â“°Ğ¢òò6ÖRVçG'’ÖfVR66÷VçF–ærf—‚2F†RÖ–âW†—B&Æö6²&÷fRàĞ¢6öç7BVçG'”fVU6†&Tf–æÂÒ÷2çG’âò÷2æfVW2¢†W†—EG’ò÷2çG’’¢÷2æfVW3°Ğ¢6öç7BæÂÒf–æÅ6Æ–6UæÂ²'F–ÅæÂÒVçG'”fVU6†&Tf–æÃ°Ğ¢6öç7Bw&÷75æÂĞĞ¢†—56†÷'Bò÷2æVçG'•&–6RÒW†—E&–6R¢W†—E&–6RÒ÷2æVçG'•&–6R’¢W†—EG’°Ğ¢÷2ç'F–ÄW†—G2ç&VGV6R‚‡2Â’Óâ2²†—56†÷'Bò÷2æVçG'•&–6RÒç&–6R¢ç&–6RÒ÷2æVçG'•&–6R’¢çG’Â“°Ğ¢6öç7BF÷FÄfVW2ÒVçG'”fVU6†&Tf–æÂ²W†—DfVW2²'F–ÄfVW3°Ğ¢6öç7B&—6µ&Wv&BĞĞ¢÷2æVçG'•&–6RÒ÷2çÆææVE6Å&–6RÓÒ Ğ¢ò‡÷2çG&–6RÒ÷2æVçG'•&–6R’ò‡÷2æVçG'•&–6RÒ÷2çÆææVE6Å&–6RĞ¢¢°Ğ¢6öç7Bæ÷F–öæÂÒ÷2æVçG'•&–6R¢÷2çG“°Ğ¢&Ææ6R³ÒæÃ°Ğ¢ÆÅG&FW2çW6‚‡°Ğ¢7–Ö&öÃ¢÷2ç7–Ö&öÂÂVçG'•F–ÖS¢÷2æVçG'•F–ÖRÂW†—EF–ÖS¢æWrFFR†Æ7D6æFÆU³Ò’ÀĞ¢VçG'•&–6S¢÷2æVçG'•&–6RÂW†—E&–6RÀĞ¢G“¢÷2çG’Â6Å&–6S¢÷2ç6Å&–6RÂG&–6S¢÷2çG&–6RÀĞ¢fVW3¢F÷FÄfVW2Â6Æ—vS¢÷2ç6Æ—vRÀĞ¢æÂÂw&÷75æÂÀĞ¢æÅW&6VçC¢æ÷F–öæÂâò‡æÂòæ÷F–öæÂ’¢¢ÀĞ¢6öæf–FVæ6S¢÷2æ6öæf–FVæ6RÂW†—E&V6öã¢&VæEööeö&6·FW7B"ÀĞ¢GW&F–öå6V6öæG3¢ÖF‚ç&÷VæB‚†Æ7D6æFÆU³ÒÒ÷2æVçG'•F–ÖRævWEF–ÖR‚’’ò’ÀĞ¢7G&FVw”–C¢÷2ç7G&FVw”–BÀĞ¢7G&FVw”æÖS¢÷2ç7G&FVw”æÖRÀĞ¢&Vv–ÖS¢÷2ç&Vv–ÖRÀĞ¢ÆWfW&vS¢÷2æÆWfW&vRÂVçG'•&V6öã¢÷2æVçG'•&V6öâÂG&FUÆã¢÷2çG&FUÆâÀĞ¢ÖfS¢÷2æÖfRÂÖS¢÷2æÖRÂ&—6µ&Wv&BÀĞ¢G&–6S¢÷2çG&–6RÂGG“¢÷2çGG’ÂGf–ÆÆVC¢÷2çGf–ÆÆVBÀĞ¢Gf–ÆÅ&–6S¢÷2çGf–ÆÅ&–6RÂGf–ÆÅF–ÖS¢÷2çGf–ÆÅF–ÖRÀĞ¢G%&–6S¢÷2çG%&–6RÂG%G“¢÷2çG%G’ÂG$f–ÆÆVC¢÷2çG$f–ÆÆVBÀĞ¢G$f–ÆÅ&–6S¢÷2çG$f–ÆÅ&–6RÂG$f–ÆÅF–ÖS¢÷2çG$f–ÆÅF–ÖRÀĞ¢'&V´WfVä7F—fS¢÷2æ'&V´WfVä7F—fRÀĞ¢G&–Æ–æu7F÷7F—fS¢÷2çG&–Æ–æu7F÷7F—fRÀĞ¢G&–Æ–æu7F÷ÖöFS¢÷2çG&–Æ–æu7F÷ÖöFRÀĞ¢'F–ÄW†—G3¢÷2ç'F–ÄW†—G2ÀĞ¢6–FS¢÷2ç6–FRÀĞ¢Ò“°Ğ¢ĞĞ Ğ¢–b†Ö¶W$VçG'’’°Ğ¢ÆövvW"æ–æfò€Ğ¢²'Vä–BÂÖ¶W$VçG'“¢G'VRÂÖ¶W$fVU&FRÂÖ¶W$VçG&–W4Ö—76VBÂf–ÆÆVC¢ÆÅG&FW2æÆVæwF‚ÒÀĞ¢&6·FW7BÖ¶W"ÖVçG'’ÖöFS¢G¶Ö¶W$VçG&–W4Ö—76VGÒÆ–Ö—BVçG&–W2W‡—&VBVæf–ÆÆVB‡&–6RæWfW"G&FVB&6²FòF†VÒ’(	BF†R†öæW7B6÷7Böb÷7F–ærÖ¶W"–ç7FVBöbF¶W"æÀĞ¢“°Ğ¢ĞĞ Ğ¢òò)H)H†6RS¢W'6—7B&W7VÇG2ƒ“(	3R’)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H Ğ¢–b†ÖöFVÇ4Æ—V–FF–öâ’°Ğ¢ÆövvW"æ–æfò€Ğ¢²'Vä–BÂÖ&¶WEG—S¢&gWGW&W2"ÂÆWfW&vRÂÆ—V–FF–öå&V¦V7FVDVçG&–W2ÒÀĞ¢&6·FW7BgWGW&W2ÖöFS¢G¶ÆWfW&vW×‚ÆWfW&vR(	BG¶Æ—V–FF–öå&V¦V7FVDVçG&–W7ÒVçG&–W2vW&R&VgW6VB&V6W6RF†R7F÷6BFöò6Æ÷6RFòÆ—V–FF–öâ†ÖF6†W2F†RÆ—fRVæv–æRw2wV&B’æÀĞ¢“°Ğ¢ĞĞ Ğ¢ÆövvW"æ–æfò‡²'Vä–BÂG&FW3¢ÆÅG&FW2æÆVæwF‚ÒÂ$&6·FW7C¢W'6—7F–ær&W7VÇG2"“°Ğ Ğ¢–b†6æ6VÆÆVE'Vç2æ†2‡'Vä–B’’F‡&÷ræWrW'&÷"‚&6æ6VÆÆVB"“°Ğ Ğ¢ÆÅG&FW2ç6÷'B‚†Â"’ÓâæVçG'•F–ÖRævWEF–ÖR‚’Ò"æVçG'•F–ÖRævWEF–ÖR‚’“°Ğ Ğ¢6öç7BVæF–æu'F–ÄW†—G3¢'&“Ç²&6·FW7EG&FT–C¢çVÖ&W#²'F–Ç3¢6–ÕG&FU²''F–ÄW†—G2%ÒÓâÒµÓ°Ğ Ğ¢–b†ÆÅG&FW2æÆVæwF‚â’°Ğ¢f÷"†ÆWB’Ò²’ÂÆÅG&FW2æÆVæwFƒ²’³Ò#’°Ğ¢6öç7B6‡Væ²ÒÆÅG&FW2ç6Æ–6R†’Â’²#“°Ğ¢6öç7B&F6‚Ò6‡Væ²æÖ‚‡B’Óâ‡°Ğ¢'Vä–BÂ7–Ö&öÃ¢Bç7–Ö&öÂÂ6–FS¢Bç6–FRÓÓÒ'6†÷'B"ò‚'6VÆÂ"26öç7B’¢‚&'W’"26öç7B’ÀĞ¢VçG'•F–ÖS¢BæVçG'•F–ÖRÂW†—EF–ÖS¢BæW†—EF–ÖRÀĞ¢VçG'•&–6S¢BæVçG'•&–6RçFôf—†VBƒ‚’ÂW†—E&–6S¢BæW†—E&–6RçFôf—†VBƒ‚’ÀĞ¢VçF—G“¢BçG’çFôf—†VBƒ‚’Â7F÷Æ÷73¢Bç6Å&–6RçFôf—†VBƒ‚’ÀĞ¢F¶U&öf—C¢BçG&–6RçFôf—†VBƒ‚’ÂfVW3¢BæfVW2çFôf—†VBƒ‚’ÀĞ¢6Æ—vS¢Bç6Æ—vRçFôf—†VBƒ‚’ÂæÃ¢BçæÂçFôf—†VBƒ‚’ÀĞ¢w&÷75æÃ¢Bæw&÷75æÂçFôf—†VBƒ‚’ÀĞ¢æÅW&6VçC¢BçæÅW&6VçBçFôf—†VBƒB’Â6öæf–FVæ6S¢Bæ6öæf–FVæ6RçFôf—†VBƒ"’ÀĞ¢W†—E&V6öã¢BæW†—E&V6öâÂGW&F–öå6V6öæG3¢BæGW&F–öå6V6öæG2ÀĞ¢ÖfS¢BæÖfRçFôf—†VBƒ‚’ÂÖS¢BæÖRçFôf—†VBƒ‚’Â&—6µ&Wv&C¢Bç&—6µ&Wv&BçFôf—†VBƒB’ÀĞ¢âââ‡Bç7G&FVw”–Bbb²7G&FVw”–C¢Bç7G&FVw”–BÒ’ÀĞ¢âââ‡Bç7G&FVw”æÖRbb²7G&FVw”æÖS¢Bç7G&FVw”æÖRÒ’ÀĞ¢âââ‡Bç&Vv–ÖRbb²Ö&¶WE&Vv–ÖS¢Bç&Vv–ÖRÒ’ÀĞ¢òòFV6—6–öâVæv–æS¢W"×G&FRÆWfW&vR²F†RÆâw2&V6öæ–æpĞ¢âââ‡BæÆWfW&vRÒçVÆÂbb²ÆWfW&vS¢BæÆWfW&vRÒ’ÀĞ¢âââ‡BæVçG'•&V6öâbb²VçG'•&V6öã¢BæVçG'•&V6öâÒ’ÀĞ¢âââ‡BçG&FUÆâÒçVÆÂbb²G&FUÆã¢BçG&FUÆâÒ’ÀĞ¢òò†6Rs¢G&FRÖÖævVÖVçB&—G’f–VÆG0Ğ¢âââ‡BçG&–6Râbb²G&–6S¢BçG&–6RçFôf—†VBƒ‚’ÂGVçF—G“¢BçGG’çFôf—†VBƒ‚’Ò’ÀĞ¢Gf–ÆÆVC¢BçGf–ÆÆVBÀĞ¢âââ‡BçGf–ÆÅ&–6RÒçVÆÂbb²Gf–ÆÅ&–6S¢BçGf–ÆÅ&–6RçFôf—†VBƒ‚’Ò’ÀĞ¢âââ‡BçGf–ÆÅF–ÖRÒçVÆÂbb²Gf–ÆÅF–ÖS¢BçGf–ÆÅF–ÖRÒ’ÀĞ¢âââ‡BçG%&–6Râbb²G%&–6S¢BçG%&–6RçFôf—†VBƒ‚’ÂG%VçF—G“¢BçG%G’çFôf—†VBƒ‚’Ò’ÀĞ¢G$f–ÆÆVC¢BçG$f–ÆÆVBÀĞ¢âââ‡BçG$f–ÆÅ&–6RÒçVÆÂbb²G$f–ÆÅ&–6S¢BçG$f–ÆÅ&–6RçFôf—†VBƒ‚’Ò’ÀĞ¢âââ‡BçG$f–ÆÅF–ÖRÒçVÆÂbb²G$f–ÆÅF–ÖS¢BçG$f–ÆÅF–ÖRÒ’ÀĞ¢'&V´WfVä7F—fS¢Bæ'&V´WfVä7F—fRÀĞ¢G&–Æ–æu7F÷7F—fS¢BçG&–Æ–æu7F÷7F—fRÀĞ¢âââ‡BçG&–Æ–æu7F÷ÖöFRbb²G&–Æ–æu7F÷ÖöFS¢BçG&–Æ–æu7F÷ÖöFRÒ’ÀĞ¢Ò’“°Ğ¢6öç7B–ç6W'FVBÒv—BF"æ–ç6W'B†&6·FW7EG&FW5F&ÆR’çfÇVW2†&F6‚’ç&WGW&æ–ær‡²–C¢&6·FW7EG&FW5F&ÆRæ–BÒ“°Ğ¢f÷"†ÆWB¢Ò²¢Â–ç6W'FVBæÆVæwFƒ²¢²²’°Ğ¢6öç7B'F–Ç2Ò6‡Væµ¶¥Òç'F–ÄW†—G3°Ğ¢–b‡'F–Ç2æÆVæwF‚â’°Ğ¢VæF–æu'F–ÄW†—G2çW6‚‡²&6·FW7EG&FT–C¢–ç6W'FVE¶¥Òæ–BÂ'F–Ç2Ò“°Ğ¢ĞĞ¢ĞĞ¢ĞĞ¢ĞĞ Ğ¢–b‡VæF–æu'F–ÄW†—G2æÆVæwF‚â’°Ğ¢6öç7BfÆE&÷w2ÒVæF–æu'F–ÄW†—G2æfÆDÖ‚‡²&6·FW7EG&FT–BÂ'F–Ç2Ò’ÓàĞ¢'F–Ç2æÖ‚‡’Óâ‡°Ğ¢&6·FW7EG&FT–BÂ&V6öã¢ç&V6öâÂVçF—G“¢çG’çFôf—†VBƒ‚’ÀĞ¢&–6S¢ç&–6RçFôf—†VBƒ‚’ÂfVW3¢æfVW2çFôf—†VBƒ‚’ÂæÃ¢çæÂçFôf—†VBƒ‚’ÂF–ÖS¢çF–ÖRÀĞ¢Ò’’ÀĞ¢“°Ğ¢f÷"†ÆWB’Ò²’ÂfÆE&÷w2æÆVæwFƒ²’³Ò#’°Ğ¢v—BF"æ–ç6W'B†&6·FW7EG&FU'F–ÄW†—G5F&ÆR’çfÇVW2†fÆE&÷w2ç6Æ–6R†’Â’²#’“°Ğ¢ĞĞ¢ĞĞ Ğ¢6öç7BWV—G”7W'fTFFÒF÷vç6×ÆR†WV—G•F–ÖU6W&–W2Â#“°Ğ¢–b†WV—G”7W'fTFFæÆVæwF‚â’°Ğ¢f÷"†ÆWB’Ò²’ÂWV—G”7W'fTFFæÆVæwFƒ²’³ÒS’°Ğ¢6öç7B&F6‚ÒWV—G”7W'fTFFç6Æ–6R†’Â’²S’æÖ‚‡’Óâ‡°Ğ¢'Vä–BÂF–ÖW7F×¢çG2ÀĞ¢&Ææ6S¢æ&Ææ6RçFôf—†VBƒ"’ÂG&vF÷vã¢æG&vF÷vâçFôf—†VBƒB’ÀĞ¢Ò’“°Ğ¢v—BF"æ–ç6W'B†WV—G”7W'fUF&ÆR’çfÇVW2†&F6‚“°Ğ¢ĞĞ¢ĞĞ Ğ¢6öç7BÖWG&–72Ò6ö×WFTÖWG&–72€Ğ¢ÆÅG&FW2Â7F'F–æt&Ææ6RÂ&Ææ6RÀĞ¢WV—G•F–ÖU6W&–W2æÖ‚‡’Óâæ&Ææ6RĞ¢“°Ğ Ğ¢v—BF Ğ¢çWFFR†&6·FW7E'Vç5F&ÆRĞ¢ç6WB‡°Ğ¢7FGW3¢&6ö×ÆWFVB"Â&öw&W73¢ÀĞ¢VæF–æt&Ææ6S¢&Ææ6RçFôf—†VBƒ"’ÀĞ¢F÷FÅ&WGW&ã¢ÖWG&–72çF÷FÅ&WGW&âçFôf—†VBƒB’ÀĞ¢F÷FÅæÃ¢ÖWG&–72çF÷FÅæÂçFôf—†VBƒ"’ÀĞ¢F÷FÅG&FW3¢ÖWG&–72çF÷FÅG&FW2ÀĞ¢v–ææ–æuG&FW3¢ÖWG&–72çv–ææ–æuG&FW2ÀĞ¢Æ÷6–æuG&FW3¢ÖWG&–72æÆ÷6–æuG&FW2ÀĞ¢v–å&FS¢ÖWG&–72çv–å&FRçFôf—†VBƒB’ÀĞ¢&öf—Df7F÷#¢ÖWG&–72ç&öf—Df7F÷"çFôf—†VBƒB’ÀĞ¢6†'U&F–ó¢ÖWG&–72ç6†'U&F–òçFôf—†VBƒB’ÀĞ¢6÷'F–æõ&F–ó¢ÖWG&–72ç6÷'F–æõ&F–òçFôf—†VBƒB’ÀĞ¢Ö„G&vF÷vã¢ÖWG&–72æÖ„G&vF÷vâçFôf—†VBƒB’ÀĞ¢fW&vUv–ã¢ÖWG&–72æfW&vUv–âçFôf—†VBƒ‚’ÀĞ¢fW&vTÆ÷73¢ÖWG&–72æfW&vTÆ÷72çFôf—†VBƒ‚’ÀĞ¢W‡V7Fæ7“¢ÖWG&–72æW‡V7Fæ7’çFôf—†VBƒ‚’ÀĞ¢Æ&vW7Ev–ã¢ÖWG&–72æÆ&vW7Ev–âçFôf—†VBƒ‚’ÀĞ¢Æ&vW7DÆ÷73¢ÖWG&–72æÆ&vW7DÆ÷72çFôf—†VBƒ‚’ÀĞ¢F–Ç•&WGW&ç3¢ÖWG&–72æF–Ç•&WGW&ç2ÀĞ¢ÖöçF†Ç•&WGW&ç3¢ÖWG&–72æÖöçF†Ç•&WGW&ç2ÀĞ¢7G&FVw”6ö×&—6öã¢ÖWG&–72ç7G&FVw”6ö×&—6öâÀĞ¢òòFV6—6–öâFVÆVÖWG'“¢7G&FVw’9r7FvR9r&V6öâ&V¦V7F–öâ6÷VçG2ÀĞ¢òòÖ÷7Bg&WVVçBf—'7B(	B'v‡’F†R'VâD”DâuBG&FRÖ÷&R"àĞ¢FV6—6–öå7FG3¢°Ğ¢&V¦V7F–öç3¢²ââæFV6—6–öävrçfÇVW2‚•Òç6÷'B‚†Â"’Óâ"æ6÷VçBÒæ6÷VçB’ÀĞ¢ÒÀĞ¢G†—E&FS¢ÖWG&–72çG†—E&FRçFôf—†VBƒB’ÀĞ¢G$†—E&FS¢ÖWG&–72çG$†—E&FRçFôf—†VBƒB’ÀĞ¢'&V´WfVå&FS¢ÖWG&–72æ'&V´WfVå&FRçFôf—†VBƒB’ÀĞ¢G&–Æ–æu7F÷&FS¢ÖWG&–72çG&–Æ–æu7F÷&FRçFôf—†VBƒB’ÀĞ¢ÒĞ¢çv†W&R†W†&6·FW7E'Vç5F&ÆRæ–BÂ'Vä–B’“°Ğ Ğ¢òò&6·FW7BÖf—'7BÆ—fRvFS¢4ôÕÄUDTB6–ævÆR×7G&FVw’'Vâöb5U5DôĞĞ¢òò7G&FVw’—2v†BV&ç2—BÆ—fRVÆ–v–&–Æ—G’â7F×Æ7D&6·FW7DBöàĞ¢òòF†R&÷r‡66÷VBFòF†—2'Vâw2W6W"²6V7F–öâ’æBG&÷F†RÆöFW Ğ¢òò66†R6òF†RÆ—fRVæv–æR6VW2F†R&öÖ÷F–öâv—F†–âöæR6öæf–r&Vg&W6‚àĞ¢–b‡&×2æöæÇ•7G&FVw”–Còç7F'G5v—F‚‚&7W7FöÕò"’’°Ğ¢6öç7B6V7F–öâÒ—4f÷&W‚ò&f÷&W‚"26öç7B¢&7'—Fò"26öç7C°Ğ¢G'’°Ğ¢v—BF Ğ¢çWFFR†7W7FöÕ7G&FVv–W5F&ÆRĞ¢ç6WB‡²Æ7D&6·FW7DC¢æWrFFR‚’ÒĞ¢çv†W&R†æB€Ğ¢W†7W7FöÕ7G&FVv–W5F&ÆRçW6W$–BÂW6W$–B’ÀĞ¢W†7W7FöÕ7G&FVv–W5F&ÆRç6V7F–öâÂ6V7F–öâ’ÀĞ¢W†7W7FöÕ7G&FVv–W5F&ÆRç7G&FVw”–BÂ&×2æöæÇ•7G&FVw”–B’ÀĞ¢’“°Ğ¢–çfÆ–FFT7W7FöÕ7G&FVv–W2‡W6W$–BÂ6V7F–öâ“°Ğ¢ÆövvW"æ–æfò‡²'Vä–BÂ7G&FVw”–C¢&×2æöæÇ•7G&FVw”–BÂ6V7F–öâÒÂ$7W7FöÒ7G&FVw’&6·FW7B6ö×ÆWFVB(	BÆ7D&6·FW7DB7F×VB†Æ—fRÖVÆ–v–&ÆRöæ6RVæ&ÆVB’"“°Ğ¢Ò6F6‚†W'"’°Ğ¢ÆövvW"çv&â‡²W'"Â'Vä–BÂ7G&FVw”–C¢&×2æöæÇ•7G&FVw”–BÒÂ$f–ÆVBFò7F×7W7FöÒ7G&FVw’Æ7D&6·FW7DB†æöâÖfFÂ’"“°Ğ¢ĞĞ¢ĞĞ Ğ¢ÆövvW"æ–æfò€Ğ¢²'Vä–BÂââæÖWG&–72ÂVffV7F—fT6öæf–tÆ–VC¢VffV7F—fT6öæf–rç'VäÆWfVÄ÷fW'&–FW2ÒÀĞ¢$&6·FW7B6ö×ÆWFR†6†V6·ö–çB2ó2(	B6ö×&RVffV7F—fT6öæf–tÆ–VB&÷fRv–ç7B$4µDU5Eõ$Õ5õ$T4T•dTBBF†R7F'BöbF†—2'Vâw2Æöw2Fò6öæf—&ÒF†R7V&Ö—GFVBfÇVW2vW&R7GVÆÇ’W6VB’"ÀĞ¢“°Ğ¢Ò6F6‚†W'#¢ç’’°Ğ¢6öç7B—46æ6VÆÆVBÒW'#òæÖW76vRÓÓÒ&6æ6VÆÆVB#°Ğ¢6æ6VÆÆVE'Vç2æFVÆWFR‡'Vä–B“°Ğ¢v—BF Ğ¢çWFFR†&6·FW7E'Vç5F&ÆRĞ¢ç6WB‡°Ğ¢7FGW3¢—46æ6VÆÆVBò&6æ6VÆÆVB"¢&f–ÆVB"ÀĞ¢W'&÷#¢—46æ6VÆÆVBòçVÆÂ¢7G&–ær†W'#òæÖW76vRóòW'"’ÀĞ¢ÒĞ¢çv†W&R†W†&6·FW7E'Vç5F&ÆRæ–BÂ'Vä–B’“°Ğ¢–b‚—46æ6VÆÆVB’°Ğ¢ÆövvW"æW'&÷"‡²W'"Â'Vä–BÒÂ$&6·FW7Bf–ÆVB"“°Ğ¢F‡&÷rW'#°Ğ¢ĞĞ¢ĞĞ§ĞĞ Ğ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞĞ¢òò†VÇW'0Ğ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞĞ Ğ¦gVæ7F–öâF÷vç6×ÆSÅCâ†'#¢EµÒÂÖ„ÆVã¢çVÖ&W"“¢EµÒ°Ğ¢–b†'"æÆVæwF‚ÃÒÖ„ÆVâ’&WGW&â'#°Ğ¢6öç7B7FWÒÖF‚æ6V–Â†'"æÆVæwF‚òÖ„ÆVâ“°Ğ¢6öç7B&W7VÇC¢EµÒÒµÓ°Ğ¢f÷"†ÆWB’Ò²’Â'"æÆVæwFƒ²’³Ò7FW’&W7VÇBçW6‚†'%¶•Ò“°Ğ¢–b‡&W7VÇE·&W7VÇBæÆVæwF‚ÒÒÓÒ'%¶'"æÆVæwF‚ÒÒ’°Ğ¢&W7VÇBçW6‚†'%¶'"æÆVæwF‚ÒÒ“°Ğ¢ĞĞ¢&WGW&â&W7VÇC°Ğ§ĞĞ 