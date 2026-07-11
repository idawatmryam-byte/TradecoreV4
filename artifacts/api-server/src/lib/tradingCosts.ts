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
