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
import { type Strategy, type StrategySignal, type StrategyConfig } from "./base";
import { type MultiTimeframeCandles, type SignalRow, unifyConfidence } from "../strategy";
import { netRewardRisk, MIN_VIABLE_REWARD_RISK } from "../tradingCosts";
import { type DollarRiskConfig, planDollarRisk } from "../dollarRisk";

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
     * When set, the engine is in DOLLAR risk mode: the strategy still decides
     * DIRECTION and entry timing, but its %-based SL/TP/qty are overridden by
     * the dollar-based plan (fixed max-loss / target-profit → SL price, TP
     * price and size). Shared by live + backtest so both size identically.
     */
    dollarRisk?: DollarRiskConfig,
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
        // user's fixed dollar risk implies. Reject the signal (parity with
        // live + backtest) if the dollar config can't place a safe stop —
        // e.g. fees exceed the max loss, or a leveraged stop would sit beyond
        // liquidation. The netRewardRisk gate below then runs on these levels.
        if (dollarRisk) {
          const plan = planDollarRisk(signal.entryPrice, signal.side, dollarRisk);
          if (!plan.feasible || !plan.safe || plan.qty <= 0) {
            console.warn(
              `[selector] ${strategy.strategyId} rejected on ${symbol}: dollar risk not placeable ` +
                `(${plan.warnings[0] ?? "invalid plan"})`,
            );
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
    dollarRisk?: DollarRiskConfig,
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
