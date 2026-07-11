/**
 * VWAP Reversion Strategy
 *
 * Long entry when:
 * - Price is > 0.8% below VWAP
 * - MACD histogram rising from negative (recovering)
 * - Volume decreasing (selling exhaustion)
 * - RSI in 20–45 zone (oversold but not crashed)
 *
 * Short entry (Futures Phase — mirror of the above, futures only):
 * - Price is > 0.8% above VWAP
 * - MACD histogram falling from positive (recovering downward)
 * - Volume decreasing (buying exhaustion)
 * - RSI in 55–80 zone (overbought but not blown off — mirror of 20-45)
 */
import { type Strategy, type StrategySignal, type StrategyConfig, type PositionSide, computeQty, computePercentSLTP } from "./base";
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

    let side: PositionSide;
    if (vwapDev < -0.8 && row.rsi >= 20 && row.rsi <= 45) side = "long";
    else if (vwapDev > 0.8 && row.rsi >= 55 && row.rsi <= 80) side = "short";
    else return null;

    // ── MACD histogram recovering back toward zero ────────────────────────
    const closes3m = tf3m.map((c) => c[4]);
    const current = calcMacd(closes3m);
    const prev = closes3m.length > 3 ? calcMacd(closes3m.slice(0, -1)) : current;
    if (side === "long" ? current.histogram <= prev.histogram : current.histogram >= prev.histogram) return null;

    // ── Volume decreasing (exhaustion, either direction) ──────────────────
    const vols = tf1m.map((c) => c[5]);
    const recentAvg = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const prevAvg = vols.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
    const volDecreasing = prevAvg > 0 && recentAvg < prevAvg * 0.9;

    // ── Confidence ────────────────────────────────────────────────────────
    const devBonus = Math.min(20, Math.abs(vwapDev) * 8);
    const rsiBonus = side === "long" ? Math.min(12, (45 - row.rsi) * 0.5) : Math.min(12, (row.rsi - 55) * 0.5);
    const volBonus = volDecreasing ? 8 : 0;
    const confidence = Math.min(100, 45 + devBonus + rsiBonus + volBonus);

    if (confidence < config.confidenceThreshold) return null;

    // Phase 5A: SL/TP is a fixed % from entry — no longer ATR- or VWAP-target-based.
    const { slPrice, tpPrice } = computePercentSLTP(lastPrice, config.stopLossPercent, config.takeProfitPercent, side);

    const qty = computeQty(balance, config.riskPercent, lastPrice, slPrice, positionSizeUsdt, 10, side);
    if (qty <= 0) return null;

    const devWord = side === "long" ? "below" : "above";
    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      symbol,
      side,
      confidence: Math.round(confidence * 10) / 10,
      entryReason: `${Math.abs(vwapDev).toFixed(2)}% ${devWord} VWAP · RSI ${row.rsi.toFixed(1)} · hist recovering`,
      regime: row.regime,
      entryPrice: lastPrice,
      suggestedSL: slPrice,
      suggestedTP: tpPrice,
      suggestedHoldingTime: config.maxHoldingSeconds,
      qty,
    };
  }
}
