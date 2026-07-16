/**
 * 20 Minutes Trading Strategy  (short-horizon momentum confluence)
 *
 * Purpose-built for fast, minutes-scale trades: it only takes a position when
 * SEVERAL independent indicators agree on direction, so a short-duration trade
 * has a genuine directional push behind it (the thing that lets a small target
 * be hit quickly) rather than fading random noise.
 *
 * DIRECTION is decided by 5-signal confluence (long shown; short is the exact
 * mirror). A signal only fires when the majority align:
 *
 *   1. TREND      — EMA20 > EMA50 on 3m  (short-term uptrend)
 *   2. MOMENTUM   — MACD histogram > 0   (momentum pushing up, 3m)
 *   3. FAIR VALUE — price > session VWAP on 1m  (buyers in control intraday)
 *   4. STRENGTH   — RSI(14) in 50–72     (rising, not yet exhausted/overbought)
 *   5. CONVICTION — ADX ≥ 20 AND volume ≥ 1× average (a real, participated move)
 *
 * All five must agree to enter (a 20-minute trade has no time to survive a
 * disagreeing indicator). Confidence scales with HOW strongly they agree, so
 * the cleanest setups rank highest and get taken first.
 *
 * WHY THESE INDICATORS: they're deliberately non-redundant — trend (EMA),
 * momentum (MACD), mean/fair-value (VWAP), strength/exhaustion (RSI), and
 * conviction (ADX + volume) each measure a different thing. Agreement across
 * five different lenses is a far better directional filter than five flavors
 * of the same oscillator.
 *
 * EXITS use the shared volatility-adaptive SL/TP + the selector's per-coin fit
 * check, so on coins too quiet to reach the target inside the 20-minute window
 * the trade is skipped rather than left to time out. Pair with the per-strategy
 * dollar plan (Trade Amount / Max Loss / Target) on the Strategies page.
 */
import {
  type Strategy, type StrategySignal, type StrategyConfig, type PositionSide,
  computeQty, computeAdaptiveSLTP,
} from "./base";
import { type MultiTimeframeCandles, type SignalRow, calcEma, calcVwap } from "../strategy";

export class TwentyMinMomentumStrategy implements Strategy {
  readonly strategyId = "twenty_min_momentum";
  readonly strategyName = "20 Minutes Trading Strategy";
  // Momentum needs movement to ride — active regimes only. Range / low-vol have
  // no directional push to reach a target in 20 minutes.
  readonly supportedRegimes = ["strong_trend", "weak_trend", "high_volatility"] as const;

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

    const { tf1m, tf3m } = mtf;
    if (tf3m.length < 50 || tf1m.length < 20) return null;
    const lastPrice = row.lastPrice;

    // ── Indicator readings ───────────────────────────────────────────────────
    const closes3m = tf3m.map((c) => c[4]);
    const ema20 = calcEma(closes3m, 20);   // short-term trend
    const ema50 = calcEma(closes3m, 50);   // medium-term trend
    const vwap = calcVwap(tf1m);            // intraday fair value
    const macdHist = row.macdHistogram;     // momentum (3m)
    const rsi = row.rsi;                     // strength/exhaustion (5m)
    const adx = row.adx;                     // trend strength
    const vol = row.volumeRatio;             // participation

    // Shared conviction gates (same for both directions).
    const strongEnough = adx >= 20 && vol >= 1.0;
    if (!strongEnough) return null;

    // ── 5-signal confluence per side ─────────────────────────────────────────
    const longSignals = {
      trend: ema20 > ema50,
      momentum: macdHist > 0,
      fairValue: lastPrice > vwap,
      strength: rsi >= 50 && rsi <= 72,
    };
    const shortSignals = {
      trend: ema20 < ema50,
      momentum: macdHist < 0,
      fairValue: lastPrice < vwap,
      strength: rsi <= 50 && rsi >= 28,
    };

    let side: PositionSide;
    let signals: typeof longSignals;
    if (longSignals.trend && longSignals.momentum && longSignals.fairValue && longSignals.strength) {
      side = "long";
      signals = longSignals;
    } else if (shortSignals.trend && shortSignals.momentum && shortSignals.fairValue && shortSignals.strength) {
      side = "short";
      signals = shortSignals;
    } else {
      return null; // no clean directional agreement — sit out
    }

    // ── Confidence: how STRONGLY the five lenses agree ───────────────────────
    // Base for all-5-aligned, plus graded bonuses for the strength of each.
    const vwapDistPct = vwap > 0 ? (Math.abs(lastPrice - vwap) / vwap) * 100 : 0;
    const rsiRoom = side === "long" ? 72 - rsi : rsi - 28; // headroom before exhaustion
    let confidence = 55;
    confidence += Math.min(15, (adx - 20) * 0.6);           // stronger trend
    confidence += Math.min(10, vwapDistPct * 20);           // clearly the right side of VWAP
    confidence += Math.min(8, Math.max(0, rsiRoom) * 0.4);  // momentum with room to run
    confidence += Math.min(7, (vol - 1) * 7);               // volume surge
    confidence = Math.min(100, confidence);
    if (confidence < config.confidenceThreshold) return null;

    // ── Volatility-adaptive, fee-aware SL/TP (dollar plan overrides in selector) ──
    const { slPrice, tpPrice } = computeAdaptiveSLTP(
      lastPrice, config, side, row.atrPercent, config.maxHoldingSeconds, row.candleMinutes,
    );

    const qty = computeQty(balance, config.riskPercent, lastPrice, slPrice, positionSizeUsdt, 10, side);
    if (qty <= 0) return null;

    const aligned = Object.values(signals).filter(Boolean).length;
    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      symbol,
      side,
      confidence: Math.round(confidence * 10) / 10,
      entryReason: `${aligned}/4 momentum confluence · ADX ${adx.toFixed(0)} · RSI ${rsi.toFixed(0)} · ${vol.toFixed(1)}× vol`,
      regime: row.regime,
      entryPrice: lastPrice,
      suggestedSL: slPrice,
      suggestedTP: tpPrice,
      suggestedHoldingTime: config.maxHoldingSeconds,
      qty,
    };
  }
}
