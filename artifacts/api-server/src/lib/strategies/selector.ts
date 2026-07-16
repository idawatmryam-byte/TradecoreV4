/**
 * TradeCore Pro — Strategy Selection Engine  (Phase 2)
 *
 * For each symbol:
 *   1. Check market regime (already in SignalRow)
 *   2. Run all enabled strategies whose supportedRegimes match
 *   3. Collect StrategySignal outputs
 *
 * Then across all symbols:
 *   4. Rank all signals by confidence (descending)
 *   5. Return the sorted opportunity list — caller decides how many to execute
 */
import { type Strategy, type StrategySignal, type StrategyConfig, TARGET_REACH_K } from "./base";
import { type MultiTimeframeCandles, type SignalRow, unifyConfidence } from "../strategy";
import { netRewardRisk, MIN_VIABLE_REWARD_RISK } from "../tradingCosts";
import { type DollarRiskConfig, planDollarRisk, type DollarRiskPlan } from "../dollarRisk";

/**
 * A stop tighter than this many 1m-ATRs is inside the coin's ordinary
 * candle-to-candle noise — it gets wicked out at random regardless of
 * direction. Companion to TARGET_REACH_K (which bounds the TARGET side).
 */
export const MIN_STOP_ATR_MULT = 1.5;

/**
 * Per-coin fit check for a DOLLAR trade plan. The same dollar numbers imply
 * the same %-distances on every coin — but coins differ wildly in
 * volatility, so on some the stop sits inside pure noise (random stop-out)
 * and on others the target is physically unreachable within the holding
 * window (guaranteed timeout + fees). Both are structural losses no signal
 * quality can beat, so such signals are rejected per coin, with the reason.
 * (The legacy % model gets the same protection via computeAdaptiveSLTP.)
 */
function dollarPlanFitsCoin(
  plan: DollarRiskPlan,
  row: SignalRow,
  maxHoldingSeconds: number,
): { fits: boolean; reason?: string } {
  const atrPct = row.atrPercent; // % per primary candle
  if (!(atrPct > 0)) return { fits: true }; // no volatility data → don't block
  const slPct = plan.slFraction * 100;
  const tpPct = plan.tpFraction * 100;

  const noiseFloorPct = atrPct * MIN_STOP_ATR_MULT;
  if (slPct < noiseFloorPct) {
    return {
      fits: false,
      reason: `stop ${slPct.toFixed(2)}% is inside this coin's noise band (~${noiseFloorPct.toFixed(2)}%) — would stop out randomly`,
    };
  }

  if (maxHoldingSeconds > 0 && tpPct > 0) {
    const holdCandles = maxHoldingSeconds / 60 / Math.max(1, row.candleMinutes);
    const reachablePct = atrPct * Math.sqrt(holdCandles) * TARGET_REACH_K;
    if (tpPct > reachablePct) {
      return {
        fits: false,
        reason: `target ${tpPct.toFixed(2)}% unreachable within the hold window (~${reachablePct.toFixed(2)}% reachable at this coin's volatility)`,
      };
    }
  }
  return { fits: true };
}

/**
 * Account-level context for dollar-risk resolution, passed by both engines
 * (live + backtest) on every evaluation. The GLOBAL dollar numbers are only
 * set when the account's riskModel is "dollar"; per-strategy plans work
 * regardless, since they carry their own numbers.
 */
export interface DollarRiskContext {
  marketType: "spot" | "futures";
  leverage: number;
  feeRate: number;
  /** Fallback trade amount when a strategy doesn't set its own (global positionSizeUsdt). */
  globalTradeAmountUsdt: number;
  /** Account-level dollar plan — set only when riskModel = "dollar". */
  globalMaxLossUsdt?: number;
  globalTargetProfitUsdt?: number;
}

/** Per-strategy plan wins; account-level dollar mode is the fallback; null = legacy %. */
function resolveDollarPlan(
  config: StrategyConfig,
  ctx: DollarRiskContext | undefined,
): DollarRiskConfig | null {
  if (!ctx) return null;
  const base = { marketType: ctx.marketType, leverage: ctx.leverage, feeRate: ctx.feeRate };
  if (config.maxLossUsdt != null && config.maxLossUsdt > 0 &&
      config.targetProfitUsdt != null && config.targetProfitUsdt > 0) {
    return {
      ...base,
      tradeAmountUsdt: config.tradeAmountUsdt ?? ctx.globalTradeAmountUsdt,
      maxLossUsdt: config.maxLossUsdt,
      targetProfitUsdt: config.targetProfitUsdt,
    };
  }
  if (ctx.globalMaxLossUsdt != null && ctx.globalMaxLossUsdt > 0 &&
      ctx.globalTargetProfitUsdt != null && ctx.globalTargetProfitUsdt > 0) {
    return {
      ...base,
      tradeAmountUsdt: ctx.globalTradeAmountUsdt,
      maxLossUsdt: ctx.globalMaxLossUsdt,
      targetProfitUsdt: ctx.globalTargetProfitUsdt,
    };
  }
  return null;
}

export class StrategySelector {
  private strategies: Strategy[];

  constructor(strategies: Strategy[]) {
    this.strategies = strategies;
  }

  /**
   * Evaluate a single symbol against all applicable strategies.
   * Returns zero or more signals (one per matching strategy that fires).
   */
  evaluateSymbol(
    symbol: string,
    mtf: MultiTimeframeCandles,
    row: SignalRow,
    configs: Map<string, StrategyConfig>,
    balance: number,
    positionSizeUsdt: number,
    /**
     * When set, dollar-risk resolution is ACTIVE: each strategy's own
     * tradeAmountUsdt/maxLossUsdt/targetProfitUsdt (per-strategy trade plan,
     * the primary Strategies-page controls) — or, as fallback, the global
     * dollar config when the account-level riskModel is "dollar" — overrides
     * the strategy's %-based SL/TP/qty with the dollar-derived plan.
     * Shared by live + backtest so both size identically.
     */
    dollarRisk?: DollarRiskContext,
  ): StrategySignal[] {
    const signals: StrategySignal[] = [];

    for (const strategy of this.strategies) {
      if (!strategy.supportedRegimes.includes(row.regime as any)) continue;

      const config = configs.get(strategy.strategyId);
      if (!config || !config.enabled) continue;

      try {
        const signal = strategy.evaluate(symbol, mtf, row, config, balance, positionSizeUsdt);
        if (!signal) continue;

        // ── Dollar risk model override ──────────────────────────────────────
        // Replace the strategy's %-based stop/target/size with the levels the
        // fixed dollar risk implies. Resolution order:
        //   1. the strategy's OWN dollar plan (maxLossUsdt + targetProfitUsdt
        //      both set), using its own tradeAmountUsdt when present;
        //   2. else the account-level dollar config (riskModel = "dollar");
        //   3. else no override (legacy %-based behavior).
        // Reject the signal if the plan can't place a safe stop — fees exceed
        // the max loss, or a leveraged stop would sit beyond liquidation.
        // The netRewardRisk gate below then runs on the resolved levels.
        const resolved = resolveDollarPlan(config, dollarRisk);
        if (resolved) {
          const plan = planDollarRisk(signal.entryPrice, signal.side, resolved);
          if (!plan.feasible || !plan.safe || plan.qty <= 0) {
            console.warn(
              `[selector] ${strategy.strategyId} rejected on ${symbol}: dollar risk not placeable ` +
                `(${plan.warnings[0] ?? "invalid plan"})`,
            );
            continue;
          }
          // Per-coin fit: same dollars, different volatility per coin — skip
          // coins where this plan's stop sits inside noise or the target
          // can't be reached in the hold window (structurally doomed trades).
          const fit = dollarPlanFitsCoin(plan, row, config.maxHoldingSeconds);
          if (!fit.fits) {
            console.warn(`[selector] ${strategy.strategyId} skipped ${symbol}: ${fit.reason}`);
            continue;
          }
          signal.suggestedSL = plan.slPrice;
          signal.suggestedTP = plan.tpPrice;
          signal.qty = plan.qty;
        }

        // Confidence unification (deferred-work #1): blend the strategy's own
        // setup-quality confidence with the 12-indicator market-structure
        // score so the broad analysis INFORMS the trade — it sets the
        // signal's confidence, which drives ranking (highest first) and the
        // displayed/stored value. The strategy has already gated on its own
        // confidence threshold; the blend does NOT re-gate.
        //
        // WHY NO RE-GATE: an earlier version re-gated the blended value
        // against the same threshold. On REAL data that zeroed out trades —
        // the 12-indicator structure score runs low on live crypto (~10–50,
        // vs 60–70 thresholds), so `0.7·strat + 0.3·structure` almost always
        // fell below the bar and every signal was rejected. The synthetic
        // harness missed it (its structure scores are higher). A structure-
        // based veto can come back later, but only tuned against real data.
        signal.confidence = unifyConfidence(signal.confidence, signal.side, row);

        // Structural reward:risk quality gate (shared by live + backtest since
        // both call this method). A trade whose reward doesn't justify its
        // risk after costs is rejected here regardless of confidence — the
        // "well-defined risk/reward profile" discipline, enforced once,
        // centrally, so a single misconfigured strategy can't leak a
        // structurally-poor trade into either engine.
        const rr = netRewardRisk(signal.entryPrice, signal.suggestedSL, signal.suggestedTP, signal.side);
        if (rr < MIN_VIABLE_REWARD_RISK) {
          console.warn(
            `[selector] ${strategy.strategyId} rejected on ${symbol}: net reward:risk ${rr.toFixed(2)} below ${MIN_VIABLE_REWARD_RISK} floor`,
          );
          continue;
        }
        signal.netRewardRisk = Math.round(rr * 100) / 100;
        signals.push(signal);
      } catch (err) {
        // Individual strategy failures must never crash the scan loop
        console.error(`[selector] ${strategy.strategyId} threw on ${symbol}:`, err);
      }
    }

    // Always return highest-confidence signal first so callers can safely use [0]
    return signals.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Evaluate all symbols, collect all signals, rank by confidence descending.
   */
  rankAll(
    symbolData: Array<{ symbol: string; mtf: MultiTimeframeCandles; row: SignalRow }>,
    configs: Map<string, StrategyConfig>,
    balance: number,
    positionSizeUsdt: number,
    dollarRisk?: DollarRiskContext,
  ): StrategySignal[] {
    const all: StrategySignal[] = [];
    for (const { symbol, mtf, row } of symbolData) {
      all.push(...this.evaluateSymbol(symbol, mtf, row, configs, balance, positionSizeUsdt, dollarRisk));
    }
    all.sort((a, b) => b.confidence - a.confidence);
    return all;
  }

  get strategyList(): Strategy[] {
    return this.strategies;
  }
}
