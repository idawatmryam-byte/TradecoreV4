/**
 * TradeCore Pro — forex-specific sizing helpers (v1: USD-quoted instruments)
 *
 * Deliberately thin: for USD-quoted instruments (EUR_USD, GBP_USD, XAU_USD,
 * US-index CFDs) with a USD home-currency account, the existing dollar-risk
 * math in dollarRisk.ts is ALREADY exact — `qty = maxLoss / stopDistance`
 * and `pnl = qty × Δprice` are both denominated in account dollars. This
 * module only provides what dollarRisk doesn't know about:
 *
 *   - pip geometry (pipLocation → pip size in price units)
 *   - OANDA margin (marginRate × notional, NOT notional/leverage — forex
 *     "leverage" is implicit in the per-instrument margin rate)
 *   - a minimum stop distance guard (OANDA rejects/immediately-fills stops
 *     placed inside the spread; futuresMath's MIN_PROTECTIVE_STOP_PCT is a
 *     Binance % rule that does not transfer to 1.08-priced FX)
 *
 * futuresMath.ts (liquidation geometry) is NOT used for forex — OANDA closes
 * out at the account level via margin closeout, not per-position liquidation.
 */

/** Pip size in price units: pipLocation −4 → 0.0001 (EUR_USD), −2 → 0.01 (JPY pairs, some CFDs). */
export function pipSize(pipLocation: number): number {
  return 10 ** pipLocation;
}

/**
 * Margin required to hold `units` of a USD-quoted instrument at `price`.
 * OANDA: margin = notional × marginRate (e.g. 0.0333 → 30:1). This replaces
 * the futures notional/leverage arithmetic on the forex path.
 */
export function requiredMarginUsd(units: number, price: number, marginRate: number): number {
  return units * price * marginRate;
}

/**
 * Minimum distance (in price units) a protective stop must sit from the
 * current price to reliably rest and not be swallowed by the spread:
 * at least 2× the live spread, and never less than 2 pips. A stop closer
 * than this either gets rejected or fills instantly on quote noise.
 */
export function minStopDistancePrice(pipLocation: number, bid: number, ask: number): number {
  const spread = ask > bid && bid > 0 ? ask - bid : 0;
  return Math.max(2 * spread, 2 * pipSize(pipLocation));
}

/** Truncate a unit count to the instrument's tradeable precision (0 decimals
 *  for FX majors — whole units; never rounds UP past the risk-sized amount). */
export function roundUnits(units: number, tradeUnitsPrecision: number): number {
  const factor = 10 ** tradeUnitsPrecision;
  return Math.trunc(units * factor) / factor;
}
