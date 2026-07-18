/**
 * Momentum Breakout Strategy
 *
 * Long entry when:
 * - Price breaks the recent N-bar high (last 20 × 15m bars)
 * - Volume > 1.5× average
 * - ADX >= 20 (trend confirmation)
 * - 1h macro bullish
 *
 * Short entry (Futures Phase — mirror of the above, futures only):
 * - Price breaks the recent N-bar LOW
 * - Volume > 1.5× average
 * - ADX >= 20
 * - 1h macro bearish
 *
 * Percentage-based stop and take-profit (Phase 5A).
 *
 * REGIME GATE (evidence-based, post-parity-diagnosis): this strategy is now
 * restricted to `strong_trend` ONLY (previously it also fired in `weak_trend`).
 * A breakout's edge is trend continuation; in a weak/ambiguous trend the same
 * "break of the 20-bar high" is overwhelmingly a FALSE breakout that reverses
 * (a bull/bear trap), which is exactly why the earlier all-regime version ran a
 * ~22% win rate and bled (backtest 35: 65 trades, −$238). Requiring a genuine
 * strong trend (regime = strong_trend already implies ADX past the strong-enter
 * band) keeps only breakouts with real momentum behind them. This is a
 * TIGHTENING — fewer, higher-quality trades — measured against the −23% broad
 * baseline; it is not a frequency knob.
 */
import {
  type Strategy, type StrategySignal, type StrategyConfig, type PositionSide,
  type TradeDecision, type DecisionContext, type DecisionReport,
  computeQty, computeAdaptiveSLTP,
} from "./base";
import { type MultiTimeframeCandles, type SignalRow } from "../strategy";
import { marketFacts, solveLeverage, timeFeasible, feeViability, suggestLeverageForTarget } from "./toolkit";

export class MomentumBreakoutStrategy implements Strategy {
  readonly strategyId = "momentum_breakout";
  readonly strategyName = "Momentum Breakout";
  readonly supportedRegimes = ["strong_trend"] as const;
  readonly indicators = [
    "20-bar high/low break (15m)",
    "Volume ≥ 1.5× 20-period average (1m)",
    "ADX(14) ≥ 20 (5m)",
    "EMA50 macro trend (1h)",
    "Swing S/R room check (15m)",
  ] as const;

  /**
   * Professional decision-maker ("the brain").
   *
   * The defining upgrade over the legacy % model: the stop goes AT the broken
   * level. A breakout trade's thesis is "the level gave way" — price trading
   * back through that level means the breakout failed, so that's where the
   * trade is wrong, not some arbitrary percentage. The leverage solver then
   * works backward from that structural stop (and the noise/exchange floors)
   * to the highest safe leverage under the user's cap. It also refuses to
   * CHASE: a breakout already extended more than ~1.5 ATR beyond the level
   * has spent its edge — late entries buy the pullback risk without the
   * level-break reward.
   */
  decide(
    symbol: string,
    mtf: MultiTimeframeCandles,
    row: SignalRow,
    config: StrategyConfig,
    ctx: DecisionContext,
  ): TradeDecision | null {
    const { tf15m } = mtf;
    const lastPrice = row.lastPrice;

    // Participation + trend gates — no volume, no trade; no trend, no trade.
    if (row.volumeRatio < 1.5) return null;
    if (row.adx < 20) return null;

    const lookback = tf15m.slice(-21, -1);
    if (lookback.length < 10) return null;

    const side: PositionSide | null = row.macroBullish ? "long" : row.macroBearish ? "short" : null;
    if (!side) return null;
    const isShort = side === "short";

    // The level that must have broken — and that defines where we're wrong.
    const level = isShort
      ? Math.min(...lookback.map((c) => c[3]))
      : Math.max(...lookback.map((c) => c[2]));
    const broke = isShort ? lastPrice < level : lastPrice > level;
    if (!broke) return null;

    const rejection = (stage: "setup" | "dollar-plan" | "coin-fit" | "leverage" | "reward-risk", reason: string, report?: DecisionReport): TradeDecision => ({
      kind: "rejection",
      rejection: {
        strategyId: this.strategyId, strategyName: this.strategyName,
        symbol, side, stage, reason, report,
      },
    });

    // ── Am I late? Refuse to chase an extended breakout ─────────────────────
    const extensionPct = level > 0 ? (Math.abs(lastPrice - level) / level) * 100 : 0;
    const maxChasePct = Math.max(0.15, row.atrPercent * 1.5);
    if (extensionPct > maxChasePct) {
      return rejection(
        "setup",
        `breakout already extended ${extensionPct.toFixed(2)}% past the ${level.toPrecision(6)} level (limit ~${maxChasePct.toFixed(2)}%) — chasing a spent move`,
      );
    }

    // ── The user's only inputs: the dollar risk profile ─────────────────────
    const dp = ctx.dollarPlan;
    if (!dp || !(dp.maxLossUsdt > 0) || !(dp.targetProfitUsdt > 0)) {
      return rejection(
        "dollar-plan",
        "no dollar risk plan configured — set Trade Amount, Max Loss and Target Profit for this strategy on the Strategies page",
      );
    }

    // ── Risk: structural stop at the broken level, leverage solved from it ──
    const solved = solveLeverage({
      entryPrice: lastPrice, side, marketType: ctx.marketType,
      marginUsdt: dp.tradeAmountUsdt, maxLossUsdt: dp.maxLossUsdt, targetProfitUsdt: dp.targetProfitUsdt,
      leverageCap: ctx.leverageCap, feeRate: ctx.feeRate,
      atrPercent: row.atrPercent,
      invalidationPrice: level,
    });
    if (!solved.feasible) {
      return rejection("leverage", solved.reason ?? "no safe leverage places a stop at the broken level");
    }

    // ── Time + room + costs ─────────────────────────────────────────────────
    // Reachability judged on BOTH the 1m and 5m frames (see toolkit).
    const maxHold = config.maxHoldingSeconds;
    const tf = timeFeasible(solved.tpFraction, row, maxHold, mtf);
    if (!tf.feasible) {
      // Would more leverage make the target reachable while the stop still
      // holds at the broken level? Tell the user instead of dead-ending.
      const better = suggestLeverageForTarget({
        entryPrice: lastPrice, side, marketType: ctx.marketType,
        marginUsdt: dp.tradeAmountUsdt, maxLossUsdt: dp.maxLossUsdt, targetProfitUsdt: dp.targetProfitUsdt,
        feeRate: ctx.feeRate, atrPercent: row.atrPercent, invalidationPrice: level,
      }, tf.reachablePct);
      const hint = better != null && better > ctx.leverageCap
        ? ` — WOULD be feasible at ~${better}× leverage (your cap is ${ctx.leverageCap}×): raise the Max Leverage Cap, lower Target Profit, or raise Trade Amount`
        : ` — no leverage makes this target reachable safely here: lower Target Profit or raise Trade Amount`;
      return rejection("coin-fit", (tf.reason ?? "target unreachable within the hold window") + hint);
    }
    const expectedHold = Math.min(maxHold, Math.max(300, tf.expectedSeconds));

    const facts = marketFacts(mtf, row);
    const targetPct = solved.tpFraction * 100;
    const wall = isShort ? facts.supportDistancePct : facts.resistanceDistancePct;
    if (wall != null && wall < targetPct * 0.6) {
      return rejection(
        "coin-fit",
        `nearest ${isShort ? "support" : "resistance"} is ${wall.toFixed(2)}% away — target ${targetPct.toFixed(2)}% is parked behind it`,
      );
    }

    const fee = feeViability(lastPrice, solved.slPrice, solved.tpPrice, side);
    if (!fee.viable) {
      return rejection("reward-risk", fee.reason ?? "reward does not clear costs");
    }

    // ── Confidence ──────────────────────────────────────────────────────────
    const adxBonus = Math.min(25, (row.adx - 20) * 1.5);
    const volBonus = Math.min(10, (row.volumeRatio - 1.5) * 5);
    const macroBonus = 5;
    const confidence = Math.min(100, Math.round((55 + adxBonus + volBonus + macroBonus) * 10) / 10);
    if (confidence < config.confidenceThreshold) return null;

    // ── The written plan ────────────────────────────────────────────────────
    const breakWord = isShort ? "breakdown below" : "breakout above";
    const report: DecisionReport = {
      summary:
        `Fresh ${breakWord} the 20-bar level ${level.toPrecision(6)} on ${row.volumeRatio.toFixed(1)}× volume with ADX ${row.adx.toFixed(0)} ` +
        `and the 1h macro trend agreeing. Stop sits AT the broken level (the trade is wrong if price trades back through it), ` +
        `risking $${dp.maxLossUsdt} to make $${dp.targetProfitUsdt} at ${solved.leverage}×; expecting ~${Math.round(expectedHold / 60)}min.`,
      marketView: [
        `regime ${row.regime} · ADX ${row.adx.toFixed(1)} · ${row.volumeRatio.toFixed(2)}× volume`,
        `1h macro ${isShort ? "bearish" : "bullish"} — trading with the larger trend`,
        `price ${extensionPct.toFixed(2)}% past the level — a FRESH break, not a chase`,
        facts.resistance != null ? `nearest resistance +${facts.resistanceDistancePct!.toFixed(2)}%` : "no overhead resistance in the recent window",
        facts.support != null ? `nearest support −${facts.supportDistancePct!.toFixed(2)}%` : "no support level in the recent window",
      ],
      entryLogic: [
        `20-bar (15m) ${isShort ? "low" : "high"} at ${level.toPrecision(6)} gave way`,
        `${row.volumeRatio.toFixed(1)}× average volume — the break is participated, not a stray tick`,
        `ADX ${row.adx.toFixed(0)} confirms an active trend behind the break`,
      ],
      riskLogic: [
        `dollar plan: $${dp.tradeAmountUsdt} ${ctx.marketType === "futures" ? "margin" : "notional"}, max loss $${dp.maxLossUsdt}`,
        `leverage SOLVED at ${solved.leverage}× (cap ${ctx.leverageCap}×) — highest whose stop clears every floor (binding: ${solved.bindingFloor})`,
        `stop ${solved.stopDistPct.toFixed(2)}% away at ${solved.slPrice.toPrecision(6)} — the broken level itself: back through it = breakout failed`,
      ],
      exitLogic: [
        `target ${targetPct.toFixed(2)}% at ${solved.tpPrice.toPrecision(6)} (+$${dp.targetProfitUsdt} net)`,
        `expected resolution ~${Math.round(expectedHold / 60)}min; hard deadline ${Math.round(maxHold / 60)}min`,
      ],
      checks: [
        { name: "Fresh break", passed: true, detail: `${extensionPct.toFixed(2)}% past the level (chase limit ${maxChasePct.toFixed(2)}%)` },
        { name: "Leverage solver", passed: true, detail: `${solved.leverage}× ≤ cap ${ctx.leverageCap}× · stop at the ${solved.bindingFloor}` },
        { name: "Time feasibility", passed: true, detail: `~${Math.round(tf.expectedSeconds / 60)}min needed vs ${Math.round(maxHold / 60)}min window` },
        { name: "Room to target", passed: true, detail: wall != null ? `${wall.toFixed(2)}% to the nearest level vs ${targetPct.toFixed(2)}% target` : "no blocking level" },
        { name: "Fee viability", passed: true, detail: `net R:R ${fee.netRR.toFixed(2)} ≥ ${fee.floor}` },
      ],
      data: {
        level, extensionPct, adx: row.adx, volumeRatio: row.volumeRatio,
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

    const { tf15m } = mtf;
    const lastPrice = row.lastPrice;

    // ── Volume + ADX confirmation (shared by both directions) ────────────────
    if (row.volumeRatio < 1.5) return null;
    if (row.adx < 20) return null;

    const lookback = tf15m.slice(-21, -1);
    if (lookback.length < 10) return null;

    const side: PositionSide | null = row.macroBullish ? "long" : row.macroBearish ? "short" : null;
    if (!side) return null;

    let entryReason: string;
    if (side === "long") {
      const recentHigh = Math.max(...lookback.map((c) => c[2]));
      if (lastPrice <= recentHigh) return null;
      entryReason = `Breakout above ${recentHigh.toFixed(4)} · Vol×${row.volumeRatio.toFixed(2)} · ADX ${row.adx.toFixed(1)}`;
    } else {
      const recentLow = Math.min(...lookback.map((c) => c[3]));
      if (lastPrice >= recentLow) return null;
      entryReason = `Breakdown below ${recentLow.toFixed(4)} · Vol×${row.volumeRatio.toFixed(2)} · ADX ${row.adx.toFixed(1)}`;
    }

    // ── Confidence (same formula either direction) ────────────────────────────
    const adxBonus = Math.min(25, (row.adx - 20) * 1.5);
    const volBonus = Math.min(10, (row.volumeRatio - 1.5) * 5);
    const macroBonus = 5; // side was only chosen when the macro filter agreed
    const confidence = Math.min(100, 55 + adxBonus + volBonus + macroBonus);

    if (confidence < config.confidenceThreshold) return null;

    // Phase 5A: SL/TP is a fixed % from entry, not ATR-derived.
    const { slPrice, tpPrice } = computeAdaptiveSLTP(lastPrice, config, side, row.atrPercent, config.maxHoldingSeconds, row.candleMinutes);

    const qty = computeQty(balance, config.riskPercent, lastPrice, slPrice, positionSizeUsdt, 10, side);
    if (qty <= 0) return null;

    return {
      strategyId: this.strategyId,
      strategyName: this.strategyName,
      symbol,
      side,
      confidence: Math.round(confidence * 10) / 10,
      entryReason,
      regime: row.regime,
      entryPrice: lastPrice,
      suggestedSL: slPrice,
      suggestedTP: tpPrice,
      suggestedHoldingTime: config.maxHoldingSeconds,
      qty,
    };
  }
}
