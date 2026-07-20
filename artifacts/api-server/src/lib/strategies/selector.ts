/**
 * TradeCore Pro — Strategy Decision Dispatcher
 *
 * The strategies are the brains; the engines are the hands. For each symbol
 * the dispatcher asks every eligible strategy for a DECISION:
 *
 *   • Strategies implementing decide() own the complete decision — entry,
 *     stop, target, leverage, size, expected duration, plus a written
 *     DecisionReport — and approve or reject their own trade.
 *   • Legacy strategies (evaluate() only) run through legacyDecide(), a
 *     byte-for-byte relocation of the historical selector pipeline
 *     (evaluate → dollar-risk override → per-coin fit → confidence unify),
 *     wrapped into an equivalent TradePlan. The harness Δ0 gate proves this
 *     adapter changes nothing for them.
 *
 * One check stays CENTRAL for both paths: the net reward:risk cost floor —
 * a structural viability invariant (fees make the trade unwinnable), not
 * trading judgment. Everything else belongs to the strategy.
 *
 * Approved plans are returned sorted by confidence (highest first);
 * considered-and-rejected trades are returned as typed TradeRejections so
 * the engine can persist the full decision story.
 */
import {
  type Strategy,
  type StrategySignal,
  type StrategyConfig,
  type TradePlan,
  type TradeRejection,
  type TradeDecision,
  type DecisionContext,
  TARGET_REACH_K,
} from "./base";
import { type MultiTimeframeCandles, type SignalRow, unifyConfidence } from "../strategy";
import {
  netRewardRisk,
  MIN_VIABLE_REWARD_RISK,
  DEFAULT_FEE_RATE,
  FUTURES_FEE_RATE,
  DEFAULT_SLIPPAGE_RATE,
} from "../tradingCosts";
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
  /** Slippage fraction per leg for this market (forex ≪ crypto). When unset,
   *  DEFAULT_SLIPPAGE_RATE applies — correct for crypto, ruinous for forex,
   *  so the engines always pass it explicitly. */
  slippageRate?: number;
  /** Fallback trade amount when a strategy doesn't set its own (global positionSizeUsdt). */
  globalTradeAmountUsdt: number;
  /** Account-level dollar plan — set only when riskModel = "dollar". */
  globalMaxLossUsdt?: number;
  globalTargetProfitUsdt?: number;
}

/** Per-strategy plan wins; account-level dollar mode is the fallback; null = legacy %. */
export function resolveDollarPlan(
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

/** Everything a symbol evaluation produced: approved plans + reasoned nos. */
export interface SymbolDecisions {
  /** Sorted by confidence descending — callers can safely use [0]. */
  plans: TradePlan[];
  rejections: TradeRejection[];
}

/**
 * Legacy adapter — the HISTORICAL selector pipeline, relocated verbatim.
 *
 * Order and numbers are intentionally identical to the pre-TradePlan
 * evaluateSymbol() body: evaluate() → dollar-risk override (reject when not
 * placeable) → per-coin fit (reject) → confidence unification (no re-gate).
 * The console.warn strings are preserved so live logs read the same. Any
 * change here shows up as a nonzero delta in the parity harness — treat that
 * as a bug in this function, not in the harness.
 */
function legacyDecide(
  strategy: Strategy,
  symbol: string,
  mtf: MultiTimeframeCandles,
  row: SignalRow,
  config: StrategyConfig,
  balance: number,
  positionSizeUsdt: number,
  dollarRisk: DollarRiskContext | undefined,
): TradeDecision | null {
  const signal = strategy.evaluate(symbol, mtf, row, config, balance, positionSizeUsdt);
  if (!signal) return null;

  // ── Dollar risk model override ──────────────────────────────────────────
  // Replace the strategy's %-based stop/target/size with the levels the
  // fixed dollar risk implies. Resolution order:
  //   1. the strategy's OWN dollar plan (maxLossUsdt + targetProfitUsdt
  //      both set), using its own tradeAmountUsdt when present;
  //   2. else the account-level dollar config (riskModel = "dollar");
  //   3. else no override (legacy %-based behavior).
  // Reject the signal if the plan can't place a safe stop — fees exceed
  // the max loss, or a leveraged stop would sit beyond liquidation.
  // The netRewardRisk gate in decideSymbol then runs on the resolved levels.
  const resolved = resolveDollarPlan(config, dollarRisk);
  let dollarPlanApplied = false;
  if (resolved) {
    const plan = planDollarRisk(signal.entryPrice, signal.side, resolved);
    if (!plan.feasible || !plan.safe || plan.qty <= 0) {
      console.warn(
        `[selector] ${strategy.strategyId} rejected on ${symbol}: dollar risk not placeable ` +
          `(${plan.warnings[0] ?? "invalid plan"})`,
      );
      return {
        kind: "rejection",
        rejection: {
          strategyId: strategy.strategyId,
          strategyName: strategy.strategyName,
          symbol,
          side: signal.side,
          stage: "dollar-plan",
          reason: `dollar risk not placeable (${plan.warnings[0] ?? "invalid plan"})`,
          confidence: signal.confidence,
        },
      };
    }
    // Per-coin fit: same dollars, different volatility per coin — skip
    // coins where this plan's stop sits inside noise or the target
    // can't be reached in the hold window (structurally doomed trades).
    const fit = dollarPlanFitsCoin(plan, row, config.maxHoldingSeconds);
    if (!fit.fits) {
      console.warn(`[selector] ${strategy.strategyId} skipped ${symbol}: ${fit.reason}`);
      return {
        kind: "rejection",
        rejection: {
          strategyId: strategy.strategyId,
          strategyName: strategy.strategyName,
          symbol,
          side: signal.side,
          stage: "coin-fit",
          reason: fit.reason ?? "dollar plan does not fit this coin",
          confidence: signal.confidence,
        },
      };
    }
    signal.suggestedSL = plan.slPrice;
    signal.suggestedTP = plan.tpPrice;
    signal.qty = plan.qty;
    dollarPlanApplied = true;
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

  // Wrap the (possibly overridden) signal into an equivalent TradePlan.
  // Leverage = the account setting (the cap), exactly as the engines applied
  // it before plans existed; hold windows split so the engine timeout stays
  // config.maxHoldingSeconds — both preserve historical behavior exactly.
  const plan: TradePlan = {
    strategyId: signal.strategyId,
    strategyName: signal.strategyName,
    symbol: signal.symbol,
    side: signal.side,
    confidence: signal.confidence,
    entryPrice: signal.entryPrice,
    slPrice: signal.suggestedSL,
    tpPrice: signal.suggestedTP,
    qty: signal.qty,
    leverage: dollarRisk ? Math.max(1, dollarRisk.leverage) : 1,
    expectedHoldSeconds: signal.suggestedHoldingTime,
    maxHoldSeconds: config.maxHoldingSeconds,
    regime: signal.regime,
    report: {
      summary: signal.entryReason,
      marketView: [
        `regime: ${signal.regime}`,
        `ATR ${row.atrPercent.toFixed(2)}%/candle · ADX ${row.adx.toFixed(0)} · volume ${row.volumeRatio.toFixed(1)}× avg`,
      ],
      entryLogic: [signal.entryReason],
      riskLogic: [
        dollarPlanApplied
          ? `dollar plan: stop/target/size derived from the strategy's configured $ risk`
          : `legacy % model: stop/target from the strategy's configured percentages`,
        `stop ${signal.suggestedSL.toFixed(6)} · qty ${signal.qty.toFixed(6)}`,
      ],
      exitLogic: [
        `target ${signal.suggestedTP.toFixed(6)}`,
        `forced exit after ${Math.round(config.maxHoldingSeconds / 60)}min`,
      ],
      checks: [
        { name: "Regime fit", passed: true, detail: `${signal.regime} supported` },
        ...(dollarPlanApplied
          ? [
              { name: "Dollar plan placeable", passed: true, detail: "stop safe vs fees + liquidation" },
              { name: "Coin fit", passed: true, detail: "stop outside noise band; target reachable in window" },
            ]
          : []),
      ],
    },
  };
  return { kind: "plan", plan };
}

export class StrategySelector {
  private strategies: Strategy[];

  constructor(strategies: Strategy[]) {
    this.strategies = strategies;
  }

  /**
   * Ask every eligible strategy for its decision on one symbol.
   * Native decide() strategies own the full decision; legacy strategies run
   * through the adapter. Central: the net reward:risk cost floor.
   */
  decideSymbol(
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
  ): SymbolDecisions {
    const plans: TradePlan[] = [];
    const rejections: TradeRejection[] = [];

    for (const strategy of this.strategies) {
      if (!strategy.supportedRegimes.includes(row.regime as any)) continue;

      const config = configs.get(strategy.strategyId);
      if (!config || !config.enabled) continue;

      try {
        const decision = strategy.decide
          ? strategy.decide(symbol, mtf, row, config, this.buildContext(config, balance, positionSizeUsdt, dollarRisk))
          : legacyDecide(strategy, symbol, mtf, row, config, balance, positionSizeUsdt, dollarRisk);
        if (!decision) continue;

        if (decision.kind === "rejection") {
          rejections.push(decision.rejection);
          continue;
        }

        const plan = decision.plan;

        // Structural reward:risk quality gate (shared by live + backtest since
        // both call this method). A trade whose reward doesn't justify its
        // risk after costs is rejected here regardless of confidence — the
        // "well-defined risk/reward profile" discipline, enforced once,
        // centrally, so a single misconfigured strategy can't leak a
        // structurally-poor trade into either engine.
        // Costs must be the ACTIVE market's, not the crypto defaults: FX
        // targets (~0.25%) are smaller than crypto's 0.3% round-trip cost,
        // so defaulted rates here rejected every forex plan ever produced.
        const rr = netRewardRisk(
          plan.entryPrice, plan.slPrice, plan.tpPrice, plan.side,
          dollarRisk?.feeRate ?? DEFAULT_FEE_RATE,
          dollarRisk?.slippageRate ?? DEFAULT_SLIPPAGE_RATE,
        );
        if (rr < MIN_VIABLE_REWARD_RISK) {
          console.warn(
            `[selector] ${strategy.strategyId} rejected on ${symbol}: net reward:risk ${rr.toFixed(2)} below ${MIN_VIABLE_REWARD_RISK} floor`,
          );
          rejections.push({
            strategyId: plan.strategyId,
            strategyName: plan.strategyName,
            symbol,
            side: plan.side,
            stage: "reward-risk",
            reason: `net reward:risk ${rr.toFixed(2)} below ${MIN_VIABLE_REWARD_RISK} floor`,
            confidence: plan.confidence,
            report: plan.report,
          });
          continue;
        }
        plan.netRewardRisk = Math.round(rr * 100) / 100;
        plan.report.checks.push({
          name: "Reward:risk floor",
          passed: true,
          detail: `net ${plan.netRewardRisk} ≥ ${MIN_VIABLE_REWARD_RISK} after costs`,
        });
        plans.push(plan);
      } catch (err) {
        // Individual strategy failures must never crash the scan loop
        console.error(`[selector] ${strategy.strategyId} threw on ${symbol}:`, err);
      }
    }

    // Always return highest-confidence plan first so callers can safely use [0]
    plans.sort((a, b) => b.confidence - a.confidence);
    return { plans, rejections };
  }

  /** Account facts handed to native decide() strategies. */
  private buildContext(
    config: StrategyConfig,
    balance: number,
    positionSizeUsdt: number,
    dollarRisk: DollarRiskContext | undefined,
  ): DecisionContext {
    const marketType = dollarRisk?.marketType ?? "spot";
    return {
      balance,
      positionSizeUsdt,
      marketType,
      leverageCap: Math.max(1, dollarRisk?.leverage ?? 1),
      feeRate: dollarRisk?.feeRate ?? (marketType === "futures" ? FUTURES_FEE_RATE : DEFAULT_FEE_RATE),
      slippageRate: dollarRisk?.slippageRate ?? DEFAULT_SLIPPAGE_RATE,
      dollarPlan: resolveDollarPlan(config, dollarRisk),
    };
  }

  /**
   * Back-compat shim over decideSymbol(): returns the approved plans mapped
   * onto the historical StrategySignal shape (identical field values), so
   * existing engine call sites keep working while they migrate to plans.
   * Rejections are dropped here — call decideSymbol() to receive them.
   */
  evaluateSymbol(
    symbol: string,
    mtf: MultiTimeframeCandles,
    row: SignalRow,
    configs: Map<string, StrategyConfig>,
    balance: number,
    positionSizeUsdt: number,
    dollarRisk?: DollarRiskContext,
  ): StrategySignal[] {
    const { plans } = this.decideSymbol(symbol, mtf, row, configs, balance, positionSizeUsdt, dollarRisk);
    return plans.map((p) => ({
      strategyId: p.strategyId,
      strategyName: p.strategyName,
      symbol: p.symbol,
      side: p.side,
      confidence: p.confidence,
      entryReason: p.report.summary,
      regime: p.regime,
      entryPrice: p.entryPrice,
      suggestedSL: p.slPrice,
      suggestedTP: p.tpPrice,
      suggestedHoldingTime: p.expectedHoldSeconds,
      qty: p.qty,
      netRewardRisk: p.netRewardRisk,
    }));
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
