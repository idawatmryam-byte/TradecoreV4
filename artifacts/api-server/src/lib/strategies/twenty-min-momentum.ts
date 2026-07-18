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
  type TradeDecision, type DecisionContext, type DecisionReport,
  computeQty, computeAdaptiveSLTP,
} from "./base";
import { type MultiTimeframeCandles, type SignalRow, calcEma, calcVwap } from "../strategy";
import { marketFacts, solveLeverage, timeFeasible, feeViability, suggestLeverageForTarget } from "./toolkit";

export class TwentyMinMomentumStrategy implements Strategy {
  readonly strategyId = "twenty_min_momentum";
  readonly strategyName = "20 Minutes Trading Strategy";
  // Momentum needs movement to ride — active regimes only. Range / low-vol have
  // no directional push to reach a target in 20 minutes.
  readonly supportedRegimes = ["strong_trend", "weak_trend", "high_volatility"] as const;
  readonly indicators = [
    "EMA20 / EMA50 trend (3m)",
    "MACD histogram (3m)",
    "Session VWAP — fair-value side (1m)",
    "RSI(14) 50–72 / 28–50 (5m)",
    "ADX(14) ≥ 20 + volume ≥ 1× (5m/1m)",
    "ATR reachability (1m + 5m)",
    "Swing S/R room check (15m)",
  ] as const;

  /**
   * Professional decision-maker ("the brain") — owns the COMPLETE decision.
   *
   * The 5-lens confluence still decides DIRECTION, but everything else is
   * reasoned per trade: the stop is anchored to the structural invalidation
   * (VWAP — the thesis is "price on the right side of fair value with
   * momentum"; back through VWAP = thesis dead), leverage is SOLVED from the
   * dollar risk plan (highest leverage whose stop clears every safety floor,
   * never above the user's cap), the target's reachability inside the hold
   * window is verified at this coin's volatility, and room to the next
   * swing level is checked so the target isn't parked behind a wall. Every
   * gate — pass or fail — is written into the DecisionReport.
   */
  decide(
    symbol: string,
    mtf: MultiTimeframeCandles,
    row: SignalRow,
    config: StrategyConfig,
    ctx: DecisionContext,
  ): TradeDecision | null {
    const { tf1m, tf3m } = mtf;
    if (tf3m.length < 50 || tf1m.length < 20) return null;
    const lastPrice = row.lastPrice;

    // ── Read the market once ────────────────────────────────────────────────
    const closes3m = tf3m.map((c) => c[4]);
    const ema20 = calcEma(closes3m, 20);
    const ema50 = calcEma(closes3m, 50);
    const vwap = calcVwap(tf1m);
    const macdHist = row.macdHistogram;
    const rsi = row.rsi;
    const adx = row.adx;
    const vol = row.volumeRatio;

    // Conviction gate: a 20-minute trade needs a REAL, participated move.
    if (!(adx >= 20 && vol >= 1.0)) return null;

    // ── Direction: 5-lens confluence (all must agree) ───────────────────────
    const longAligned = ema20 > ema50 && macdHist > 0 && lastPrice > vwap && rsi >= 50 && rsi <= 72;
    const shortAligned = ema20 < ema50 && macdHist < 0 && lastPrice < vwap && rsi <= 50 && rsi >= 28;
    if (!longAligned && !shortAligned) return null; // no clean agreement — sit out
    const side: PositionSide = longAligned ? "long" : "short";
    const isShort = side === "short";

    const rejection = (stage: "dollar-plan" | "coin-fit" | "leverage" | "reward-risk", reason: string, report?: DecisionReport): TradeDecision => ({
      kind: "rejection",
      rejection: {
        strategyId: this.strategyId, strategyName: this.strategyName,
        symbol, side, stage, reason, report,
      },
    });

    // ── The user's only inputs: the dollar risk profile ─────────────────────
    const dp = ctx.dollarPlan;
    if (!dp || !(dp.maxLossUsdt > 0) || !(dp.targetProfitUsdt > 0)) {
      return rejection(
        "dollar-plan",
        "no dollar risk plan configured — set Trade Amount, Max Loss and Target Profit for this strategy on the Strategies page",
      );
    }

    const facts = marketFacts(mtf, row);
    const vwapDistPct = vwap > 0 ? (Math.abs(lastPrice - vwap) / vwap) * 100 : 0;

    // ── Risk: solve leverage backward from the safety floors ────────────────
    // Structural invalidation = VWAP (the thesis line), but only when it's
    // close enough to serve as a stop anchor — a far-away VWAP would force an
    // oversized stop the dollar budget can't honor; there the dollar/noise
    // floors govern instead.
    const invalidationPrice = vwapDistPct > 0.05 && vwapDistPct <= 1.5 ? vwap : undefined;
    const solved = solveLeverage({
      entryPrice: lastPrice, side, marketType: ctx.marketType,
      marginUsdt: dp.tradeAmountUsdt, maxLossUsdt: dp.maxLossUsdt, targetProfitUsdt: dp.targetProfitUsdt,
      leverageCap: ctx.leverageCap, feeRate: ctx.feeRate,
      atrPercent: row.atrPercent, invalidationPrice,
    });
    if (!solved.feasible) {
      return rejection("leverage", solved.reason ?? "no safe leverage for this dollar plan");
    }

    // ── Time: can this target realistically resolve inside the window? ──────
    // Judged on BOTH the 1m and 5m frames — a trending coin shows more usable
    // range on the coarser frame, so 1m noise alone under-calls real trends.
    const maxHold = config.maxHoldingSeconds;
    const tf = timeFeasible(solved.tpFraction, row, maxHold, mtf);
    if (!tf.feasible) {
      // Professional follow-up: would MORE leverage make the target
      // reachable (bigger notional → smaller % move needed) while the stop
      // still clears every floor? If yes but it's above the user's cap, say
      // so — an actionable rejection instead of a dead end.
      const better = suggestLeverageForTarget({
        entryPrice: lastPrice, side, marketType: ctx.marketType,
        marginUsdt: dp.tradeAmountUsdt, maxLossUsdt: dp.maxLossUsdt, targetProfitUsdt: dp.targetProfitUsdt,
        feeRate: ctx.feeRate, atrPercent: row.atrPercent, invalidationPrice,
      }, tf.reachablePct);
      const hint = better != null && better > ctx.leverageCap
        ? ` — WOULD be feasible at ~${better}× leverage (your cap is ${ctx.leverageCap}×): raise the Max Leverage Cap, lower Target Profit, or raise Trade Amount`
        : ` — no leverage makes this target reachable safely here: lower Target Profit or raise Trade Amount`;
      return rejection("coin-fit", (tf.reason ?? "target unreachable within the hold window") + hint);
    }
    // Honest expected duration from the volatility math (never below 5min,
    // never past the deadline).
    const expectedHold = Math.min(maxHold, Math.max(300, tf.expectedSeconds));

    // ── Room: is the target parked behind the nearest swing level? ──────────
    const targetPct = solved.tpFraction * 100;
    const wall = isShort ? facts.supportDistancePct : facts.resistanceDistancePct;
    if (wall != null && wall < targetPct * 0.6) {
      return rejection(
        "coin-fit",
        `nearest ${isShort ? "support" : "resistance"} is ${wall.toFixed(2)}% away — target ${targetPct.toFixed(2)}% has no room to play out`,
      );
    }

    // ── Costs: reward must justify risk after fees ──────────────────────────
    const fee = feeViability(lastPrice, solved.slPrice, solved.tpPrice, side);
    if (!fee.viable) {
      return rejection("reward-risk", fee.reason ?? "reward does not clear costs");
    }

    // ── Confidence: how strongly the five lenses agree ──────────────────────
    const rsiRoom = isShort ? rsi - 28 : 72 - rsi;
    let confidence = 55;
    confidence += Math.min(15, (adx - 20) * 0.6);
    confidence += Math.min(10, vwapDistPct * 20);
    confidence += Math.min(8, Math.max(0, rsiRoom) * 0.4);
    confidence += Math.min(7, (vol - 1) * 7);
    confidence = Math.min(100, Math.round(confidence * 10) / 10);
    if (confidence < config.confidenceThreshold) return null;

    // ── The written plan ────────────────────────────────────────────────────
    const dirWord = isShort ? "down" : "up";
    const report: DecisionReport = {
      summary:
        `All five lenses agree ${dirWord} (EMA trend, MACD momentum, ${isShort ? "below" : "above"} VWAP, RSI ${rsi.toFixed(0)} with room, ` +
        `ADX ${adx.toFixed(0)} on ${vol.toFixed(1)}× volume). Risking $${dp.maxLossUsdt} to make $${dp.targetProfitUsdt} at ${solved.leverage}× ` +
        `with the stop ${invalidationPrice ? "at the VWAP invalidation line" : "outside the noise band"}; ` +
        `expecting resolution in ~${Math.round(expectedHold / 60)}min.`,
      marketView: [
        `regime ${row.regime} · ADX ${adx.toFixed(1)} · ${vol.toFixed(2)}× volume`,
        `price ${isShort ? "below" : "above"} session VWAP by ${vwapDistPct.toFixed(2)}%`,
        `volatility at the ${facts.volatilityPercentile}th percentile of its recent range`,
        facts.resistance != null ? `nearest resistance +${facts.resistanceDistancePct!.toFixed(2)}%` : "no overhead resistance in the recent window",
        facts.support != null ? `nearest support −${facts.supportDistancePct!.toFixed(2)}%` : "no support level in the recent window",
      ],
      entryLogic: [
        `trend: EMA20 ${isShort ? "<" : ">"} EMA50 on 3m`,
        `momentum: MACD histogram ${isShort ? "<" : ">"} 0`,
        `fair value: price ${isShort ? "below" : "above"} VWAP (${dirWord}-side control)`,
        `strength: RSI ${rsi.toFixed(0)} — directional with ${Math.max(0, rsiRoom).toFixed(0)} points before exhaustion`,
        `conviction: ADX ${adx.toFixed(0)} ≥ 20 with ${vol.toFixed(1)}× participation`,
      ],
      riskLogic: [
        `dollar plan: $${dp.tradeAmountUsdt} ${ctx.marketType === "futures" ? "margin" : "notional"}, max loss $${dp.maxLossUsdt}`,
        `leverage SOLVED at ${solved.leverage}× (cap ${ctx.leverageCap}×) — highest that keeps the stop outside every floor (binding: ${solved.bindingFloor})`,
        `stop ${solved.stopDistPct.toFixed(2)}% away at ${solved.slPrice.toPrecision(6)}${invalidationPrice ? " — the VWAP thesis-invalidation line" : ""}`,
      ],
      exitLogic: [
        `target ${targetPct.toFixed(2)}% at ${solved.tpPrice.toPrecision(6)} (+$${dp.targetProfitUsdt} net)`,
        `expected resolution ~${Math.round(expectedHold / 60)}min at current volatility; hard deadline ${Math.round(maxHold / 60)}min`,
      ],
      checks: [
        { name: "Confluence", passed: true, detail: "5/5 lenses aligned" },
        { name: "Leverage solver", passed: true, detail: `${solved.leverage}× ≤ cap ${ctx.leverageCap}× · stop clears ${solved.bindingFloor}` },
        { name: "Time feasibility", passed: true, detail: `~${Math.round(tf.expectedSeconds / 60)}min needed vs ${Math.round(maxHold / 60)}min window` },
        { name: "Room to target", passed: true, detail: wall != null ? `${wall.toFixed(2)}% to the nearest level vs ${targetPct.toFixed(2)}% target` : "no blocking level" },
        { name: "Fee viability", passed: true, detail: `net R:R ${fee.netRR.toFixed(2)} ≥ ${fee.floor}` },
      ],
      data: {
        adx, rsi, volumeRatio: vol, vwapDistPct, volatilityPercentile: facts.volatilityPercentile,
        solvedLeverage: solved.leverage, bindingFloor: solved.bindingFloor,
        expectedHoldSeconds: expectedHold, reachablePct: tf.reachablePct, targetPct,
      },
    };

    return {
      kind: "plan",
      plan: {
        strategyId: this.strategyId,
        strategyName: this.strategyName,
        symbol,
        side,
        confidence,
        entryPrice: lastPrice,
        slPrice: solved.slPrice,
        tpPrice: solved.tpPrice,
        qty: solved.qty,
        leverage: solved.leverage,
        expectedHoldSeconds: expectedHold,
        maxHoldSeconds: maxHold,
        regime: row.regime,
        report,
      },
    };
  }

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
