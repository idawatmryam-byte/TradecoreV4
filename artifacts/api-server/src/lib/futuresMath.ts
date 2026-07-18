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
 * The liquidation price must be at least this many times FARTHER from entry
 * than the stop is, so ordinary slippage/wick noise around a triggering stop
 * cannot reach liquidation first (e.g. stop 1.5% away ⇒ liquidation must be
 * ≥ 1.875% away).
 *
 * FIX (was 1.05 applied to the liquidation PRICE): the old check demanded the
 * stop sit 5% OF PRICE clear of liquidation. At 25x leverage the entire
 * liquidation distance is only ~3.6% of price, so the threshold landed ABOVE
 * the entry and every conceivable stop failed — for leverage ≳ 20x the guard
 * rejected 100% of entries (live and backtest both went silently tradeless).
 * A buffer must scale with the stop DISTANCE, not with price.
 */
export const LIQUIDATION_BUFFER = 1.25;

/**
 * Minimum futures stop-loss distance from entry (% of price) for a protective
 * STOP_MARKET to place reliably. Binance rejects a trigger too close to the
 * mark price ("would immediately trigger" / PERCENT_PRICE filter); below this
 * the position ends up unprotected → immediate flatten or liquidation. This is
 * the concrete floor that makes a fixed-dollar stop unplaceable at very high
 * leverage (a $50 stop on $15k notional is only ~0.23% away, well under this).
 * Lives here (not botEngine) so the leverage solver and the live entry guard
 * share one number.
 */
export const MIN_PROTECTIVE_STOP_PCT = 0.35;

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
 * first. Compares DISTANCES from entry (direction-agnostic): the liquidation
 * distance must exceed the stop distance by LIQUIDATION_BUFFER. Used by the
 * live entry guard, the live per-tick position monitor, and the backtest, so
 * all three agree. A genuinely reckless combination (e.g. 50x with a 1.5%
 * stop, where liquidation at ~1.6% sits inside the buffered stop) still
 * trips this — which is the point.
 */
export function stopTooCloseToLiquidation(
  entryPrice: number,
  stopPrice: number,
  liquidationPrice: number,
  bufferRatio: number = LIQUIDATION_BUFFER,
): boolean {
  const stopDist = Math.abs(entryPrice - stopPrice);
  const liqDist = Math.abs(entryPrice - liquidationPrice);
  if (!Number.isFinite(liqDist)) return false; // leverage ≤ 1 → liquidation unreachable
  if (!(liqDist > 0)) return true;             // degenerate/unknown → treat as unsafe
  return liqDist < stopDist * bufferRatio;
}
