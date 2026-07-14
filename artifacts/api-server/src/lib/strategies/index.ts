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

import { StrategySelector } from "./selector";
import { MomentumBreakoutStrategy } from "./momentum-breakout";
import { TrendPullbackStrategy } from "./trend-pullback";
import { MeanReversionStrategy } from "./mean-reversion";
import { VwapReversionStrategy } from "./vwap-reversion";
import { MicroScalpingStrategy } from "./micro-scalping";
import { VolatilityBreakoutStrategy } from "./volatility-breakout";
import { ScalpReversionStrategy } from "./scalp-reversion";

/** Canonical ordered list of all strategies (by priority for tie-breaking) */
export const ALL_STRATEGIES = [
  new TrendPullbackStrategy(),
  new MomentumBreakoutStrategy(),
  new VolatilityBreakoutStrategy(),
  new MeanReversionStrategy(),
  new VwapReversionStrategy(),
  new MicroScalpingStrategy(),
  new ScalpReversionStrategy(),
];

/** Singleton selector used by both botEngine and backtestEngine */
export const strategySelector = new StrategySelector(ALL_STRATEGIES);
