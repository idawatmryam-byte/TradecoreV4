/**
 * TradeCore Pro — trailing-stop geometry
 *
 * Pure distance calculation, no DB or exchange access. Lives here rather than
 * in tradeManager.ts (which imports the database) so the simulated fill model
 * — and its tests — can share the exact formula live trading uses without
 * dragging a database connection along.
 *
 * tradeManager.ts re-exports this, so existing importers are unaffected.
 */
import { calcAtr, type Candle } from "../strategy";
import type { StrategyConfig } from "../strategies";

export function computeTrailingStop(
  mode: string,
  currentPrice: number,
  candles1m: Candle[],
  cfg: StrategyConfig,
  emergency: boolean,
  isShort = false,
): number {
  // A short's trailing stop sits ABOVE current price (mirror of long, which
  // sits below) — every formula below just flips its distance's sign.
  const sign = isShort ? 1 : -1;
  if (emergency) {
    return currentPrice * (1 + sign * cfg.emergencyTrailingPercent / 100);
  }
  switch (mode) {
    case "percent":
      return currentPrice * (1 + sign * cfg.trailingStopPercent / 100);
    case "atr": {
      const atr = calcAtr(candles1m, 14);
      return currentPrice + sign * atr * cfg.trailingStopAtrMultiplier;
    }
    case "dynamic": {
      // "Dynamic" = ATR-based distance that also never exceeds a percent cap,
      // so trailing doesn't get dangerously wide during a volatility spike.
      const atr = calcAtr(candles1m, 14);
      const atrStop = currentPrice + sign * atr * cfg.trailingStopAtrMultiplier;
      const pctStop = currentPrice * (1 + sign * cfg.trailingStopPercent / 100);
      // Long: the LESS generous (higher) of the two candidate stops wins —
      // i.e. Math.max, tighter risk control. Short: mirror is the lower one.
      return isShort ? Math.min(atrStop, pctStop) : Math.max(atrStop, pctStop);
    }
    default:
      return isShort ? Infinity : -Infinity; // "none" — never tightens
  }
}
