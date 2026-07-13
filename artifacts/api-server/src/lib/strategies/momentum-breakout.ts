/**
 * Momentum Breakout Strategy
 *
 * Long entry when:
 * - Price breaks the recent N-bar high (last 20 × 15m bars)
 * - Volume > 1.5× average
 * - ADX >= 20 (trend confirmation)
 * - 1h macro bullish
 *
 * Short entry (Futures Phase — mirror of the above, futures only):
 * - Price breaks the recent N-bar LOW
 * - Volume > 1.5× average
 * - ADX >= 20
 * - 1h macro bearish
 *
 * Percentage-based stop and take-profit (Phase 5A).
 */
import { type Strategy, type StrategySignal, type StrategyConfig, type PositionSide, computeQty, computeAdaptiveSLTP } from "./base";
import { type MultiTimeframeCandles, type SignalRow } from "../strategy";

export class MomentumBreakoutStrategy implements Strategy {
  readonly strategyId = "momentum_breakout";
  readonly strategyName = "Momentum Breakout";
  readonly supportedRegimes = ["strong_trend", "weak_trend"] as const;

  evaluate(
    symbol: string,
    mtf: MultiTimeframeCandles,
    row: SignalRow,
    config: StrategyConfig,
    balance: number,
    positionSizeUsdt: number,
  ): StrategySignal | null {
    if (!config.enabled) return null;
    if (!this.supportedRegimes.includes(row.regime as any)) return null;

    const { tf15m } = mtf;
    const lastPrice = row.lastPrice;

    // ── Volume + ADX confirmation (shared by both directions) ────────────────
    if (row.volumeRatio < 1.5) return null;
    if (row.adx < 20) return null;

    const lookback = tf15m.slice(-21, -1);
    if (lookback.length < 10) return null;

    const side: PositionSide | null = row.macroBullish ? "long" : row.macroBearish ? "short" : null;
    if (!side) return null;

    let entryReason: string;
    if (side === "long") {
      const recentHigh = Math.max(...lookback.map((c) => c[2]));
      if (lastPrice <= recentHigh) return null;
      entryReason = `Breakout above ${recentHigh.toFixed(4)} · Vol×${row.volumeRatio.toFixed(2)} · ADX ${row.adx.toFixed(1)}`;
    } else {
      const recentLow = Math.min(...lookback.map((c) => c[3]));
      if (lastPrice >= recentLow) return null;
      entryReason = `Breakdown below ${recentLow.toFixed(4)} · Vol×${row.volumeRatio.toFixed(2)} · ADX ${row.adx.toFixed(1)}`;
    }

    // ── Confidence (same formula either direction) ────────────────────────────
    const adxBonus = Math.min(25, (row.adx - 20) * 1.5);
    const volBonus = Math.min(10, (row.volumeRatio - 1.5) * 5);
    const macroBonus = 5; // side was only chosen when the macro filter agreed
    const confidence = Math.min(100, 55 + adxBonus + volBonus + macroBonus);

    if (confidence < config.confidenceThreshold) return null;

    // Phase 5A: SL/TP is a fixed % from entry, not ATR-derived.
    const { slPrice, tpPrice } = computeAdaptiveSLTP(lastPrice, config, side, row.atrPercent);

    const qty = computeQty(balance, config.riskPercent, lastPrice, slPrice, positionSizeUsdt, 10, side);
    if (qty <= 0) return null;

    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      symbol,
      side,
      confidence: Math.round(confidence * 10) / 10,
      entryReason,
      regime: row.regime,
      entryPrice: lastPrice,
      suggestedSL: slPrice,
      suggestedTP: tpPrice,
      suggestedHoldingTime: config.maxHoldingSeconds,
      qty,
    };
  }
}
