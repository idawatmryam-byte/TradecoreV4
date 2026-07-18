/**
 * TradeCore Pro — Trader Toolkit
 *
 * Pure, shared helpers a deciding strategy ("the brain") composes into its
 * own decision process — the way eight traders share one terminal but think
 * differently. Everything here is a pure function over candles/config, with
 * zero I/O, so live and backtest decisions are bit-identical by construction.
 *
 * The centerpiece is solveLeverage(): leverage becomes an OUTPUT of risk
 * management instead of an input. It works backward from the widest of the
 * safety floors (volatility noise band, exchange stop-placeability,
 * structural invalidation level) to the highest leverage whose implied stop
 * still sits safely — reusing the audited dollar-risk math in dollarRisk.ts
 * rather than re-deriving fee arithmetic.
 */
import type { Candle, MultiTimeframeCandles, SignalRow } from "../strategy";
import { calcEma, calcVwap, calcAtr } from "../strategy";
import {
  planDollarRiskFractions,
  type DollarRiskConfig,
} from "../dollarRisk";
import { MIN_PROTECTIVE_STOP_PCT } from "../futuresMath";
import {
  netRewardRisk,
  MIN_VIABLE_REWARD_RISK,
  DEFAULT_FEE_RATE,
  FUTURES_FEE_RATE,
} from "../tradingCosts";
import { TARGET_REACH_K } from "./base";
import type { PositionSide } from "./base";
import { MIN_STOP_ATR_MULT } from "./selector";

// ─────────────────────────────────────────────────────────────────────────────
// Market facts — the observable structure a trader reads before deciding
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketFacts {
  /** Nearest swing resistance above the last price (15m pivots), null if none in window. */
  resistance: number | null;
  /** Nearest swing support below the last price (15m pivots), null if none in window. */
  support: number | null;
  /** Distance from last price to resistance, % of price (null when no level). */
  resistanceDistancePct: number | null;
  supportDistancePct: number | null;
  /** Current 1m ATR% percentile within the recent window, 0–100. */
  volatilityPercentile: number;
  /** 5m EMA20 slope over the last 5 candles, % of price. >0 = rising. */
  momentumSlopePct: number;
  /** Last price distance from session VWAP, % (positive = above VWAP). */
  vwapDistancePct: number;
  /** Volume confirmation: last 1m volume ≥ 1.2× its 20-period average. */
  volumeConfirmed: boolean;
}

/** Swing-pivot levels: a candle whose high (low) exceeds its `wing` neighbors on both sides. */
function swingLevels(candles: Candle[], wing = 2): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = wing; i < candles.length - wing; i++) {
    const h = candles[i][2];
    const l = candles[i][3];
    let isHigh = true;
    let isLow = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (candles[j][2] >= h) isHigh = false;
      if (candles[j][3] <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push(h);
    if (isLow) lows.push(l);
  }
  return { highs, lows };
}

/**
 * Read the market's structure once. Pure over the candle arrays already in
 * MultiTimeframeCandles — no extra data fetches.
 */
export function marketFacts(mtf: MultiTimeframeCandles, row: SignalRow): MarketFacts {
  const price = row.lastPrice;

  // S/R from 15m swing pivots over the recent window.
  const recent15 = mtf.tf15m.slice(-96); // ~24h of 15m candles
  const { highs, lows } = swingLevels(recent15);
  const resistance = highs.filter((h) => h > price).sort((a, b) => a - b)[0] ?? null;
  const support = lows.filter((l) => l < price).sort((a, b) => b - a)[0] ?? null;

  // Volatility percentile: current ATR% vs its own recent distribution,
  // approximated from 1m candle ranges (pure, cheap, deterministic).
  const ranges = mtf.tf1m.slice(-240).map((c) => (price > 0 ? ((c[2] - c[3]) / price) * 100 : 0));
  const sorted = [...ranges].sort((a, b) => a - b);
  const currentRange = ranges.length ? ranges[ranges.length - 1] : 0;
  const below = sorted.filter((r) => r <= currentRange).length;
  const volatilityPercentile = sorted.length ? Math.round((below / sorted.length) * 100) : 50;

  // Momentum slope: EMA20(5m) now vs 5 candles ago, as % of price.
  const closes5 = mtf.tf5m.map((c) => c[4]);
  const emaNow = calcEma(closes5, 20);
  const emaPrev = calcEma(closes5.slice(0, -5), 20);
  const momentumSlopePct = price > 0 && emaPrev > 0 ? ((emaNow - emaPrev) / price) * 100 : 0;

  // VWAP distance on the 1m session window.
  const vwap = calcVwap(mtf.tf1m.slice(-240));
  const vwapDistancePct = price > 0 && vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;

  return {
    resistance,
    support,
    resistanceDistancePct: resistance != null && price > 0 ? ((resistance - price) / price) * 100 : null,
    supportDistancePct: support != null && price > 0 ? ((price - support) / price) * 100 : null,
    volatilityPercentile,
    momentumSlopePct,
    vwapDistancePct,
    volumeConfirmed: row.volumeRatio >= 1.2,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Leverage solver — leverage as an output of risk, not an input
// ─────────────────────────────────────────────────────────────────────────────

export interface SolveLeverageArgs {
  entryPrice: number;
  side: PositionSide;
  marketType: "spot" | "futures";
  /** Margin budget for the trade (futures) / notional (spot). */
  marginUsdt: number;
  maxLossUsdt: number;
  targetProfitUsdt: number;
  /** User's hard cap — the solver never exceeds it. */
  leverageCap: number;
  /** Taker fee fraction per leg. */
  feeRate?: number;
  /** Coin's per-candle ATR as % of price — the noise floor input. */
  atrPercent: number;
  /**
   * Structural invalidation level (e.g. the broken breakout level, a VWAP
   * band) — the price at which the trade thesis is wrong. When set, the stop
   * is pushed at least this far so the trade is invalidated by STRUCTURE,
   * not by an arbitrary dollar distance.
   */
  invalidationPrice?: number;
}

export interface LeverageSolution {
  feasible: boolean;
  /** Chosen leverage (1 = unlevered). Only meaningful when feasible. */
  leverage: number;
  notionalUsdt: number;
  qty: number;
  slPrice: number;
  tpPrice: number;
  slFraction: number;
  tpFraction: number;
  /** Stop distance as % of entry — always ≥ every safety floor when feasible. */
  stopDistPct: number;
  /** The binding floor that set the minimum stop width. */
  bindingFloor: "noise-band" | "exchange-min" | "invalidation" | "none";
  /** Why no leverage works (set when !feasible). */
  reason?: string;
}

/**
 * Find the HIGHEST leverage ≤ cap whose implied fixed-dollar stop still sits
 * outside every safety floor and safely inside liquidation.
 *
 * Mechanics: with margin M and leverage L, notional = M×L and the stop
 * fraction is (maxLoss − fees)/(M×L) — higher leverage ⇒ tighter stop. So the
 * solver walks L downward from the cap until the stop clears
 * max(noise band, exchange minimum, structural invalidation), delegating the
 * fee/liquidation arithmetic to planDollarRiskFractions() (single source of
 * truth). If even L=1 cannot clear the floors, the trade is rejected — by
 * construction no approved plan can carry an unplaceable or noise-band stop.
 */
export function solveLeverage(args: SolveLeverageArgs): LeverageSolution {
  const isFutures = args.marketType === "futures";
  const feeRate = args.feeRate ?? (isFutures ? FUTURES_FEE_RATE : DEFAULT_FEE_RATE);
  const entry = args.entryPrice;

  // Safety floors, all as fraction-of-entry stop widths.
  const noiseFloor = Math.max(0, args.atrPercent) * MIN_STOP_ATR_MULT / 100;
  const exchangeFloor = isFutures ? MIN_PROTECTIVE_STOP_PCT / 100 : 0;
  const invalidationFloor =
    args.invalidationPrice != null && entry > 0
      ? Math.abs(entry - args.invalidationPrice) / entry
      : 0;
  const minStopFraction = Math.max(noiseFloor, exchangeFloor, invalidationFloor);
  const bindingFloor: LeverageSolution["bindingFloor"] =
    minStopFraction === 0 ? "none"
    : minStopFraction === invalidationFloor && invalidationFloor > 0 ? "invalidation"
    : minStopFraction === noiseFloor && noiseFloor >= exchangeFloor ? "noise-band"
    : "exchange-min";

  const fail = (reason: string): LeverageSolution => ({
    feasible: false, leverage: 1, notionalUsdt: 0, qty: 0, slPrice: 0, tpPrice: 0,
    slFraction: 0, tpFraction: 0, stopDistPct: 0, bindingFloor, reason,
  });

  if (!(entry > 0)) return fail("no valid entry price");
  if (!(args.marginUsdt > 0)) return fail("no margin budget configured");
  if (!(args.maxLossUsdt > 0) || !(args.targetProfitUsdt > 0)) {
    return fail("no dollar risk plan configured (max loss + target profit required)");
  }

  const capL = isFutures ? Math.max(1, Math.floor(args.leverageCap)) : 1;

  for (let L = capL; L >= 1; L--) {
    const cfg: DollarRiskConfig = {
      marketType: args.marketType,
      tradeAmountUsdt: args.marginUsdt,
      leverage: L,
      maxLossUsdt: args.maxLossUsdt,
      targetProfitUsdt: args.targetProfitUsdt,
      feeRate,
    };
    const f = planDollarRiskFractions(cfg, undefined, false);
    if (!f.feasible || !f.safe) continue;      // fees ≥ max loss at this notional, or stop beyond liq
    if (f.slFraction < minStopFraction) continue; // stop too tight for the floors at this leverage

    const qty = f.notionalUsdt / entry;
    const isShort = args.side === "short";
    return {
      feasible: true,
      leverage: L,
      notionalUsdt: f.notionalUsdt,
      qty,
      slPrice: isShort ? entry * (1 + f.slFraction) : entry * (1 - f.slFraction),
      tpPrice: isShort ? entry * (1 - f.tpFraction) : entry * (1 + f.tpFraction),
      slFraction: f.slFraction,
      tpFraction: f.tpFraction,
      stopDistPct: f.slFraction * 100,
      bindingFloor,
    };
  }

  return fail(
    `no leverage 1–${capL}× places a $${args.maxLossUsdt} stop outside the safety floors ` +
    `(min stop ${(minStopFraction * 100).toFixed(2)}% from ${bindingFloor}) with $${args.marginUsdt} margin — ` +
    `widen max loss, raise margin, or skip`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Time feasibility — can the target realistically be reached in the window?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The platform's intraday contract: trades should generally complete within
 * ~20 minutes to 2 hours. Pro-brain strategies judge target reachability
 * against the FULL 2-hour window (a thesis needing 40 minutes is a fine
 * intraday trade) and then set an ADAPTIVE per-trade deadline — roughly twice
 * the expected resolution time, clamped to this band — instead of hard-
 * killing everything at one fixed number. "20 Minutes Trading" names the
 * style, not the deadline.
 */
export const INTRADAY_MIN_HOLD_SECONDS = 20 * 60;   // 20 minutes
export const INTRADAY_MAX_HOLD_SECONDS = 2 * 3600;  // 2 hours

/** Adaptive deadline: 2× the expected resolution, clamped to the intraday band
 *  (and never beyond the window the feasibility verdict was judged against). */
export function adaptiveDeadline(expectedSeconds: number, windowSeconds: number): number {
  return Math.min(
    windowSeconds,
    Math.max(INTRADAY_MIN_HOLD_SECONDS, Math.round(expectedSeconds * 2)),
  );
}

export interface TimeFeasibility {
  feasible: boolean;
  /** % move statistically reachable within the window at current volatility. */
  reachablePct: number;
  targetPct: number;
  /** Seconds the target realistically needs at current volatility (√t scaling). */
  expectedSeconds: number;
  reason?: string;
}

/** Reachable % and expected time for one timeframe's volatility. */
function reachabilityFor(atrPct: number, candleSecs: number, targetPct: number, maxHoldSeconds: number) {
  const neededCandles = Math.pow(targetPct / (atrPct * TARGET_REACH_K), 2);
  const expectedSeconds = Math.ceil(neededCandles * candleSecs);
  const holdCandles = maxHoldSeconds > 0 ? maxHoldSeconds / candleSecs : Infinity;
  const reachablePct = Number.isFinite(holdCandles)
    ? atrPct * Math.sqrt(holdCandles) * TARGET_REACH_K
    : Infinity;
  return { reachablePct, expectedSeconds };
}

/**
 * Random-walk reachability: over N candles a coin drifts ~ATR×√N. Inverts the
 * same formula the per-coin fit check uses (TARGET_REACH_K), and additionally
 * answers "how long would this target take?" so a strategy can set an honest
 * expectedHoldSeconds instead of guessing.
 *
 * NOT myopic: when `mtf` is provided, the 5-minute frame's ATR is consulted
 * alongside the primary (1m) frame and the MORE OPTIMISTIC verdict wins — a
 * trending coin shows more usable range per unit time on the coarser frame
 * (moves compound directionally instead of netting out candle-to-candle), so
 * judging reachability on 1m noise alone under-calls real trends.
 */
export function timeFeasible(
  tpFraction: number,
  row: SignalRow,
  maxHoldSeconds: number,
  mtf?: MultiTimeframeCandles,
): TimeFeasibility {
  const targetPct = tpFraction * 100;
  const atrPct = row.atrPercent;
  if (!(atrPct > 0) || !(targetPct > 0)) {
    return { feasible: true, reachablePct: Infinity, targetPct, expectedSeconds: 0 };
  }

  const primary = reachabilityFor(atrPct, Math.max(1, row.candleMinutes) * 60, targetPct, maxHoldSeconds);
  let best = primary;

  // Second opinion from the 5m frame, when candles are available.
  if (mtf && mtf.tf5m.length >= 20 && row.lastPrice > 0) {
    const atr5Abs = calcAtr(mtf.tf5m, 14);
    const atr5Pct = (atr5Abs / row.lastPrice) * 100;
    if (atr5Pct > 0) {
      const alt = reachabilityFor(atr5Pct, 300, targetPct, maxHoldSeconds);
      if (alt.reachablePct > best.reachablePct) best = alt;
    }
  }

  if (targetPct > best.reachablePct) {
    return {
      feasible: false,
      reachablePct: best.reachablePct,
      targetPct,
      expectedSeconds: best.expectedSeconds,
      reason:
        `target ${targetPct.toFixed(2)}% needs ~${Math.round(best.expectedSeconds / 60)}min at this volatility (1m + 5m checked) — ` +
        `only ~${best.reachablePct.toFixed(2)}% reachable within the ${Math.round(maxHoldSeconds / 60)}min window`,
    };
  }
  return { feasible: true, reachablePct: best.reachablePct, targetPct, expectedSeconds: best.expectedSeconds };
}

/**
 * "Would MORE leverage make this target reachable?" — the professional
 * follow-up to a time-feasibility rejection. Raising leverage grows the
 * notional, which SHRINKS the % move a fixed dollar target needs — but it
 * also tightens the stop toward the safety floors. This searches upward for
 * the smallest leverage where BOTH hold: target ≤ reachable AND the stop
 * still clears every floor. Returns null when no leverage works. The caller
 * compares the answer against the user's cap — the solver itself never
 * exceeds the cap; this exists so a rejection can say "feasible at ~N×,
 * raise your cap or lower the target" instead of a dead end.
 */
export function suggestLeverageForTarget(
  args: Omit<SolveLeverageArgs, "leverageCap">,
  reachablePct: number,
  hardMax = 125,
): number | null {
  if (args.marketType !== "futures" || !(reachablePct > 0)) return null;
  const feeRate = args.feeRate ?? FUTURES_FEE_RATE;
  const noiseFloor = Math.max(0, args.atrPercent) * MIN_STOP_ATR_MULT / 100;
  const exchangeFloor = MIN_PROTECTIVE_STOP_PCT / 100;
  const invalidationFloor =
    args.invalidationPrice != null && args.entryPrice > 0
      ? Math.abs(args.entryPrice - args.invalidationPrice) / args.entryPrice
      : 0;
  const minStopFraction = Math.max(noiseFloor, exchangeFloor, invalidationFloor);

  for (let L = 1; L <= hardMax; L++) {
    const f = planDollarRiskFractions({
      marketType: "futures", tradeAmountUsdt: args.marginUsdt, leverage: L,
      maxLossUsdt: args.maxLossUsdt, targetProfitUsdt: args.targetProfitUsdt, feeRate,
    }, undefined, false);
    if (!f.feasible || !f.safe) continue;
    if (f.slFraction < minStopFraction) break; // stop only tightens further — no higher L can work
    if (f.tpFraction * 100 <= reachablePct) return L;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fee viability — is the reward worth the risk after round-trip costs?
// ─────────────────────────────────────────────────────────────────────────────

export interface FeeViability {
  viable: boolean;
  /** Net reward:risk after fees + slippage on both legs. */
  netRR: number;
  floor: number;
  reason?: string;
}

/**
 * Pre-check of the same structural floor the dispatcher enforces centrally,
 * so a deciding strategy can reject with a REASONED report instead of being
 * silently floored downstream.
 */
export function feeViability(
  entryPrice: number,
  slPrice: number,
  tpPrice: number,
  side: PositionSide,
): FeeViability {
  const rr = netRewardRisk(entryPrice, slPrice, tpPrice, side);
  if (rr < MIN_VIABLE_REWARD_RISK) {
    return {
      viable: false,
      netRR: rr,
      floor: MIN_VIABLE_REWARD_RISK,
      reason: `net reward:risk ${rr.toFixed(2)} after costs is below the ${MIN_VIABLE_REWARD_RISK} floor`,
    };
  }
  return { viable: true, netRR: rr, floor: MIN_VIABLE_REWARD_RISK };
}
