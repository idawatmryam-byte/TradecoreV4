/**
 * Micro Scalping Strategy  (1m/3m charts)
 *
 * Entry when:
 * - Volume surge > 2× on 1m
 * - RSI in 45–65 zone (not overbought)
 * - MACD histogram positive and rising on 3m
 * - Trend aligned: EMA20 > EMA50 on both 5m and 15m
 * - 1m EMA10 slope sharply positive (momentum spike)
 *
 * Tight percentage-based exits (Phase 5A), short holding times.
 */
import { type Strategy, type StrategySignal, type StrategyConfig, computeQty, computePercentSLTP } from "./base";
import { type MultiTimeframeCandles, type SignalRow, calcEma, calcMacd } from "../strategy";

export class MicroScalpingStrategy implements Strategy {
  readonly strategyId = "micro_scalping";
  readonly strategyName = "Micro Scalping";
  readonly supportedRegimes = ["strong_trend", "weak_trend", "range"] as const;

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

    const { tf1m, tf3m, tf5m, tf15m } = mtf;
    const lastPrice = row.lastPrice;

    // ── Volume surge ──────────────────────────────────────────────────────
    if (row.volumeRatio < 2.0) return null;

    // ── RSI scalp zone ────────────────────────────────────────────────────
    if (row.rsi < 45 || row.rsi > 65) return null;

    // ── MACD histogram positive and rising on 3m ──────────────────────────
    const closes3m = tf3m.map((c) => c[4]);
    const curr = calcMacd(closes3m);
    const prev = closes3m.length > 3 ? calcMacd(closes3m.slice(0, -1)) : curr;
    if (curr.histogram <= 0 || curr.histogram <= prev.histogram) return null;

    // ── Trend alignment: 5m and 15m EMA20 > EMA50 ────────────────────────
    const closes5m = tf5m.map((c) => c[4]);
    if (calcEma(closes5m, 20) <= calcEma(closes5m, 50)) return null;

    const closes15m = tf15m.map((c) => c[4]);
    if (calcEma(closes15m, 20) <= calcEma(closes15m, 50)) return null;

    // ── Momentum spike: 1m EMA10 slope positive ───────────────────────────
    const closes1m = tf1m.map((c) => c[4]);
    const ema10_now = calcEma(closes1m, 10);
    const ema10_prev = closes1m.length > 5 ? calcEma(closes1m.slice(0, -3), 10) : ema10_now;
    const slopePct = ema10_prev > 0 ? ((ema10_now - ema10_prev) / ema10_prev) * 100 : 0;
    if (slopePct <= 0.01) return null;

    // ── Confidence ────────────────────────────────────────────────────────
    const volBonus = Math.min(15, (row.volumeRatio - 2.0) * 5);
    const slopeBonus = Math.min(10, slopePct * 50);
    const macroBonus = row.macroBullish ? 8 : 0;
    const confidence = Math.min(100, 52 + volBonus + slopeBonus + macroBonus);

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
      entryReason: `Vol×${row.volumeRatio.toFixed(2)} · 3m MACD↑ · 5m+15m aligned · slope ${slopePct.toFixed(3)}%`,
      regime: row.regime,
      entryPrice: lastPrice,
      suggestedSL: slPrice,
      suggestedTP: tpPrice,
      suggestedHoldingTime: config.maxHoldingSeconds,
      qty,
    };
  }
}
