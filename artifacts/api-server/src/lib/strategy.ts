/**
 * TradeCore Pro — Shared Strategy Logic  (Phase 1 Professional Engine)
 *
 * Pure, stateless functions used by BOTH the live BotEngine and the
 * BacktestEngine so strategy decisions are always identical.
 *
 * Architecture:
 *   Multi-timeframe (1m / 3m / 5m / 15m / 1h)
 *   → 12-indicator weighted voting (confidence 0–100)
 *   → Market regime detection (5 regimes)
 *   → Percentage-based SL/TP (Phase 5A — see strategies/base.ts computePercentSLTP;
 *     ATR remains available here only as a market-analysis indicator, e.g. regime
 *     detection below, never as an exit-price calculation)
 *   → Risk-percentage position sizing
 */

// ccxt / Binance OHLCV format: [timestamp, open, high, low, close, volume]
export type Candle = [number, number, number, number, number, number];

export type VoteSignal = "bullish" | "bearish" | "neutral";

export type MarketRegime =
  | "strong_trend"
  | "weak_trend"
  | "range"
  | "high_volatility"
  | "low_volatility";

export interface IndicatorVote {
  name: string;
  signal: VoteSignal;
  weight: number;
  /** Raw indicator value for logging and UI display */
  value: number;
}

/** One candle array per timeframe, each sorted ascending by timestamp */
export interface MultiTimeframeCandles {
  tf1m: Candle[];  // entry / ATR / volume / candle structure
  tf3m: Candle[];  // MACD (momentum)
  tf5m: Candle[];  // EMA trend / RSI / ADX
  tf15m: Candle[]; // Bollinger Bands / S&R / trend alignment confirmation
  tf1h: Candle[];  // macro direction (EMA50)
}

export interface SignalRow {
  // ── Backward-compatible fields (kept in API) ──────────────────────────────
  symbol: string;
  /** 0–100, mathematically derived from weighted indicator votes */
  confidence: number;
  /** RSI(14) on 5m */
  rsi: number;
  /** ATR(14) / price × 100 on 1m */
  atrPercent: number;
  /** Kept for API compat — now means EMA20 > EMA50 on 5m */
  ema5AboveEma20: boolean;
  /** 1h close > EMA50(1h) */
  macroBullish: boolean;
  /** 1h close < EMA50(1h) — Futures Phase: the short-side mirror of macroBullish. Not simply !macroBullish (both can be false exactly at EMA50). */
  macroBearish: boolean;
  /** Futures Phase: symmetric bearish-vote confidence (0-100), the short-side
   *  mirror of `confidence` — computed the same way but from bearish votes
   *  instead of bullish ones. Strategies gate short entries against this
   *  instead of `confidence`. */
  shortConfidence: number;
  /** Last 1m volume / 20-period rolling average */
  volumeRatio: number;
  lastPrice: number;

  // ── New fields ────────────────────────────────────────────────────────────
  regime: MarketRegime;
  adx: number;
  macdHistogram: number;
  /** ATR absolute value in quote currency (used for SL/TP calculation) */
  atrAbs: number;
  /** Minutes per candle of the primary series atrPercent was computed on
   *  (1 live; can be 5/15/… in coarse backtests). Lets volatility-scaled
   *  target math normalize instead of assuming per-minute ATR. */
  candleMinutes: number;
  /** Full indicator breakdown for structured logging and UI */
  votes: IndicatorVote[];
}

// ── Indicator weights — must sum to 100 ───────────────────────────────────
// Increase a weight to make that indicator more influential on confidence.
export const INDICATOR_WEIGHTS: Record<string, number> = {
  ema_cross:           10, // EMA20 > EMA50 on 5m   (short-term trend)
  ema50_slope:          8, // EMA50 sloping up on 5m (medium-term direction)
  ema_slope_1m:         7, // EMA10 slope on 1m      (immediate momentum)
  rsi:                  8, // RSI(14) on 5m in 40–65 zone
  macd_histogram:      10, // MACD(12,26,9) histogram on 3m positive & rising
  adx_strength:         8, // ADX(14) on 5m ≥ 20 confirms a trend is present
  vwap_position:        8, // Price above session VWAP on 1m
  bollinger_position:   8, // Price position vs Bollinger(20,2) on 15m
  volume_spike:        10, // Volume ≥ 1.5× 20-period average on 1m
  candle_structure:     6, // Bullish body + wick rejection on 1m
  support_resistance:   7, // Price near pivot support, away from resistance on 15m
  trend_alignment:     10, // 3m + 5m + 15m EMA20>EMA50 all agree bullish
};

// ─────────────────────────────────────────────────────────────────────────────
// Low-level indicator functions (all exported for reuse / testing)
// ─────────────────────────────────────────────────────────────────────────────

export function calcEma(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  if (closes.length < period) return closes[closes.length - 1]!;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    val = closes[i]! * k + val * (1 - k);
  }
  return val;
}

export function calcAtr(candles: Candle[], period: number): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const [, , high, low] = candles[i]!;
    const prevClose = candles[i - 1]![4];
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const slice = trs.slice(-Math.min(period, trs.length));
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function calcRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  const relevant = closes.slice(-(period + 1));
  for (let i = 1; i < relevant.length; i++) {
    const diff = relevant[i]! - relevant[i - 1]!;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function hasWickPullback(candle: Candle): boolean {
  const [, open, high, low, close] = candle;
  const body = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  return Math.max(upperWick, lowerWick) > body;
}

/** Internal: full EMA sequence needed for MACD signal computation */
function calcEmaArray(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let ema = closes[0]!;
  for (let i = 0; i < closes.length; i++) {
    ema = i === 0 ? closes[0]! : closes[i]! * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

export function calcMacd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { macd: number; signal: number; histogram: number } {
  if (closes.length < slowPeriod + signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0 };
  }
  const emaFast = calcEmaArray(closes, fastPeriod);
  const emaSlow = calcEmaArray(closes, slowPeriod);

  // MACD line: valid from slowPeriod-1 onwards (early values are noisy but usable)
  const macdHistory: number[] = [];
  for (let i = slowPeriod - 1; i < closes.length; i++) {
    macdHistory.push(emaFast[i]! - emaSlow[i]!);
  }

  const macdLine = macdHistory[macdHistory.length - 1]!;
  if (macdHistory.length < signalPeriod) {
    return { macd: macdLine, signal: macdLine, histogram: 0 };
  }

  const signalLine = calcEma(macdHistory, signalPeriod);
  return { macd: macdLine, signal: signalLine, histogram: macdLine - signalLine };
}

export function calcAdx(candles: Candle[], period = 14): number {
  if (candles.length < period * 2 + 1) return 20; // insufficient data → neutral

  function wilderSmooth(values: number[], p: number): number[] {
    if (values.length < p) return [values.reduce((a, b) => a + b, 0)];
    const result: number[] = [];
    let sum = values.slice(0, p).reduce((a, b) => a + b, 0);
    result.push(sum);
    for (let i = p; i < values.length; i++) {
      sum = sum - sum / p + values[i]!;
      result.push(sum);
    }
    return result;
  }

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const [, , high, low] = candles[i]!;
    const [, , prevHigh, prevLow, prevClose] = candles[i - 1]!;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const smoothTR = wilderSmooth(trs, period);
  const smoothPlus = wilderSmooth(plusDMs, period);
  const smoothMinus = wilderSmooth(minusDMs, period);

  const dxValues: number[] = [];
  for (let i = 0; i < smoothTR.length; i++) {
    if ((smoothTR[i] ?? 0) === 0) continue;
    const plusDI = (100 * (smoothPlus[i] ?? 0)) / smoothTR[i]!;
    const minusDI = (100 * (smoothMinus[i] ?? 0)) / smoothTR[i]!;
    const diSum = plusDI + minusDI;
    if (diSum === 0) continue;
    dxValues.push((100 * Math.abs(plusDI - minusDI)) / diSum);
  }

  if (dxValues.length === 0) return 20;
  const adxArr = wilderSmooth(dxValues, period);
  // wilderSmooth returns the Wilder *sum* (initial = sum of first `period` values).
  // TR/DM sums cancel when computing DI ratios, but the final DX smoothing must
  // be divided by period to recover the true average (0–100 ADX scale).
  const adxSum = adxArr[adxArr.length - 1] ?? 20 * period;
  return adxSum / period;
}

export function calcVwap(candles: Candle[]): number {
  let pv = 0;
  let vol = 0;
  for (const [, , high, low, close, volume] of candles) {
    pv += ((high + low + close) / 3) * volume;
    vol += volume;
  }
  return vol > 0 ? pv / vol : (candles[candles.length - 1]?.[4] ?? 0);
}

export function calcBollingerBands(
  closes: number[],
  period = 20,
  stdMult = 2,
): { upper: number; middle: number; lower: number; stdDev: number } {
  const slice = closes.slice(-Math.min(period, closes.length));
  if (slice.length === 0) {
    const last = closes[closes.length - 1] ?? 0;
    return { upper: last, middle: last, lower: last, stdDev: 0 };
  }
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((s, c) => s + (c - mean) ** 2, 0) / slice.length;
  const std = Math.sqrt(variance);
  return { upper: mean + stdMult * std, middle: mean, lower: mean - stdMult * std, stdDev: std };
}

// ─────────────────────────────────────────────────────────────────────────────
// Market regime detection
// ─────────────────────────────────────────────────────────────────────────────

// Hysteresis (dead-band) thresholds. A regime is ENTERED at the outer bound
// and only LEFT once the metric crosses back past a tighter inner bound, so a
// value hovering on a boundary (e.g. ADX oscillating around 20) can't flip the
// regime — and therefore which strategies are eligible — every single tick.
// Deferred-work #2: without this, regime whipsawed at 15s cadence live.
// Deferred-work #4: half-width of the neutral no-trade band around the 1h
// EMA50, as a % of the EMA50. Inside ±this, the macro filter reports neither
// bullish nor bearish (chop) so no directional entry is forced. Tunable.
const MACRO_BUFFER_PCT = 0.15;

// Deferred-work #5: period of the longer-term ATR used as the "normal"
// volatility baseline the current ATR-14 is compared against. Long enough to
// be a stable reference the current candle can't dominate; short enough to
// stay adaptive. Tunable.
const REGIME_BASELINE_ATR_PERIOD = 45;

const REGIME_HYST = {
  strongEnter: 30, strongExit: 27, // strong_trend ADX band
  weakEnter: 20, weakExit: 17,     // weak_trend ADX band
  highVolEnter: 1.8, highVolExit: 1.6, // high_volatility: current/avg ATR%
  lowVolEnter: 0.4, lowVolExit: 0.5,   // low_volatility: current/avg ATR%
} as const;

export function detectMarketRegime(
  candles1m: Candle[],
  adx: number,
  previous?: MarketRegime,
): MarketRegime {
  // Current ATR%
  const currentAtr = calcAtr(candles1m, 14);
  const currentPrice = candles1m[candles1m.length - 1]![4];
  const currentAtrPct = currentPrice > 0 ? (currentAtr / currentPrice) * 100 : 0;

  // Deferred-work #5: compare short-term volatility (ATR-14) against a
  // genuinely longer-term baseline (ATR over REGIME_BASELINE_ATR_PERIOD). The
  // previous baseline was a short, heavily-overlapping rolling window (~14
  // candles sharing 13/14 with the current reading), which (a) under-detected
  // SUSTAINED high/low volatility because the baseline rose and fell together
  // with the current reading, and (b) was an O(n²) recompute. A single longer
  // ATR is a real "normal volatility" reference — the current candle is only
  // ~1/period of it, so a spike can't inflate its own baseline.
  const baselineAtr = calcAtr(candles1m, REGIME_BASELINE_ATR_PERIOD);
  const avgAtrPct = currentPrice > 0 ? (baselineAtr / currentPrice) * 100 : currentAtrPct;
  const ratio = avgAtrPct > 0 ? currentAtrPct / avgAtrPct : 1;

  // Volatility regime takes priority over trend regime — with a dead-band so a
  // brief spike/dip near the boundary doesn't toggle it. When already in a
  // volatility regime, it persists until the ratio crosses the (looser) exit
  // bound; otherwise it's entered only past the (stricter) enter bound.
  if (avgAtrPct > 0) {
    if (previous === "high_volatility" ? ratio > REGIME_HYST.highVolExit : ratio > REGIME_HYST.highVolEnter) {
      return "high_volatility";
    }
    if (previous === "low_volatility" ? ratio < REGIME_HYST.lowVolExit : ratio < REGIME_HYST.lowVolEnter) {
      return "low_volatility";
    }
  }

  // Trend strength via ADX, sticky around the band edges. If we're already in a
  // trend regime, hold it until ADX falls past the tighter exit bound; coming
  // fresh (range / from a volatility regime) requires the stricter enter bound.
  if (previous === "strong_trend") {
    if (adx >= REGIME_HYST.strongExit) return "strong_trend";
    if (adx >= REGIME_HYST.weakExit) return "weak_trend";
    return "range";
  }
  if (previous === "weak_trend") {
    if (adx >= REGIME_HYST.strongEnter) return "strong_trend";
    if (adx >= REGIME_HYST.weakExit) return "weak_trend";
    return "range";
  }
  // Fresh evaluation (previous was range, a volatility regime, or undefined).
  if (adx >= REGIME_HYST.strongEnter) return "strong_trend";
  if (adx >= REGIME_HYST.weakEnter) return "weak_trend";
  return "range";
}

// ─────────────────────────────────────────────────────────────────────────────
// Support / Resistance pivot detection (15m swing highs/lows)
// ─────────────────────────────────────────────────────────────────────────────

function detectSupportResistance(candles: Candle[], currentPrice: number): VoteSignal {
  if (candles.length < 5) return "neutral";
  const recent = candles.slice(-Math.min(30, candles.length));

  const pivotHighs: number[] = [];
  const pivotLows: number[] = [];

  for (let i = 1; i < recent.length - 1; i++) {
    if (recent[i]![2] > recent[i - 1]![2] && recent[i]![2] > recent[i + 1]![2]) {
      pivotHighs.push(recent[i]![2]);
    }
    if (recent[i]![3] < recent[i - 1]![3] && recent[i]![3] < recent[i + 1]![3]) {
      pivotLows.push(recent[i]![3]);
    }
  }

  const threshold = currentPrice * 0.005; // 0.5% proximity
  const nearSupport = pivotLows.some((l) => Math.abs(currentPrice - l) <= threshold);
  const nearResistance = pivotHighs.some((h) => Math.abs(currentPrice - h) <= threshold);

  if (nearSupport && !nearResistance) return "bullish";
  if (nearResistance && !nearSupport) return "bearish";
  return "neutral";
}

// ─────────────────────────────────────────────────────────────────────────────
// Core signal builder — multi-timeframe weighted voting engine
// ─────────────────────────────────────────────────────────────────────────────

export function buildSignalRow(
  symbol: string,
  mtf: MultiTimeframeCandles,
  previousRegime?: MarketRegime,
): SignalRow {
  const { tf1m, tf3m, tf5m, tf15m, tf1h } = mtf;

  const lastCandle1m = tf1m[tf1m.length - 1]!;
  const lastPrice = lastCandle1m[4];

  // ── 1m: ATR, volume, candle ───────────────────────────────────────────────
  const closes1m = tf1m.map((c) => c[4]);
  const atrAbs = calcAtr(tf1m, 14);
  const atrPercent = lastPrice > 0 ? (atrAbs / lastPrice) * 100 : 0;
  const volumes = tf1m.map((c) => c[5]);
  const volWindow = volumes.slice(-20, -1);
  const avgVol = volWindow.length > 0
    ? volWindow.reduce((a, b) => a + b, 0) / volWindow.length
    : 0;
  const volumeRatio = avgVol > 0 ? volumes[volumes.length - 1]! / avgVol : 1;

  // ── 5m: EMA cross, EMA slope, RSI, ADX ───────────────────────────────────
  const closes5m = tf5m.map((c) => c[4]);
  const ema20_5m = calcEma(closes5m, 20);
  const ema50_5m = calcEma(closes5m, 50);
  const ema50Prev = closes5m.length > 5 ? calcEma(closes5m.slice(0, -3), 50) : ema50_5m;
  const rsiVal = calcRsi(closes5m, 14);
  const adxVal = calcAdx(tf5m, 14);

  // ── 1m short-term EMA slope ───────────────────────────────────────────────
  const ema10_1m = calcEma(closes1m, 10);
  const ema10Prev = closes1m.length > 5 ? calcEma(closes1m.slice(0, -3), 10) : ema10_1m;

  // ── 3m: MACD ──────────────────────────────────────────────────────────────
  const closes3m = tf3m.map((c) => c[4]);
  const { histogram: macdHist } = calcMacd(closes3m);
  const prevHist = closes3m.length > 3 ? calcMacd(closes3m.slice(0, -1)).histogram : macdHist;

  // ── 1m: VWAP ─────────────────────────────────────────────────────────────
  const vwapVal = calcVwap(tf1m);

  // ── 15m: Bollinger Bands, S/R, trend alignment ────────────────────────────
  const closes15m = tf15m.map((c) => c[4]);
  const bb15m = calcBollingerBands(closes15m, 20, 2);
  const ema20_15m = calcEma(closes15m, 20);
  const ema50_15m = calcEma(closes15m, 50);
  const srSignal = detectSupportResistance(tf15m, lastPrice);

  // ── 3m + 5m + 15m trend alignment (EMA20 > EMA50) ────────────────────────
  const ema20_3m = calcEma(closes3m, 20);
  const ema50_3m = calcEma(closes3m, 50);
  const bullishTFs = [
    ema20_3m > ema50_3m,
    ema20_5m > ema50_5m,
    ema20_15m > ema50_15m,
  ].filter(Boolean).length;

  // ── 1h macro filter ───────────────────────────────────────────────────────
  // Deferred-work #4: a neutral dead-band around the 1h EMA50. Price sitting
  // right on the EMA50 is the choppiest, least-tradeable macro state, yet a
  // strict `close > ema50` flips the whole directional gate on/off tick to
  // tick there. Requiring the close to be at least MACRO_BUFFER_PCT clear of
  // the EMA50 to count as bullish/bearish means neither is true inside the
  // band — a "no macro direction, don't force a side" zone.
  const closes1h = tf1h.map((c) => c[4]);
  const ema50_1h = calcEma(closes1h, 50);
  const macroClose = closes1h[closes1h.length - 1]!;
  const macroBand = ema50_1h * (MACRO_BUFFER_PCT / 100);
  const macroBullish = macroClose > ema50_1h + macroBand;
  const macroBearish = macroClose < ema50_1h - macroBand;

  // ── Market regime ─────────────────────────────────────────────────────────
  const regime = detectMarketRegime(tf1m, adxVal, previousRegime);

  // ─────────────────────────────────────────────────────────────────────────
  // Indicator voting
  // ─────────────────────────────────────────────────────────────────────────
  const votes: IndicatorVote[] = [];

  // 1. EMA cross — EMA20 vs EMA50 on 5m
  votes.push({
    name: "ema_cross",
    signal: ema20_5m > ema50_5m ? "bullish" : ema20_5m < ema50_5m ? "bearish" : "neutral",
    weight: INDICATOR_WEIGHTS.ema_cross!,
    value: ema50_5m > 0 ? ((ema20_5m - ema50_5m) / ema50_5m) * 100 : 0,
  });

  // 2. EMA50 slope on 5m
  votes.push({
    name: "ema50_slope",
    signal: ema50_5m > ema50Prev ? "bullish" : ema50_5m < ema50Prev ? "bearish" : "neutral",
    weight: INDICATOR_WEIGHTS.ema50_slope!,
    value: ema50Prev > 0 ? ((ema50_5m - ema50Prev) / ema50Prev) * 100 : 0,
  });

  // 3. EMA10 slope on 1m (immediate momentum)
  votes.push({
    name: "ema_slope_1m",
    signal: ema10_1m > ema10Prev ? "bullish" : ema10_1m < ema10Prev ? "bearish" : "neutral",
    weight: INDICATOR_WEIGHTS.ema_slope_1m!,
    value: ema10Prev > 0 ? ((ema10_1m - ema10Prev) / ema10Prev) * 100 : 0,
  });

  // 4. RSI on 5m
  let rsiSignal: VoteSignal;
  if (rsiVal >= 40 && rsiVal <= 65) rsiSignal = "bullish";     // optimal long-entry zone
  else if (rsiVal > 65 && rsiVal < 80) rsiSignal = "neutral";  // extended but not terminal
  else if (rsiVal >= 80) rsiSignal = "bearish";                // overbought
  else if (rsiVal < 30) rsiSignal = "bearish";                 // extreme oversold for longs
  else rsiSignal = "neutral";                                   // 30–40: mild oversold
  // Range exception: oversold bounce near support is a valid long setup
  if (regime === "range" && rsiVal >= 28 && rsiVal <= 45) rsiSignal = "bullish";
  votes.push({ name: "rsi", signal: rsiSignal, weight: INDICATOR_WEIGHTS.rsi!, value: rsiVal });

  // 5. MACD histogram on 3m
  let macdSignal: VoteSignal;
  if (macdHist > 0 && macdHist >= prevHist) macdSignal = "bullish"; // positive & rising/flat
  else if (macdHist > 0) macdSignal = "neutral";                    // positive but fading
  else if (macdHist <= 0 && macdHist < prevHist) macdSignal = "bearish"; // negative & falling
  else macdSignal = "neutral";                                        // recovering from negative
  votes.push({ name: "macd_histogram", signal: macdSignal, weight: INDICATOR_WEIGHTS.macd_histogram!, value: macdHist });

  // 6. ADX trend strength on 5m
  let adxSignal: VoteSignal;
  if (adxVal >= 30) adxSignal = "bullish";       // strong trend — ideal for trend-following
  else if (adxVal >= 20) adxSignal = "neutral";  // moderate / developing trend
  else adxSignal = "bearish";                    // no clear trend (poor for trend entries)
  // Range exception: low ADX is fine for mean-reversion
  if (regime === "range" && adxVal < 20) adxSignal = "neutral";
  votes.push({ name: "adx_strength", signal: adxSignal, weight: INDICATOR_WEIGHTS.adx_strength!, value: adxVal });

  // 7. VWAP position on 1m
  const vwapDev = vwapVal > 0 ? ((lastPrice - vwapVal) / vwapVal) * 100 : 0;
  let vwapSignal: VoteSignal;
  if (vwapDev > 0.1) vwapSignal = "bullish";       // comfortably above VWAP
  else if (vwapDev < -0.5) vwapSignal = "bearish"; // meaningfully below VWAP
  else vwapSignal = "neutral";                      // at VWAP
  votes.push({ name: "vwap_position", signal: vwapSignal, weight: INDICATOR_WEIGHTS.vwap_position!, value: vwapDev });

  // 8. Bollinger Band position on 15m (regime-aware)
  let bbSignal: VoteSignal;
  if (regime === "range") {
    // Mean reversion: buy near lower band, avoid upper band
    if (lastPrice <= bb15m.lower * 1.01) bbSignal = "bullish";
    else if (lastPrice >= bb15m.upper * 0.99) bbSignal = "bearish";
    else bbSignal = "neutral";
  } else {
    // Trend following: above middle is bullish, below lower band is breakdown
    if (lastPrice > bb15m.middle) bbSignal = "bullish";
    else if (lastPrice < bb15m.lower) bbSignal = "bearish";
    else bbSignal = "neutral";
  }
  const bbDev = bb15m.stdDev > 0 ? (lastPrice - bb15m.middle) / bb15m.stdDev : 0;
  votes.push({ name: "bollinger_position", signal: bbSignal, weight: INDICATOR_WEIGHTS.bollinger_position!, value: bbDev });

  // 9. Volume spike on 1m
  let volSignal: VoteSignal;
  if (volumeRatio >= 1.5) volSignal = "bullish";      // strong confirmation
  else if (volumeRatio >= 1.0) volSignal = "neutral"; // average activity
  else volSignal = "bearish";                         // low interest
  votes.push({ name: "volume_spike", signal: volSignal, weight: INDICATOR_WEIGHTS.volume_spike!, value: volumeRatio });

  // 10. Candle structure on 1m
  const wickPullback = hasWickPullback(lastCandle1m);
  const bullishCandle = lastCandle1m[4] > lastCandle1m[1]; // close > open
  let candleSignal: VoteSignal;
  if (bullishCandle && wickPullback) candleSignal = "bullish";       // green + rejection wick
  else if (!bullishCandle && !wickPullback) candleSignal = "bearish"; // red with no wick
  else candleSignal = "neutral";
  votes.push({ name: "candle_structure", signal: candleSignal, weight: INDICATOR_WEIGHTS.candle_structure!, value: bullishCandle ? 1 : -1 });

  // 11. Support / Resistance on 15m pivots
  votes.push({ name: "support_resistance", signal: srSignal, weight: INDICATOR_WEIGHTS.support_resistance!, value: srSignal === "bullish" ? 1 : srSignal === "bearish" ? -1 : 0 });

  // 12. Multi-timeframe trend alignment (3m + 5m + 15m all EMA20>EMA50)
  let trendAlignSignal: VoteSignal;
  if (bullishTFs === 3) trendAlignSignal = "bullish";      // full alignment — high conviction
  else if (bullishTFs === 2) trendAlignSignal = "neutral"; // mixed signal
  else trendAlignSignal = "bearish";                       // majority disagrees
  votes.push({ name: "trend_alignment", signal: trendAlignSignal, weight: INDICATOR_WEIGHTS.trend_alignment!, value: bullishTFs });

  // ─────────────────────────────────────────────────────────────────────────
  // Confidence calculation
  //   confidence = (bullish_score − 0.5 × bearish_score) / total_weight × 100
  //   Bearish indicators penalise but don't fully eliminate confidence.
  //   Macro trend dampens confidence −30 % when 1h is bearish.
  // ─────────────────────────────────────────────────────────────────────────
  const totalWeight = Object.values(INDICATOR_WEIGHTS).reduce((a, b) => a + b, 0);
  const bullishScore = votes.filter((v) => v.signal === "bullish").reduce((s, v) => s + v.weight, 0);
  const bearishScore = votes.filter((v) => v.signal === "bearish").reduce((s, v) => s + v.weight, 0);
  const rawConf = Math.max(0, ((bullishScore - bearishScore * 0.5) / totalWeight) * 100);
  const confidence = Math.round((macroBullish ? rawConf : rawConf * 0.7) * 10) / 10;
  // Futures Phase: mirror of the above, from the bearish side — same
  // dampening logic (macro trend disagreeing with the signal direction
  // knocks 30% off), so long and short signals are held to a symmetric bar.
  const rawShortConf = Math.max(0, ((bearishScore - bullishScore * 0.5) / totalWeight) * 100);
  const shortConfidence = Math.round((macroBearish ? rawShortConf : rawShortConf * 0.7) * 10) / 10;

  // Actual interval of the primary series, from its own timestamps — in a
  // coarse backtest the "tf1m" slot carries 5m/15m/… candles, and volatility
  // math that assumes per-minute ATR would overestimate reachable moves ~√k.
  const candleMinutes = tf1m.length >= 2
    ? Math.max(1, Math.round((tf1m[tf1m.length - 1]![0] - tf1m[tf1m.length - 2]![0]) / 60_000))
    : 1;

  return {
    symbol,
    confidence,
    rsi: Math.round(rsiVal * 10) / 10,
    atrPercent: Math.round(atrPercent * 100) / 100,
    ema5AboveEma20: ema20_5m > ema50_5m, // API compat field — now means EMA20>EMA50 on 5m
    macroBullish,
    macroBearish,
    shortConfidence,
    volumeRatio: Math.round(volumeRatio * 100) / 100,
    lastPrice: Math.round(lastPrice * 10000) / 10000,
    regime,
    adx: Math.round(adxVal * 10) / 10,
    macdHistogram: Math.round(macdHist * 1e8) / 1e8,
    atrAbs,
    candleMinutes,
    votes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence unification  (deferred-work #1)
//
// Each strategy computes its OWN setup-quality confidence (how good ITS
// specific pattern looks — breakout strength, RSI extremity, band distance,
// …). buildSignalRow() separately computes a 12-indicator, weighted,
// regime-aware market-STRUCTURE confidence (row.confidence for longs,
// row.shortConfidence for shorts). Before this, the structure score only
// drove the scanner UI — it never touched the actual trade decision.
//
// unifyConfidence() blends them into the single number the selector then
// gates and ranks on, so a setup must be BOTH intrinsically good AND
// supported by broad market structure in its own direction. The strategy
// term stays dominant (it knows its own edge); structure is a meaningful
// secondary that can veto a setup fighting the overall tape. Weights are a
// named constant so they can be tuned against the backtest harness.
// ─────────────────────────────────────────────────────────────────────────────
export const CONFIDENCE_BLEND = { strategy: 0.7, structure: 0.3 } as const;

export function unifyConfidence(
  strategyConfidence: number,
  side: "long" | "short",
  row: SignalRow,
): number {
  const structure = side === "short" ? row.shortConfidence : row.confidence;
  const blended = CONFIDENCE_BLEND.strategy * strategyConfidence + CONFIDENCE_BLEND.structure * structure;
  return Math.round(blended * 10) / 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry evaluation — checks all conditions and returns trade parameters or null
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Legacy helper kept for backward-compatibility with old backtest in BotEngine
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use buildSignalRow(symbol, mtf) with MultiTimeframeCandles instead */
export function buildSignalRowLegacy(
  symbol: string,
  candles: Candle[],
  macroCandles: Candle[],
): Pick<SignalRow, "symbol" | "confidence" | "rsi" | "atrPercent" | "ema5AboveEma20" | "macroBullish" | "volumeRatio" | "lastPrice"> {
  const closes = candles.map((c) => c[4]);
  const macroCloses = macroCandles.map((c) => c[4]);
  const lastCandle = candles[candles.length - 1]!;
  const lastPrice = lastCandle[4];

  const ema5 = calcEma(closes, 5);
  const ema20 = calcEma(closes, 20);
  const ema5AboveEma20 = ema5 > ema20;
  const atrAbs = calcAtr(candles, 14);
  const atrPercent = lastPrice > 0 ? (atrAbs / lastPrice) * 100 : 0;
  const rsiVal = calcRsi(closes, 14);
  const volWindow = closes.slice(-20, -1);
  const avgVol = volWindow.length > 0 ? candles.slice(-20, -1).map((c) => c[5]).reduce((a, b) => a + b, 0) / volWindow.length : 0;
  const volumeRatio = avgVol > 0 ? candles[candles.length - 1]![5] / avgVol : 1;
  const ema50macro = calcEma(macroCloses, 50);
  const macroBullish = macroCloses[macroCloses.length - 1]! > ema50macro;

  let confidence = 0;
  if (ema5AboveEma20) confidence += 25;
  if (volumeRatio > 1) confidence += 20;
  if (hasWickPullback(lastCandle)) confidence += 20;
  if (macroBullish) confidence += 25;
  if (rsiVal < 70 && rsiVal > 40) confidence += 10;

  return {
    symbol,
    confidence: Math.round(confidence * 10) / 10,
    rsi: Math.round(rsiVal * 10) / 10,
    atrPercent: Math.round(atrPercent * 100) / 100,
    ema5AboveEma20,
    macroBullish,
    volumeRatio: Math.round(volumeRatio * 100) / 100,
    lastPrice: Math.round(lastPrice * 10000) / 10000,
  };
}
