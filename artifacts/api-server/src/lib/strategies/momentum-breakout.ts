/**
 * Momentum Breakout Strategy
 *
 * Entry when:
 * - Price breaks the recent N-bar high (last 20 × 15m bars)
 * - Volume > 1.5× average
 * - ADX >= 20 (trend confirmation)
 * - 1h macro bullish
 *
 * Percentage-based stop and take-profit (Phase 5A).
 */
import { type Strategy, type StrategySignal, type StrategyConfig, computeQty, computePercentSLTP } from "./base";
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
    if (!row.macroBullish) return null;

    const { tf15m } = mtf;
    const lastPrice = row.lastPrice;

    // ── Breakout: price above the highest high of last 20 bars (ex current) ──
    const lookback = tf15m.slice(-21, -1);
    if (lookback.length < 10) return null;
    const recentHigh = Math.max(...lookback.map((c) => c[2]));
    if (lastPrice <= recentHigh) return null;

    // ── Volume confirmation ────────────────────────────────────────────────
    if (row.volumeRatio < 1.5) return null;

    // ── ADX confirmation ───────────────────────────────────────────────────
    if (row.adx < 20) return null;

    // ── Confidence ─────────────────────────────────────────────────────────
    const adxBonus = Math.min(25, (row.adx - 20) * 1.5);
    const volBonus = Math.min(10, (row.volumeRatio - 1.5) * 5);
    const macroBonus = row.macroBullish ? 5 : 0;
    const confidence = Math.min(100, 55 + adxBonus + volBonus + macroBonus);

    if (confidence < config.confidenceThreshold) return null;

    // Phase 5A: SL/TP is a fixed % from entry, not ATR-derived.
    const { slPrice, tpPrice } = computePercentSLTP(lastPrice, config.stopLossPercent, config.takeProfitPercent);

    const qty = computeQty(balance, config.riskPercent, lastPrice, slPrice, positionSizeUsdt);
    if (qty <= 0) return null;

    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      symbol,
      confidence: Math.round(confidence * 10) / 10,
      entryReason: `Breakout above ${recentHigh.toFixed(4)} · Vol×${row.volumeRatio.toFixed(2)} · ADX ${row.adx.toFixed(1)}`,
      regime: row.regime,
      entryPrice: lastPrice,
      suggestedSL: slPrice,
      suggestedTP: tpPrice,
      suggestedHoldingTime: config.maxHoldingSeconds,
      qty,
    };
  }
}
