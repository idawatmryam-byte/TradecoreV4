/**
 * London Breakout Strategy — FOREX-NATIVE (not in the crypto catalog)
 *
 * The classic FX session play: the Asian session (00:00–07:00 UTC) usually
 * compresses the majors into a tight range; the surge of liquidity at the
 * London open then frequently resolves that compression as a directional
 * move. The trade is the break of the Asian range during the London morning
 * (07:00–11:00 UTC), with the stop at the range midpoint — if price falls
 * back to the middle of the overnight range the breakout has failed.
 *
 * Why this only exists for forex: the setup is defined by SESSION structure
 * (Asia hands off to London), which crypto's 24/7 market simply doesn't
 * have. Session times use fixed UTC hours — a deliberate simplification
 * (London's 08:00 local open is 07:00 UTC in summer / 08:00 UTC in winter;
 * the 4-hour trade window absorbs the DST hour).
 *
 * All risk comes from the user's dollar plan through the shared solver, the
 * same as every other native strategy: stop at the structural level, sizing
 * derived from Max Loss, feasibility/room/cost gates before any plan ships.
 */
import {
  type Strategy, type StrategySignal, type StrategyConfig, type PositionSide,
  type TradeDecision, type DecisionContext, type DecisionReport,
} from "./base";
import { type MultiTimeframeCandles, type SignalRow } from "../strategy";
import {
  marketFacts, solveLeverage, timeFeasible, feeViability,
  adaptiveDeadline, INTRADAY_MAX_HOLD_SECONDS,
} from "./toolkit";

/** Session boundaries, UTC hours. */
const ASIA_START_H = 0;
const ASIA_END_H = 7;    // London handoff
const LONDON_END_H = 11; // stop initiating after the morning session

export interface AsianRange {
  high: number;
  low: number;
  mid: number;
  widthPct: number;
  bars: number;
}

/**
 * The Asian-session range for the UTC day containing `now`, from 15m candles.
 * Pure and exported for the harness. Returns null until the session has
 * produced enough bars to call it a range (≥ 20 of the 28 possible).
 */
export function asianRange(tf15m: ReadonlyArray<readonly number[]>, nowMs: number): AsianRange | null {
  const dayStart = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const from = dayStart + ASIA_START_H * 3_600_000;
  const to = dayStart + ASIA_END_H * 3_600_000;
  const session = tf15m.filter((c) => c[0]! >= from && c[0]! < to);
  if (session.length < 20) return null;
  const high = Math.max(...session.map((c) => c[2]!));
  const low = Math.min(...session.map((c) => c[3]!));
  if (!(high > low) || !(low > 0)) return null;
  const mid = (high + low) / 2;
  return { high, low, mid, widthPct: ((high - low) / mid) * 100, bars: session.length };
}

export class LondonBreakoutStrategy implements Strategy {
  readonly strategyId = "london_breakout";
  readonly strategyName = "London Breakout";
  // Session compression → expansion happens across regimes; the range gate
  // below (width sanity vs ATR) is the real filter, not the regime label.
  readonly supportedRegimes = ["strong_trend", "weak_trend", "range", "low_volatility"] as const;
  readonly indicators = [
    "Asian session range 00:00–07:00 UTC (15m)",
    "Break of range high/low, London morning 07:00–11:00 UTC",
    "Range width vs ATR compression check",
    "Volume ≥ 1.1× average on the break (1m tick volume)",
    "Swing S/R room check (15m)",
  ] as const;

  decide(
    symbol: string,
    mtf: MultiTimeframeCandles,
    row: SignalRow,
    config: StrategyConfig,
    ctx: DecisionContext,
  ): TradeDecision | null {
    const lastPrice = row.lastPrice;
    const nowMs = mtf.tf1m.length > 0 ? mtf.tf1m[mtf.tf1m.length - 1]![0]! : Date.now();
    const hourUtc = new Date(nowMs).getUTCHours();

    // Only initiate during the London morning — outside it, silently pass
    // (this is "no setup exists", not a considered rejection).
    if (hourUtc < ASIA_END_H || hourUtc >= LONDON_END_H) return null;

    const range = asianRange(mtf.tf15m, nowMs);
    if (!range) return null;

    const side: PositionSide | null =
      lastPrice > range.high ? "long" : lastPrice < range.low ? "short" : null;
    if (!side) return null; // still inside the range — nothing has broken
    const isShort = side === "short";
    const level = isShort ? range.low : range.high;

    const rejection = (stage: "setup" | "dollar-plan" | "coin-fit" | "leverage" | "reward-risk", reason: string, report?: DecisionReport): TradeDecision => ({
      kind: "rejection",
      rejection: { strategyId: this.strategyId, strategyName: this.strategyName, symbol, side, stage, reason, report },
    });

    // ── Range quality: a breakout needs a genuine compression to break ──────
    // Too narrow = noise band (any tick "breaks" it); too wide = Asia already
    // trended, there is no compression to resolve.
    const minWidth = Math.max(0.06, row.atrPercent * 0.8);
    const maxWidth = Math.max(0.8, row.atrPercent * 6);
    if (range.widthPct < minWidth) {
      return rejection("setup", `Asian range ${range.widthPct.toFixed(3)}% is inside noise (min ${minWidth.toFixed(2)}%) — nothing meaningful to break`);
    }
    if (range.widthPct > maxWidth) {
      return rejection("setup", `Asian range ${range.widthPct.toFixed(2)}% is already a trend, not a compression (max ${maxWidth.toFixed(2)}%)`);
    }

    // ── Freshness: don't chase a break that already ran ─────────────────────
    const extensionPct = (Math.abs(lastPrice - level) / level) * 100;
    const maxChasePct = Math.max(0.08, range.widthPct * 0.5);
    if (extensionPct > maxChasePct) {
      return rejection("setup", `break already extended ${extensionPct.toFixed(2)}% past the range ${isShort ? "low" : "high"} (limit ${maxChasePct.toFixed(2)}%) — chasing a spent move`);
    }

    // ── Participation: the break should carry at least average volume ───────
    if (row.volumeRatio < 1.1) {
      return rejection("setup", `break on ${row.volumeRatio.toFixed(2)}× volume — an unparticipated drift through the level, not a breakout`);
    }

    // ── Dollar plan required (same contract as every native strategy) ───────
    const dp = ctx.dollarPlan;
    if (!dp || !(dp.maxLossUsdt > 0) || !(dp.targetProfitUsdt > 0)) {
      return rejection("dollar-plan", "no dollar risk plan configured — set Trade Amount, Max Loss and Target Profit for this strategy on the Strategies page");
    }

    // ── Stop at the range midpoint — the structural invalidation ────────────
    const solved = solveLeverage({
      entryPrice: lastPrice, side, marketType: ctx.marketType,
      marginUsdt: dp.tradeAmountUsdt, maxLossUsdt: dp.maxLossUsdt, targetProfitUsdt: dp.targetProfitUsdt,
      leverageCap: ctx.leverageCap, feeRate: ctx.feeRate,
      atrPercent: row.atrPercent,
      invalidationPrice: range.mid,
    });
    if (!solved.feasible) {
      return rejection("leverage", solved.reason ?? "no safe sizing places the stop at the range midpoint");
    }

    // ── Time + room + costs ─────────────────────────────────────────────────
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

    // ── Confidence: fresher break + cleaner compression + participation ─────
    const freshness = Math.max(0, 12 * (1 - extensionPct / maxChasePct));       // 0–12
    const compression = Math.max(0, Math.min(10, 10 * (1 - range.widthPct / maxWidth))); // 0–10
    const volBonus = Math.min(8, (row.volumeRatio - 1.1) * 8);                  // 0–8
    const confidence = Math.min(100, Math.round((58 + freshness + compression + volBonus) * 10) / 10);
    if (confidence < config.confidenceThreshold) return null;

    const report: DecisionReport = {
      summary:
        `London-open break of the Asian range ${isShort ? "low" : "high"} ${level.toPrecision(6)} ` +
        `(range ${range.widthPct.toFixed(2)}% over ${range.bars} bars) on ${row.volumeRatio.toFixed(1)}× volume. ` +
        `Stop at the range midpoint ${range.mid.toPrecision(6)} — back to the middle of the overnight range means the break failed. ` +
        `Risking $${dp.maxLossUsdt} to make $${dp.targetProfitUsdt}; expecting ~${Math.round(expectedHold / 60)}min.`,
      marketView: [
        `Asian session 00:00–07:00 UTC compressed ${symbol} into a ${range.widthPct.toFixed(2)}% range`,
        `London morning (07:00–11:00 UTC) — the session where overnight ranges resolve`,
        `regime ${row.regime} · ATR ${row.atrPercent.toFixed(2)}% · ${row.volumeRatio.toFixed(2)}× volume`,
        facts.resistance != null ? `nearest resistance +${facts.resistanceDistancePct!.toFixed(2)}%` : "no overhead resistance in the recent window",
        facts.support != null ? `nearest support −${facts.supportDistancePct!.toFixed(2)}%` : "no support level in the recent window",
      ],
      entryLogic: [
        `Asian range ${range.low.toPrecision(6)} – ${range.high.toPrecision(6)} (${range.bars} × 15m bars)`,
        `price broke the ${isShort ? "low" : "high"} and sits ${extensionPct.toFixed(2)}% past it — fresh, not chased`,
        `${row.volumeRatio.toFixed(1)}× average volume on the break`,
      ],
      riskLogic: [
        `dollar plan: $${dp.tradeAmountUsdt} notional, max loss $${dp.maxLossUsdt}`,
        `stop ${solved.stopDistPct.toFixed(2)}% away at ${solved.slPrice.toPrecision(6)} — the range midpoint (binding: ${solved.bindingFloor})`,
      ],
      exitLogic: [
        `target ${targetPct.toFixed(2)}% at ${solved.tpPrice.toPrecision(6)} (+$${dp.targetProfitUsdt} net)`,
        ...(config.tp1RMultiple > 0
          ? [`two-stage exit: bank ${config.tp1ClosePercent}% at +${config.tp1RMultiple}R and move the stop to BREAK-EVEN`]
          : []),
        `expected resolution ~${Math.round(expectedHold / 60)}min; adaptive deadline ${Math.round(deadline / 60)}min`,
      ],
      checks: [
        { name: "London window", passed: true, detail: `${hourUtc}:xx UTC inside 07:00–11:00` },
        { name: "Range quality", passed: true, detail: `${range.widthPct.toFixed(2)}% within [${minWidth.toFixed(2)}%, ${maxWidth.toFixed(2)}%]` },
        { name: "Fresh break", passed: true, detail: `${extensionPct.toFixed(2)}% past the level (chase limit ${maxChasePct.toFixed(2)}%)` },
        { name: "Time feasibility", passed: true, detail: `~${Math.round(tf.expectedSeconds / 60)}min needed vs ${Math.round(window / 60)}min window` },
        { name: "Fee viability", passed: true, detail: `net R:R ${fee.netRR.toFixed(2)} ≥ ${fee.floor}` },
      ],
      data: {
        rangeHigh: range.high, rangeLow: range.low, rangeMid: range.mid,
        rangeWidthPct: range.widthPct, extensionPct, hourUtc,
        expectedHoldSeconds: expectedHold, targetPct,
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
        maxHoldSeconds: deadline,
        regime: row.regime,
        report,
      },
    };
  }

  /** Legacy path unused — this strategy is decide()-native only. */
  evaluate(): StrategySignal | null {
    return null;
  }
}
