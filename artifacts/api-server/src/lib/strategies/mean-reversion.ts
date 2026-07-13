/**
 * Mean Reversion Strategy  (range-only)
 *
 * Long entry when:
 * - Market regime is "range"
 * - Price touches or breaks below lower Bollinger Band (15m)
 * - RSI overextended low (< 38 on 5m)
 * - ADX < 25 (weak trend confirms range)
 * - Reversion begins: last 1m candle is bullish and higher than previous close
 *
 * Short entry (Futures Phase — mirror of the above, futures only):
 * - Price touches or breaks above upper Bollinger Band (15m)
 * - RSI overextended high (> 62 on 5m — mirror of the long's 38)
 * - ADX < 25
 * - Reversion begins: last 1m candle is bearish and lower than previous close
 */
import { type Strategy, type StrategySignal, type StrategyConfig, type PositionSide, computeQty, computeAdaptiveSLTP } from "./base";
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

    // ── ADX confirms range (shared by both directions) ────────────────────
    if (row.adx >= 25) return null;

    const { tf1m, tf15m } = mtf;
    const lastPrice = row.lastPrice;
    const closes15m = tf15m.map((c) => c[4]);
    const bb = calcBollingerBands(closes15m, 20, 2);

    const atLowerBand = lastPrice <= bb.lower * 1.005;
    const atUpperBand = lastPrice >= bb.upper * 0.995;

    let side: PositionSide;
    if (atLowerBand && row.rsi < 38) side = "long";
    else if (atUpperBand && row.rsi > 62) side = "short";
    else return null;

    // ── Reversion starting: candle turning back toward the band's middle ────
    const lastCandle1m = tf1m[tf1m.length - 1]!;
    const prevCandle1m = tf1m[tf1m.length - 2];
    const reverting = side === "long"
      ? lastCandle1m[4] > lastCandle1m[1] && prevCandle1m != null && lastCandle1m[4] > prevCandle1m[4]
      : lastCandle1m[4] < lastCandle1m[1] && prevCandle1m != null && lastCandle1m[4] < prevCandle1m[4];
    if (!reverting) return null;

    // ── Confidence ────────────────────────────────────────────────────────
    const rsiExtreme = side === "long" ? 38 - row.rsi : row.rsi - 62;
    const rsiBonus = Math.min(15, rsiExtreme * 0.8);
    const vwap = calcVwap(tf1m);
    const vwapBonus = side === "long" ? (vwap > lastPrice ? 8 : 0) : (vwap < lastPrice ? 8 : 0);
    const bandWidth = bb.upper - bb.lower;
    const bandDist = side === "long" ? bb.lower - lastPrice : lastPrice - bb.upper;
    const bandBonus = bandWidth > 0 ? Math.min(10, (bandDist / bandWidth) * 100) : 0;
    const confidence = Math.min(100, 50 + rsiBonus + bandBonus + vwapBonus);

    if (confidence < config.confidenceThreshold) return null;

    // Phase 5A: SL/TP is a fixed % from entry — no longer ATR- or
    // Bollinger/VWAP-target-based. ATR/BB/VWAP above remain entry filters only.
    const { slPrice, tpPrice } = computeAdaptiveSLTP(lastPrice, config, side, row.atrPercent, config.maxHoldingSeconds, row.candleMinutes);

    const qty = computeQty(balance, config.riskPercent, lastPrice, slPrice, positionSizeUsdt, 10, side);
    if (qty <= 0) return null;

    const band = side === "long" ? `BB lower ${bb.lower.toFixed(4)}` : `BB upper ${bb.upper.toFixed(4)}`;
    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      symbol,
      side,
      confidence: Math.round(confidence * 10) / 10,
      entryReason: `${band} · RSI ${row.rsi.toFixed(1)} · ADX ${row.adx.toFixed(1)} (range)`,
      regime: row.regime,
      entryPrice: lastPrice,
      suggestedSL: slPrice,
      suggestedTP: tpPrice,
      suggestedHoldingTime: config.maxHoldingSeconds,
      qty,
    };
  }
}
