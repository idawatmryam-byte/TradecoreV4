/**
 * Trend Pullback Strategy  (primary trend-following strategy)
 *
 * Long entry when:
 * - Strong HTF uptrend: EMA20 > EMA50 on both 15m and 1h
 * - Price pulls back to within 0.5 ATR of EMA20 or EMA50 on 5m
 * - Last candle is bullish (close > open) — momentum resuming
 * - MACD histogram positive
 * - ADX >= 20 on 5m
 *
 * Short entry (Futures Phase — mirror of the above, futures only):
 * - Strong HTF downtrend: EMA20 < EMA50 on both 15m and 1h
 * - Price rallies back to within 0.5 ATR of EMA20 or EMA50 on 5m
 * - Last candle is bearish (close < open) — downward momentum resuming
 * - MACD histogram negative
 * - ADX >= 20 on 5m
 */
import { type Strategy, type StrategySignal, type StrategyConfig, type PositionSide, computeQty, computeAdaptiveSLTP } from "./base";
import { type MultiTimeframeCandles, type SignalRow, calcEma } from "../strategy";

export class TrendPullbackStrategy implements Strategy {
  readonly strategyId = "trend_pullback";
  readonly strategyName = "Trend Pullback";
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

    const { tf5m, tf15m, tf1h } = mtf;
    const lastPrice = row.lastPrice;

    // ── HTF trend alignment ────────────────────────────────────────────────
    const closes15m = tf15m.map((c) => c[4]);
    const ema20_15m = calcEma(closes15m, 20);
    const ema50_15m = calcEma(closes15m, 50);

    const closes1h = tf1h.map((c) => c[4]);
    const ema20_1h = calcEma(closes1h, 20);
    const ema50_1h = calcEma(closes1h, 50);

    let side: PositionSide;
    if (ema20_15m > ema50_15m && ema20_1h > ema50_1h && row.macroBullish) {
      side = "long";
    } else if (ema20_15m < ema50_15m && ema20_1h < ema50_1h && row.macroBearish) {
      side = "short";
    } else {
      return null;
    }

    // ── Pullback: price within 0.5 ATR of EMA20 or EMA50 on 5m ──────────
    const closes5m = tf5m.map((c) => c[4]);
    const ema20_5m = calcEma(closes5m, 20);
    const ema50_5m = calcEma(closes5m, 50);
    const atr = row.atrAbs;
    const pullbackZone = atr * 0.5;
    const nearEma20 = Math.abs(lastPrice - ema20_5m) <= pullbackZone;
    const nearEma50 = Math.abs(lastPrice - ema50_5m) <= pullbackZone;
    if (!nearEma20 && !nearEma50) return null;

    // ── Candle confirmation on 5m: momentum resuming in the trend direction ──
    const lastCandle5m = tf5m[tf5m.length - 1]!;
    if (side === "long" ? lastCandle5m[4] <= lastCandle5m[1] : lastCandle5m[4] >= lastCandle5m[1]) return null;

    // ── ADX confirmation ───────────────────────────────────────────────────
    if (row.adx < 20) return null;

    // ── MACD histogram confirms direction ─────────────────────────────────
    if (side === "long" ? row.macdHistogram <= 0 : row.macdHistogram >= 0) return null;

    // ── Confidence ────────────────────────────────────────────────────────
    let confidence = 60;
    if (row.adx >= 30) confidence += 10;
    confidence += 8; // MACD histogram already confirmed direction above
    if (row.volumeRatio >= 1.3) confidence += 7;
    if (nearEma20 && nearEma50) confidence += 5;
    confidence = Math.min(100, confidence);

    if (confidence < config.confidenceThreshold) return null;

    // Phase 5A: SL/TP is a fixed % from entry. `atr` above is still used for
    // the pullback-zone entry condition — that's market-analysis, not exit calc.
    const { slPrice, tpPrice } = computeAdaptiveSLTP(lastPrice, config, side, row.atrPercent, config.maxHoldingSeconds, row.candleMinutes);

    const qty = computeQty(balance, config.riskPercent, lastPrice, slPrice, positionSizeUsdt, 10, side);
    if (qty <= 0) return null;

    const pullbackLevel = nearEma20 ? `EMA20 (${ema20_5m.toFixed(4)})` : `EMA50 (${ema50_5m.toFixed(4)})`;
    const direction = side === "long" ? "Pullback to" : "Rally to";
    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      symbol,
      side,
      confidence: Math.round(confidence * 10) / 10,
      entryReason: `${direction} ${pullbackLevel} · HTF aligned · ADX ${row.adx.toFixed(1)}`,
      regime: row.regime,
      entryPrice: lastPrice,
      suggestedSL: slPrice,
      suggestedTP: tpPrice,
      suggestedHoldingTime: config.maxHoldingSeconds,
      qty,
    };
  }
}
