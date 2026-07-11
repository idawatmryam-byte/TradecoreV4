/**
 * VWAP Reversion Strategy
 *
 * Entry when:
 * - Price is > 0.8% below VWAP
 * - MACD histogram rising from negative (recovering)
 * - Volume decreasing (selling exhaustion)
 * - RSI in 20–45 zone (oversold but not crashed)
 */
import { type Strategy, type StrategySignal, type StrategyConfig, computeQty, computePercentSLTP } from "./base";
import { type MultiTimeframeCandles, type SignalRow, calcVwap, calcMacd } from "../strategy";

export class VwapReversionStrategy implements Strategy {
  readonly strategyId = "vwap_reversion";
  readonly strategyName = "VWAP Reversion";
  readonly supportedRegimes = ["range", "weak_trend", "low_volatility"] as const;

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
    const lastPrice = row.lastPrice;

    // ── VWAP deviation ────────────────────────────────────────────────────
    const vwap = calcVwap(tf1m);
    if (vwap <= 0) return null;
    const vwapDev = ((lastPrice - vwap) / vwap) * 100;
    if (vwapDev > -0.8) return null;

    // ── RSI zone ─────────────────────────────────────────────────────────
    if (row.rsi < 20 || row.rsi > 45) return null;

    // ── MACD histogram recovering ─────────────────────────────────────────
    const closes3m = tf3m.map((c) => c[4]);
    const current = calcMacd(closes3m);
    const prev = closes3m.length > 3 ? calcMacd(closes3m.slice(0, -1)) : current;
    if (current.histogram <= prev.histogram) return null;

    // ── Volume decreasing (selling exhaustion) ────────────────────────────
    const vols = tf1m.map((c) => c[5]);
    const recentAvg = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const prevAvg = vols.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
    const volDecreasing = prevAvg > 0 && recentAvg < prevAvg * 0.9;

    // ── Confidence ────────────────────────────────────────────────────────
    const devBonus = Math.min(20, Math.abs(vwapDev) * 8);
    const rsiBonus = Math.min(12, (45 - row.rsi) * 0.5);
    const volBonus = volDecreasing ? 8 : 0;
    const confidence = Math.min(100, 45 + devBonus + rsiBonus + volBonus);

    if (confidence < config.confidenceThreshold) return null;

    // Phase 5A: SL/TP is a fixed % from entry — no longer ATR- or VWAP-target-based.
    const { slPrice, tpPrice } = computePercentSLTP(lastPrice, config.stopLossPercent, config.takeProfitPercent);

    const qty = computeQty(balance, config.riskPercent, lastPrice, slPrice, positionSizeUsdt);
    if (qty <= 0) return null;

    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      symbol,
      confidence: Math.round(confidence * 10) / 10,
      entryReason: `${Math.abs(vwapDev).toFixed(2)}% below VWAP · RSI ${row.rsi.toFixed(1)} · hist recovering`,
      regime: row.regime,
      entryPrice: lastPrice,
      suggestedSL: slPrice,
      suggestedTP: tpPrice,
      suggestedHoldingTime: config.maxHoldingSeconds,
      qty,
    };
  }
}
