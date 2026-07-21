/**
 * Custom Strategy interpreter — one generic class that turns a user's
 * validated rule document (lib/customRules.ts) into a full Strategy.
 *
 * SECURITY MODEL: rules are data, never code. Every value a condition can
 * read is either already computed once per scan (SignalRow) or derived here
 * in O(lookback ≤ 50) from the candle windows. Evaluation is bounded (≤ 8
 * conditions per side), cannot loop, cannot touch anything outside the
 * arguments it is handed.
 *
 * PARITY MODEL: decide() deliberately mirrors the built-in pro-brain shape
 * (momentum-breakout.ts is the template): structural/chosen stop →
 * solveLeverage from the user's dollar plan → time feasibility → room to
 * target → cost-aware fee viability → TradePlan with a written report.
 * Because sizing and every gate run through the same toolkit + the
 * selector's central net reward:risk floor, a custom strategy can never
 * bypass a risk control — the worst a bad rule set can do is lose its
 * configured Max Loss on a trade, exactly like a built-in.
 */
import {
  type Strategy, type StrategySignal, type StrategyConfig, type PositionSide,
  type TradeDecision, type DecisionContext, type DecisionReport,
} from "./base";
import { type MultiTimeframeCandles, type SignalRow, type MarketRegime } from "../strategy";
import {
  marketFacts, solveLeverage, timeFeasible, feeViability,
  adaptiveDeadline, INTRADAY_MAX_HOLD_SECONDS,
} from "./toolkit";
import {
  type CustomRules, type CustomCondition,
  NUMERIC_INDICATORS, ENUM_INDICATORS, describeCondition, describeRules,
} from "../customRules";

const ALL_REGIMES: readonly MarketRegime[] = [
  "strong_trend", "weak_trend", "range", "high_volatility", "low_volatility",
];

/**
 * Fresh-install config for a CUSTOM strategy whose strategy_configs row is
 * missing (normally the create route seeds one — this is the safety net).
 * Deliberately conservative: disabled, and NO dollar plan — without a plan
 * the interpreter rejects every setup with a visible "set a trade plan"
 * reason instead of trading with numbers the user never chose.
 */
export const DEFAULT_CUSTOM_STRATEGY_CONFIG: Omit<StrategyConfig, "strategyId"> = {
  enabled: false,
  tradeAmountUsdt: null, maxLossUsdt: null, targetProfitUsdt: null,
  riskPercent: 1.0,
  confidenceThreshold: 60,
  stopLossPercent: 1.5,
  takeProfitPercent: 3.0,
  maxHoldingSeconds: 3600,
  maxConcurrentPositions: 1,
  cooldownMinutes: 30,
  breakEvenRMultiple: 0.7,
  tp1RMultiple: 1.0, tp1ClosePercent: 50,
  tp3Enabled: false, tp2RMultiple: 2.0, tp2ClosePercent: 25, tp3RMultiple: 4.0,
  trailingStopMode: "atr", trailingStopAtrMultiplier: 1.5, trailingStopPercent: 1.0,
  trailingAfterTp1Only: true,
  emergencyTrailingRMultiple: 3.0, emergencyTrailingPercent: 0.5,
  exitPriority: ["stop_loss", "take_profit", "trailing_stop", "timeout"],
};

/** Resolve one indicator's current value. Numeric ids → number; enum/bool ids
 *  → string ("true"/"false" or the regime name) for eq comparison. */
export function indicatorValue(
  id: CustomCondition["indicator"],
  row: SignalRow,
  mtf: MultiTimeframeCandles,
): number | string {
  switch (id) {
    case "rsi": return row.rsi;
    case "adx": return row.adx;
    case "atrPercent": return row.atrPercent;
    case "macdHistogram": return row.macdHistogram;
    case "volumeRatio": return row.volumeRatio;
    case "confidence": return row.confidence;
    case "shortConfidence": return row.shortConfidence;
    case "lastPrice": return row.lastPrice;
    case "hourUtc": {
      // From the newest candle's timestamp, NOT the wall clock — so the same
      // rule evaluates identically live and in a backtest replay.
      const last = mtf.tf1m[mtf.tf1m.length - 1];
      return last ? new Date(last[0]).getUTCHours() : new Date().getUTCHours();
    }
    case "pctFromHigh20": {
      const bars = mtf.tf15m.slice(-20);
      if (bars.length === 0) return 0;
      const high = Math.max(...bars.map((c) => c[2]));
      return high > 0 ? Math.max(0, ((high - row.lastPrice) / high) * 100) : 0;
    }
    case "pctFromLow20": {
      const bars = mtf.tf15m.slice(-20);
      if (bars.length === 0) return 0;
      const low = Math.min(...bars.map((c) => c[3]));
      return low > 0 ? Math.max(0, ((row.lastPrice - low) / low) * 100) : 0;
    }
    case "regime": return row.regime;
    case "macroBullish": return String(row.macroBullish);
    case "macroBearish": return String(row.macroBearish);
    case "ema20AboveEma50": return String(row.ema5AboveEma20); // field predates the rename — it IS EMA20>EMA50 (5m)
  }
}

/** Evaluate one condition; returns the outcome plus the observed value for reporting. */
export function evalCondition(
  c: CustomCondition,
  row: SignalRow,
  mtf: MultiTimeframeCandles,
): { pass: boolean; observed: number | string } {
  const observed = indicatorValue(c.indicator, row, mtf);
  if (typeof observed === "number" && typeof c.value === "number") {
    const pass =
      c.op === "gt" ? observed > c.value :
      c.op === "gte" ? observed >= c.value :
      c.op === "lt" ? observed < c.value :
      c.op === "lte" ? observed <= c.value :
      false;
    return { pass, observed: Math.round(observed * 10000) / 10000 };
  }
  return { pass: c.op === "eq" && String(observed) === String(c.value), observed };
}

export class CustomStrategy implements Strategy {
  readonly strategyId: string;
  readonly strategyName: string;
  /** All regimes — the user's own regime condition (if any) does the gating. */
  readonly supportedRegimes = ALL_REGIMES;
  readonly indicators: ReadonlyArray<string>;

  constructor(
    strategyId: string,
    strategyName: string,
    private readonly rules: CustomRules,
  ) {
    this.strategyId = strategyId;
    this.strategyName = strategyName;
    this.indicators = describeRules(rules);
  }

  decide(
    symbol: string,
    mtf: MultiTimeframeCandles,
    row: SignalRow,
    config: StrategyConfig,
    ctx: DecisionContext,
  ): TradeDecision | null {
    const longEval = this.rules.long?.map((c) => ({ c, ...evalCondition(c, row, mtf) }));
    const shortEval = this.rules.short?.map((c) => ({ c, ...evalCondition(c, row, mtf) }));
    const longPass = longEval != null && longEval.every((e) => e.pass);
    const shortPass = shortEval != null && shortEval.every((e) => e.pass);

    // Both sides firing at once means the rule set is self-contradictory for
    // this bar — no trade (silently, like a built-in with no setup).
    if (longPass === shortPass) return null;
    const side: PositionSide = longPass ? "long" : "short";
    const isShort = side === "short";
    const passedEval = (longPass ? longEval : shortEval)!;
    const lastPrice = row.lastPrice;

    const rejection = (stage: "setup" | "dollar-plan" | "coin-fit" | "leverage" | "reward-risk", reason: string): TradeDecision => ({
      kind: "rejection",
      rejection: { strategyId: this.strategyId, strategyName: this.strategyName, symbol, side, stage, reason },
    });

    // ── Stop placement per the rule document ────────────────────────────────
    let stopPrice: number;
    const stop = this.rules.stop;
    if (stop.mode === "atr") {
      stopPrice = isShort ? lastPrice + stop.atrMult * row.atrAbs : lastPrice - stop.atrMult * row.atrAbs;
    } else if (stop.mode === "percent") {
      stopPrice = isShort ? lastPrice * (1 + stop.pct / 100) : lastPrice * (1 - stop.pct / 100);
    } else {
      const bars = mtf.tf15m.slice(-stop.lookback);
      if (bars.length < Math.min(3, stop.lookback)) {
        return rejection("setup", `not enough 15m history for the ${stop.lookback}-bar swing stop`);
      }
      stopPrice = isShort ? Math.max(...bars.map((c) => c[2])) : Math.min(...bars.map((c) => c[3]));
      const validSide = isShort ? stopPrice > lastPrice : stopPrice < lastPrice;
      if (!validSide) {
        return rejection("setup", `swing level ${stopPrice.toPrecision(6)} is on the wrong side of price — price already broke it`);
      }
    }

    // ── Dollar plan required, exactly like the built-in pro brains ──────────
    const dp = ctx.dollarPlan;
    if (!dp || !(dp.maxLossUsdt > 0) || !(dp.targetProfitUsdt > 0)) {
      return rejection("dollar-plan", "no dollar risk plan configured — set Trade Amount, Max Loss and Target Profit for this strategy on the Strategies page");
    }

    const solved = solveLeverage({
      entryPrice: lastPrice, side, marketType: ctx.marketType,
      marginUsdt: dp.tradeAmountUsdt, maxLossUsdt: dp.maxLossUsdt, targetProfitUsdt: dp.targetProfitUsdt,
      leverageCap: ctx.leverageCap, feeRate: ctx.feeRate,
      atrPercent: row.atrPercent,
      invalidationPrice: stopPrice,
    });
    if (!solved.feasible) {
      return rejection("leverage", solved.reason ?? "no safe sizing places the stop at the chosen level");
    }

    // ── Time + room + costs (identical gates to built-ins) ──────────────────
    const window = Math.max(config.maxHoldingSeconds, INTRADAY_MAX_HOLD_SECONDS);
    const tf = timeFeasible(solved.tpFraction, row, window, mtf);
    if (!tf.feasible) {
      return rejection("coin-fit", (tf.reason ?? "target unreachable within the hold window") + " — lower Target Profit or raise Trade Amount");
    }
    const expectedHold = Math.min(window, Math.max(300, tf.expectedSeconds));
    const deadline = adaptiveDeadline(expectedHold, window);

    const facts = marketFacts(mtf, row);
    const targetPct = solved.tpFraction * 100;
    const wall = isShort ? facts.supportDistancePct : facts.resistanceDistancePct;
    if (wall != null && wall < targetPct * 0.6) {
      return rejection("coin-fit", `nearest ${isShort ? "support" : "resistance"} is ${wall.toFixed(2)}% away — target ${targetPct.toFixed(2)}% is parked behind it`);
    }

    const fee = feeViability(lastPrice, solved.slPrice, solved.tpPrice, side, ctx.feeRate, ctx.slippageRate);
    if (!fee.viable) {
      return rejection("reward-risk", fee.reason ?? "reward does not clear costs");
    }

    const confidence = this.rules.confidence;
    if (confidence < config.confidenceThreshold) return null;

    // ── Written report: every rule condition becomes an auditable check ─────
    const conditionChecks = passedEval.map((e) => ({
      name: describeCondition(e.c),
      passed: true,
      detail: `observed ${e.observed}`,
    }));
    const report: DecisionReport = {
      summary:
        `Custom strategy "${this.strategyName}": all ${passedEval.length} ${side} condition(s) met on ${symbol}. ` +
        `Stop ${stop.mode === "atr" ? `${stop.atrMult}× ATR` : stop.mode === "percent" ? `${stop.pct}%` : `${stop.lookback}-bar swing`} ` +
        `at ${solved.slPrice.toPrecision(6)}; risking $${dp.maxLossUsdt} to make $${dp.targetProfitUsdt}; expecting ~${Math.round(expectedHold / 60)}min.`,
      marketView: [
        `regime ${row.regime} · ADX ${row.adx.toFixed(1)} · RSI ${row.rsi.toFixed(1)} · ${row.volumeRatio.toFixed(2)}× volume`,
        facts.resistance != null ? `nearest resistance +${facts.resistanceDistancePct!.toFixed(2)}%` : "no overhead resistance in the recent window",
        facts.support != null ? `nearest support −${facts.supportDistancePct!.toFixed(2)}%` : "no support level in the recent window",
      ],
      entryLogic: passedEval.map((e) => `${describeCondition(e.c)} — observed ${e.observed}`),
      riskLogic: [
        `dollar plan: $${dp.tradeAmountUsdt} ${ctx.marketType === "futures" ? "margin" : "notional"}, max loss $${dp.maxLossUsdt}`,
        `stop ${solved.stopDistPct.toFixed(2)}% away at ${solved.slPrice.toPrecision(6)} (binding: ${solved.bindingFloor})`,
      ],
      exitLogic: [
        `target ${targetPct.toFixed(2)}% at ${solved.tpPrice.toPrecision(6)} (+$${dp.targetProfitUsdt} net)`,
        `expected resolution ~${Math.round(expectedHold / 60)}min; adaptive deadline ${Math.round(deadline / 60)}min`,
      ],
      checks: [
        ...conditionChecks,
        { name: "Leverage solver", passed: true, detail: `${solved.leverage}× ≤ cap ${ctx.leverageCap}× · stop at the ${solved.bindingFloor}` },
        { name: "Time feasibility", passed: true, detail: `~${Math.round(tf.expectedSeconds / 60)}min needed vs ${Math.round(window / 60)}min window` },
        { name: "Fee viability", passed: true, detail: `net R:R ${fee.netRR.toFixed(2)} ≥ ${fee.floor}` },
      ],
      data: { custom: true, conditions: passedEval.length, stopMode: stop.mode, targetPct },
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
        maxHoldSeconds: deadline,
        regime: row.regime,
        report,
      },
    };
  }

  /** Legacy path unused — custom strategies are decide()-native only. */
  evaluate(): StrategySignal | null {
    return null;
  }
}
