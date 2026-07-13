/**
 * TradeCore Pro — Shared Trading Cost Assumptions  (Phase 7)
 *
 * Single source of truth for fee/slippage assumptions that were previously
 * hardcoded independently in multiple places (backtestEngine.ts's function
 * defaults, and nowhere at all on the validation side — which is exactly
 * how the Phase 6 audit's bt6 finding happened: a takeProfitPercent of
 * 0.25% was accepted with no warning, even though round-trip fees alone
 * (2 × feeRate) already exceed it, guaranteeing a net loss on every single
 * winning trade).
 */

/** Binance spot taker fee, as a fraction (0.001 = 0.1%). */
export const DEFAULT_FEE_RATE = 0.001;

/** Binance USDⓈ-M futures taker fee (0.0005 = 0.05%) — half of spot. A
 *  futures backtest that assumes the spot rate overstates round-trip costs
 *  2×, which materially distorts profit factor at high trade counts. */
export const FUTURES_FEE_RATE = 0.0005;

/** Assumed slippage per fill, as a fraction (0.0005 = 0.05%). Applied on
 *  both entry and exit in the backtest simulation. */
export const DEFAULT_SLIPPAGE_RATE = 0.0005;

/**
 * The minimum takeProfitPercent that can theoretically break even against
 * round-trip trading costs (2 fee legs + 2 slippage legs), before the
 * strategy needs to be right about direction at all. Configuring a TP below
 * this is not "aggressive" — it's a guaranteed net loss on every winning
 * trade, confirmed empirically in the Phase 6 audit (bt6: 30/30 take-profit
 * exits were net losers, all with identical P&L, because the realized TP
 * move was smaller than the round-trip fee cost).
 *
 * This is a floor, not a target — a strategy still needs edge (a real win
 * rate advantage) on top of clearing this floor to be profitable overall.
 */
export function minViableTakeProfitPercent(
  feeRate: number = DEFAULT_FEE_RATE,
  slippageRate: number = DEFAULT_SLIPPAGE_RATE,
): number {
  return (2 * feeRate + 2 * slippageRate) * 100;
}

/** Precomputed at default rates — 0.3% — used where a static bound is
 *  simpler than threading feeRate/slippageRate through (e.g. a zod schema). */
export const MIN_VIABLE_TAKE_PROFIT_PERCENT = minViableTakeProfitPercent();

/**
 * Net reward-to-risk ratio of a trade AFTER round-trip costs — the number a
 * professional actually decides on, not the raw TP:SL distance. Costs widen
 * the effective risk (you pay them on the losing exit too) and shrink the
 * effective reward, so a trade that looks like 1.5:1 on paper is always a
 * bit worse once fees + slippage are charged on both legs.
 *
 *   long:  grossReward = tp - entry,  grossRisk = entry - sl
 *   short: grossReward = entry - tp,  grossRisk = sl - entry
 *   cost  = entry × (2·fee + 2·slippage)   (both legs, entry-notional basis)
 *   netRR = (grossReward - cost) / (grossRisk + cost)
 *
 * Returns 0 for a structurally invalid trade (SL/TP on the wrong side) and
 * can return ≤ 0 when the reward doesn't even clear costs (a guaranteed net
 * loser regardless of win rate — the same failure the TP floor above guards
 * against, expressed as a ratio).
 */
export function netRewardRisk(
  entryPrice: number,
  slPrice: number,
  tpPrice: number,
  side: "long" | "short",
  feeRate: number = DEFAULT_FEE_RATE,
  slippageRate: number = DEFAULT_SLIPPAGE_RATE,
): number {
  if (!(entryPrice > 0)) return 0;
  const grossReward = side === "short" ? entryPrice - tpPrice : tpPrice - entryPrice;
  const grossRisk = side === "short" ? slPrice - entryPrice : entryPrice - slPrice;
  if (!(grossReward > 0) || !(grossRisk > 0)) return 0;
  const roundTripCost = entryPrice * (2 * feeRate + 2 * slippageRate);
  const netRisk = grossRisk + roundTripCost;
  if (netRisk <= 0) return 0;
  return (grossReward - roundTripCost) / netRisk;
}

/**
 * Structural safety FLOOR on net reward:risk — a misconfiguration guardrail,
 * NOT a strategy-quality target (parallel to MIN_VIABLE_TAKE_PROFIT_PERCENT).
 * Every shipped default strategy clears this comfortably (the lowest,
 * micro-scalping, sits at ~0.82 net). A trade below 0.5 means risking more
 * than 2× the reward after costs — to be break-even there you'd need a
 * >67% win rate, which is almost always a fat-fingered SL/TP config rather
 * than a considered strategy. Blocking it only ever removes structurally
 * poor trades; it never forces a new one. A user with a validated
 * high-win-rate/low-R:R strategy is the reason this is a floor, not a target.
 */
export const MIN_VIABLE_REWARD_RISK = 0.5;
