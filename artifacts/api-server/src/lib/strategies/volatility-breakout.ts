/**
 * Volatility Breakout Strategy
 *
 * Long entry when:
 * - Bollinger Band squeeze (current stdDev < 80% of recent average)
 * - ATR expanding (current > previous × 1.1)
 * - Price breaks above upper Bollinger Band on 15m
 * - Breakout candle is bullish
 * - Volume increasing
 *
 * Short entry (Futures Phase — mirror of the above, futures only):
 * - Bollinger Band squeeze
 * - ATR expanding
 * - Price breaks below lower Bollinger Band on 15m
 * - Breakout candle is bearish
 * - Volume increasing
 */
import { type Strategy, type StrategySignal, type StrategyConfig, type PositionSide, computeQty, computeAdaptiveSLTP } from "./base";
import { type MultiTimeframeCandles, type SignalRow, calcBollingerBands, calcAtr } from "../strategy";

export class VolatilityBreakoutStrategy implements Strategy {
  readonly strategyId = "volatility_breakout";
  readonly strategyName = "Volatility Breakout";
  readonly supportedRegimes = ["range", "weak_trend", "high_volatility"] as const;

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

    const { tf1m, tf15m } = mtf;
    const lastPrice = row.lastPrice;

    // ── Bollinger Band squeeze detection (shared by both directions) ──────
    // Phase 6 audit fix: the previous version built `window = closes15m.slice(-i-5, -i)`,
    // which is ALWAYS exactly 5 elements regardless of `i` — the `if (window.length >= 10)`
    // guard below it could therefore never pass, `stdDevCount` stayed 0 for
    // every iteration, and `avgStdDev` always fell back to `bbNow.stdDev`
    // itself — making `bbNow.stdDev >= avgStdDev * 0.8` trivially true on
    // every evaluation (self-comparison). The strategy could never detect a
    // squeeze and could never fire, under any market condition, confirmed by
    // simulating the exact slice arithmetic. Fixed by computing a properly-
    // sized 20-period BB at each of the last `lookbackPoints` bar-ends
    // (shifted back 1..N bars from the most recent close), giving a real
    // historical average to compare the current stdDev against.
    const closes15m = tf15m.map((c) => c[4]);
    const bbNow = calcBollingerBands(closes15m, 20, 2);

    const bbPeriod = 20;
    const lookbackPoints = 10;
    let stdDevSum = 0;
    let stdDevCount = 0;
    for (let i = 1; i <= lookbackPoints; i++) {
      const windowEnd = closes15m.length - i;
      const windowStart = windowEnd - bbPeriod;
      if (windowStart < 0) break; // not enough history this far back
      const window = closes15m.slice(windowStart, windowEnd);
      if (window.length === bbPeriod) {
        const bb = calcBollingerBands(window, bbPeriod, 2);
        stdDevSum += bb.stdDev;
        stdDevCount++;
      }
    }
    const avgStdDev = stdDevCount > 0 ? stdDevSum / stdDevCount : bbNow.stdDev;
    if (avgStdDev <= 0 || bbNow.stdDev >= avgStdDev * 0.8) return null; // no squeeze

    // ── ATR expanding ─────────────────────────────────────────────────────
    const atrCurrent = row.atrAbs;
    const atrPrev = calcAtr(tf1m.length > 10 ? tf1m.slice(0, -5) : tf1m, 14);
    if (atrPrev <= 0 || atrCurrent <= atrPrev * 1.1) return null;

    // ── Price breaks out of the squeeze, either direction ─────────────────
    const lastCandle = tf15m[tf15m.length - 1]!;
    let side: PositionSide;
    if (lastPrice > bbNow.upper && lastCandle[4] > lastCandle[1]) {
      side = "long";
    } else if (lastPrice < bbNow.lower && lastCandle[4] < lastCandle[1]) {
      side = "short";
    } else {
      return null;
    }

    // ── Volume increasing ─────────────────────────────────────────────────
    if (row.volumeRatio < 1.3) return null;

    // ── Confidence ────────────────────────────────────────────────────────
    const squeezeBonus = Math.min(15, (1 - bbNow.stdDev / avgStdDev) * 50);
    const volBonus = Math.min(10, (row.volumeRatio - 1.3) * 8);
    const atrBonus = Math.min(10, (atrCurrent / atrPrev - 1) * 20);
    const macroBonus = (side === "long" ? row.macroBullish : row.macroBearish) ? 5 : 0;
    const confidence = Math.min(100, 50 + squeezeBonus + volBonus + atrBonus + macroBonus);

    if (confidence < config.confidenceThreshold) return null;

    // Phase 5A: SL/TP is a fixed % from entry — no longer ATR- or
    // BB-middle-based. ATR/BB above remain squeeze/entry detection only.
    const { slPrice, tpPrice } = computeAdaptiveSLTP(lastPrice, config, side, row.atrPercent, config.maxHoldingSeconds, row.candleMinutes);

    const qty = computeQty(balance, config.riskPercent, lastPrice, slPrice, positionSizeUsdt, 10, side);
    if (qty <= 0) return null;

    const band = side === "long" ? `above ${bbNow.upper.toFixed(4)}` : `below ${bbNow.lower.toFixed(4)}`;
    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      symbol,
      side,
      confidence: Math.round(confidence * 10) / 10,
      entryReason: `BB squeeze breakout ${band} · ATR↑ · Vol×${row.volumeRatio.toFixed(2)}`,
      regime: row.regime,
      entryPrice: lastPrice,
      suggestedSL: slPrice,
      suggestedTP: tpPrice,
      suggestedHoldingTime: config.maxHoldingSeconds,
      qty,
    };
  }
}
