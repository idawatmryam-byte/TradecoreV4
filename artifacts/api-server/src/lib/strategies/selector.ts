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
import { type MultiTimeframeCandles, type SignalRow } from "../strategy";
import { netRewardRisk, MIN_VIABLE_REWARD_RISK } from "../tradingCosts";

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
  ): StrategySignal[] {
    const signals: StrategySignal[] = [];

    for (const strategy of this.strategies) {
      if (!strategy.supportedRegimes.includes(row.regime as any)) continue;

      const config = configs.get(strategy.strategyId);
      if (!config || !config.enabled) continue;

      try {
        const signal = strategy.evaluate(symbol, mtf, row, config, balance, positionSizeUsdt);
        if (!signal) continue;

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
  ): StrategySignal[] {
    const all: StrategySignal[] = [];
    for (const { symbol, mtf, row } of symbolData) {
      all.push(...this.evaluateSymbol(symbol, mtf, row, configs, balance, positionSizeUsdt));
    }
    all.sort((a, b) => b.confidence - a.confidence);
    return all;
  }

  get strategyList(): Strategy[] {
    return this.strategies;
  }
}
