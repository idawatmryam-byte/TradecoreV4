/**
 * Scalp Reversion Strategy  (1-minute mean-reversion — intraday scalping test)
 *
 * This is a deliberate architectural BREAK from the swing strategies: it uses
 * ONLY 1-minute price action and does NOT consult the 1h macro filter or the
 * 15m/1h trend alignment those strategies require. Its thesis is short-horizon
 * mean reversion — when 1m price stretches to a statistical extreme and shows a
 * reversal tick, it fades back toward the mean for a quick, tight-R scalp.
 *
 * Long entry when (mirror for short):
 * - 1m close is at/below the lower Bollinger Band (20, 2σ) — a stretched extreme
 * - 1m RSI(14) ≤ 30 — momentum oversold, confirming the stretch
 * - the current 1m candle closed UP (close > open) — a reversal tick, so we
 *   fade a bounce, not catch a falling knife
 * - NOT in a strong trend (fading a strong trend is how mean-reversion dies) —
 *   enforced via supportedRegimes below
 *
 * Exits: tight, volatility-adaptive SL/TP (computeAdaptiveSLTP caps the target
 * to what 1m volatility can actually reach inside the short hold and preserves
 * the configured R:R). The selector's net-reward:risk-after-cost gate then
 * REJECTS any setup whose reachable target can't clear round-trip maker fees —
 * which is the whole point of scalping honestly: no trade unless the expected
 * move beats the cost. Pair with maker entries + the fixed-dollar risk config
 * to model a professional intraday scalper.
 */
import { type Strategy, type StrategySignal, type StrategyConfig, type PositionSide, computeQty, computeAdaptiveSLTP } from "./base";
import { type MultiTimeframeCandles, type SignalRow, calcBollingerBands, calcRsi } from "../strategy";

export class ScalpReversionStrategy implements Strategy {
  readonly strategyId = "scalp_reversion";
  readonly strategyName = "Scalp Reversion";
  // Fade extremes in range / weak-trend / volatility regimes — NOT strong_trend,
  // where price runs through the bands and reversion setups get run over.
  readonly supportedRegimes = ["range", "weak_trend", "low_volatility", "high_volatility"] as const;
  readonly indicators = [
    "Bollinger Bands 20/2σ (1m)",
    "RSI(14) ≤ 30 / ≥ 70 (1m)",
    "Reversal candle tick (1m)",
    "Regime filter — never fades a strong trend",
  ] as const;

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

    const { tf1m } = mtf;
    if (tf1m.length < 20) return null;
    const lastPrice = row.lastPrice;

    // ── 1m statistical extreme (Bollinger) + momentum extreme (RSI) ──────────
    const closes1m = tf1m.map((c) => c[4]);
    const bb = calcBollingerBands(closes1m, 20, 2);
    if (bb.stdDev <= 0) return null; // flat/degenerate — nothing to revert to
    const rsi1m = calcRsi(closes1m, 14);

    const lastCandle = tf1m[tf1m.length - 1]!;
    const [, open, , , close] = lastCandle;
    const bouncedUp = close > open;   // reversal tick for a long
    const bouncedDown = close < open; // reversal tick for a short

    let side: PositionSide;
    if (lastPrice <= bb.lower && rsi1m <= 30 && bouncedUp) {
      side = "long";
    } else if (lastPrice >= bb.upper && rsi1m >= 70 && bouncedDown) {
      side = "short";
    } else {
      return null;
    }

    // ── Confidence: base + how extreme the RSI is + how far beyond the band ──
    const rsiExtremity = side === "long" ? (30 - rsi1m) : (rsi1m - 70); // 0..30+
    const bandDistPct = bb.middle > 0
      ? (Math.abs(lastPrice - (side === "long" ? bb.lower : bb.upper)) / bb.middle) * 100
      : 0;
    const confidence = Math.min(
      100,
      52 + Math.min(18, rsiExtremity) + Math.min(10, bandDistPct * 40),
    );
    if (confidence < config.confidenceThreshold) return null;

    // ── Tight, volatility-adaptive, fee-aware SL/TP ──────────────────────────
    const { slPrice, tpPrice } = computeAdaptiveSLTP(
      lastPrice, config, side, row.atrPercent, config.maxHoldingSeconds, row.candleMinutes,
    );

    const qty = computeQty(balance, config.riskPercent, lastPrice, slPrice, positionSizeUsdt, 10, side);
    if (qty <= 0) return null;

    const band = side === "long" ? "lower" : "upper";
    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      symbol,
      side,
      confidence: Math.round(confidence * 10) / 10,
      entryReason: `1m ${band}-band fade · RSI ${rsi1m.toFixed(0)} · reversal tick`,
      regime: row.regime,
      entryPrice: lastPrice,
      suggestedSL: slPrice,
      suggestedTP: tpPrice,
      suggestedHoldingTime: config.maxHoldingSeconds,
      qty,
    };
  }
}
