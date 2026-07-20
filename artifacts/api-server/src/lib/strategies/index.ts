/**
 * Strategy registry — instantiates all strategies and exports the selector.
 */
export * from "./base";
export * from "./selector";
export { MomentumBreakoutStrategy } from "./momentum-breakout";
export { TrendPullbackStrategy } from "./trend-pullback";
export { MeanReversionStrategy } from "./mean-reversion";
export { VwapReversionStrategy } from "./vwap-reversion";
export { MicroScalpingStrategy } from "./micro-scalping";
export { VolatilityBreakoutStrategy } from "./volatility-breakout";
export { ScalpReversionStrategy } from "./scalp-reversion";
export { TwentyMinMomentumStrategy } from "./twenty-min-momentum";
export { LondonBreakoutStrategy } from "./london-breakout";

import { StrategySelector } from "./selector";
import { MomentumBreakoutStrategy } from "./momentum-breakout";
import { TrendPullbackStrategy } from "./trend-pullback";
import { MeanReversionStrategy } from "./mean-reversion";
import { VwapReversionStrategy } from "./vwap-reversion";
import { MicroScalpingStrategy } from "./micro-scalping";
import { VolatilityBreakoutStrategy } from "./volatility-breakout";
import { ScalpReversionStrategy } from "./scalp-reversion";
import { TwentyMinMomentumStrategy } from "./twenty-min-momentum";
import { LondonBreakoutStrategy } from "./london-breakout";

// Shared instances — one object per strategy, referenced by every catalog.
const trendPullback = new TrendPullbackStrategy();
const momentumBreakout = new MomentumBreakoutStrategy();
const volatilityBreakout = new VolatilityBreakoutStrategy();
const meanReversion = new MeanReversionStrategy();
const vwapReversion = new VwapReversionStrategy();
const microScalping = new MicroScalpingStrategy();
const scalpReversion = new ScalpReversionStrategy();
const twentyMinMomentum = new TwentyMinMomentumStrategy();
const londonBreakout = new LondonBreakoutStrategy();

/**
 * Canonical ordered list of every strategy the SELECTOR knows (priority order
 * for tie-breaking). Which of these actually trade in a given section is
 * governed by the per-section catalogs below — the selector skips any
 * strategy with no config row, and configs are seeded per catalog.
 */
export const ALL_STRATEGIES = [
  trendPullback,
  momentumBreakout,
  volatilityBreakout,
  meanReversion,
  vwapReversion,
  microScalping,
  scalpReversion,
  twentyMinMomentum,
  londonBreakout,
];

/** The crypto catalog — exactly the historical 8 (unchanged behavior). */
export const CRYPTO_STRATEGIES = [
  trendPullback,
  momentumBreakout,
  volatilityBreakout,
  meanReversion,
  vwapReversion,
  microScalping,
  scalpReversion,
  twentyMinMomentum,
];

/**
 * The forex catalog — crypto and forex are different markets, so they trade
 * different books. Kept: the structural strategies whose logic translates
 * (trend, breakout, reversion). Dropped: the crypto-microstructure scalpers
 * (micro_scalping, scalp_reversion, twenty_min_momentum) — sub-0.1% scalp
 * targets are built around crypto's fee/volatility profile and 24/7 flow.
 * Added: London Breakout, a session-structure play that only exists in FX.
 */
export const FOREX_STRATEGIES = [
  trendPullback,
  momentumBreakout,
  volatilityBreakout,
  meanReversion,
  vwapReversion,
  londonBreakout,
];

/** The tradeable catalog for a section. */
export function strategiesForSection(section: "crypto" | "forex"): typeof ALL_STRATEGIES {
  return section === "forex" ? FOREX_STRATEGIES : CRYPTO_STRATEGIES;
}

/** Singleton selector used by both botEngine and backtestEngine */
export const strategySelector = new StrategySelector(ALL_STRATEGIES);
