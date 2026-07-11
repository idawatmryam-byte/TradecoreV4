/**
 * Mean Reversion Strategy  (range-only)
 *
 * Entry when:
 * - Market regime is "range"
 * - Price touches or breaks below lower Bollinger Band (15m)
 * - RSI overextended low (< 38 on 5m)
 * - ADX < 25 (weak trend confirms range)
 * - Reversion begins: last 1m candle is bullish and higher than previous close
 */
import { type Strategy, type StrategySignal, type StrategyConfig, computeQty, computePercentSLTP } from "./base";
import { type MultiTimeframeCandles, type SignalRow, calcBollingerBands, calcVwap } from "../strategy";

export class MeanReversionStrategy implements Strategy {
  readonly strategyId = "mean_reversion";
  readonly strategyName = "Mean Reversion";
  readonly supportedRegimes = ["range"] as const;

  evaluate(
    symbol: string,
    mtf: MultiTimeframeCandles,
    row: SignalRow,
    config: StrategyConfig,
    balance: number,
    positionSizeUsdt: number,
  ): StrategySignal | null {
    if (!config.enabled) return null;
    if (row.regime !== "range") return null;

    const { tf1m, tf15m } = mtf;
    const lastPrice = row.lastPrice;

    // ── Bollinger Band lower touch ─────────────────────────────────────────
    const closes15m = tf15m.map((c) => c[4]);
    const bb = calcBollingerBands(closes15m, 20, 2);
    const atLowerBand = lastPrice <= bb.lower * 1.005;
    if (!atLowerBand) return null;

    // ── RSI oversold ──────────────────────────────────────────────────────
    if (row.rsi >= 38) return null;

    // ── ADX confirms range ────────────────────────────────────────────────
    if (row.adx >= 25) return null;

    // ── Reversion starting: bullish 1m candle above previous close ────────
    const lastCandle1m = tf1m[tf1m.length - 1]!;
    const prevCandle1m = tf1m[tf1m.length - 2];
    const bouncingUp =
      lastCandle1m[4] > lastCandle1m[1] &&
      prevCandle1m != null && lastCandle1m[4] > prevCandle1m[4];
    if (!bouncingUp) return null;

    // ── Confidence ────────────────────────────────────────────────────────
    const rsiBonus = Math.min(15, (38 - row.rsi) * 0.8);
    const vwap = calcVwap(tf1m);
    const vwapAbove = vwap > lastPrice ? 8 : 0;
    const bandWidth = bb.upper - bb.lower;
    const bandBonus = bandWidth > 0 ? Math.min(10, ((bb.lower - lastPrice) / bandWidth) * 100) : 0;
    const confidence = Math.min(100, 50 + rsiBonus + bandBonus + vwapAbove);

    if (confidence < config.confidenceThreshold) return null;

    // Phase 5A: SL/TP is a fixed % from entry — no longer ATR- or
    // Bollinger/VWAP-target-based. ATR/BB/VWAP above remain entry filters only.
    const { slPrice, tpPrice } = computePercentSLTP(lastPrice, config.stopLossPercent, config.takeProfitPercent);

    const qty = computeQty(balance, config.riskPercent, lastPrice, slPrice, positionSizeUsdt);
    if (qty <= 0) return null;

    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      symbol,
      confidence: Math.round(confidence * 10) / 10,
      entryReason: `BB lower ${bb.lower.toFixed(4)} · RSI ${row.rsi.toFixed(1)} · ADX ${row.adx.toFixed(1)} (range)`,
      regime: row.regime,
      entryPrice: lastPrice,
      suggestedSL: slPrice,
      suggestedTP: tpPrice,
      suggestedHoldingTime: config.maxHoldingSeconds,
      qty,
    };
  }
}
