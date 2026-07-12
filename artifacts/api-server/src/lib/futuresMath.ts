/**
 * TradeCore Pro — Futures math helpers (leverage / liquidation)
 *
 * Pure, exchange-free functions shared by the backtest (which has no live
 * exchange to query) and the live engine's entry-time liquidation guard, so
 * both reason about liquidation the same way.
 *
 * IMPORTANT sizing note: the live engine sizes a futures position by NOTIONAL
 * (computeQty caps at positionSizeUsdt) and posts margin = notional/leverage.
 * Leverage therefore does NOT amplify a position's dollar P&L — it only (a)
 * reduces the margin required and (b) moves the liquidation price closer to
 * entry. The backtest models leverage the same way, so backtest/live stay in
 * parity: leverage's real effect is liquidation risk, not bigger positions.
 */

/**
 * Maintenance-margin rate. Binance uses tiered rates that rise with position
 * notional; this is the lowest tier (~0.4%) for major pairs — a reasonable,
 * documented approximation for modeling, not an exact per-symbol value.
 */
export const MAINTENANCE_MARGIN_RATE = 0.004;

/**
 * Require the stop-loss to sit at least this factor clear of the liquidation
 * price (5%). Matches the buffer the live engine enforces at entry.
 */
export const LIQUIDATION_BUFFER = 1.05;

/**
 * Estimate the isolated-margin liquidation price for a USDⓈ-M futures
 * position. Derivation (ignoring funding, exact fees): a position is
 * liquidated when its loss consumes the initial margin down to the
 * maintenance margin, i.e. the price moves (1/leverage − mmr) against entry.
 *   long:  entry × (1 − (1/leverage − mmr))
 *   short: entry × (1 + (1/leverage − mmr))
 * At leverage ≤ 1 there is effectively no liquidation, so returns an
 * unreachable price (0 for long, +∞ for short).
 */
export function estimateLiquidationPrice(
  entryPrice: number,
  side: "long" | "short",
  leverage: number,
  mmr: number = MAINTENANCE_MARGIN_RATE,
): number {
  if (!(leverage > 1) || !(entryPrice > 0)) return side === "short" ? Infinity : 0;
  const move = 1 / leverage - mmr; // fractional adverse move to liquidation
  return side === "short" ? entryPrice * (1 + move) : entryPrice * (1 - move);
}

/**
 * True when the stop is too close to (or beyond) the liquidation price for
 * safety — i.e. a normal move around the stop could cross into liquidation
 * first. For a long the stop must sit comfortably ABOVE liquidation; for a
 * short, comfortably BELOW. Same logic the live engine uses to reject an
 * unsafe entry (botEngine enterTrade), extracted here so backtest and live
 * agree. High leverage + a tight stop trips this — which is the point.
 */
export function stopTooCloseToLiquidation(
  stopPrice: number,
  liquidationPrice: number,
  side: "long" | "short",
  buffer: number = LIQUIDATION_BUFFER,
): boolean {
  return side === "short"
    ? stopPrice > liquidationPrice / buffer
    : stopPrice < liquidationPrice * buffer;
}
