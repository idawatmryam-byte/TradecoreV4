/**
 * TradeCore Pro — Effective Backtest Configuration  (bug fix, Phase 5A)
 *
 * ROOT CAUSE (confirmed by tracing the full pipeline):
 * `runBacktest()` in backtestEngine.ts called `loadStrategyConfigs()` — the
 * SAME loader the LIVE bot uses to read `strategy_configs` from Postgres —
 * and passed that map, completely unmodified, into
 * `strategySelector.evaluateSymbol()`. The `BacktestParams` submitted from
 * the Backtest UI (`stopLossPercent`, `takeProfitPercent`,
 * `confidenceThreshold`, `riskPercent`) were received correctly by the route
 * and correctly passed into `runBacktest()`, but nothing inside
 * `runBacktest()` ever read them when building the config each strategy's
 * `.evaluate()` actually consumes — they were computed, stored on the
 * request, and then simply never touched again.
 *
 * THE FIX: `buildEffectiveBacktestConfigs()` takes the DB-loaded configs
 * (still needed for every OTHER per-strategy field this flat UI form
 * doesn't expose — maxHoldingSeconds, cooldownMinutes, trailing-stop
 * settings, etc.) and produces a brand-new Map with `stopLossPercent` /
 * `takeProfitPercent` / `confidenceThreshold` overridden on every strategy,
 * and `riskPercent` overridden only when the submitted value is > 0 (0 is
 * documented, in BacktestParams, as "use each strategy's own configured
 * risk%" — this was the one part of the original design that *was*
 * documented correctly, just never implemented).
 *
 * PHASE 5A NOTE: the old `maxSlPercent` run-level "sanity cap" filter has
 * been removed entirely. It existed only to catch a wide ATR-multiplier
 * sweep producing an unreasonably large stop distance. Now that SL is a
 * direct, deterministic percentage (computePercentSLTP in strategies/base.ts),
 * that class of problem can't occur — the stop distance always equals
 * `stopLossPercent` exactly. Sane bounds on `stopLossPercent` itself are
 * enforced once, at the API/validation layer (see @workspace/api-zod).
 *
 * ISOLATION: `loadStrategyConfigs()` already returns fresh object literals
 * on every call (verified — no shared/cached references), so mutating the
 * clones this function produces can never affect the live bot's config or
 * write back to `strategy_configs`. This function never touches the
 * database.
 */
import type { StrategyConfig } from "./strategies";
import type { BacktestParams } from "./backtestEngine";
import { ALL_STRATEGIES } from "./strategies";
import { logger } from "./logger";

export interface EffectiveStrategyConfigSummary {
  strategyId: string;
  strategyName: string;
  enabled: boolean;
  db: { stopLossPercent: number; takeProfitPercent: number; confidenceThreshold: number; riskPercent: number };
  effective: { stopLossPercent: number; takeProfitPercent: number; confidenceThreshold: number; riskPercent: number };
  riskPercentSource: "backtest-override" | "strategy-config";
}

export interface EffectiveBacktestConfig {
  /** The actual Map<strategyId, StrategyConfig> to pass into strategySelector.evaluateSymbol(). */
  configs: Map<string, StrategyConfig>;
  /** A flat, JSON-serializable summary for logging, the DB `effective_config` column, the API, and the UI/report/CSV. */
  summary: EffectiveStrategyConfigSummary[];
  /** Echoed back for the UI/report — the run-level (non-per-strategy) overrides that were applied. */
  runLevelOverrides: {
    stopLossPercent: number;
    takeProfitPercent: number;
    confidenceThreshold: number;
    riskPercentOverride: number | null; // null = "not overridden, using each strategy's own riskPercent"
  };
}

export function buildEffectiveBacktestConfigs(
  dbConfigs: Map<string, StrategyConfig>,
  params: Pick<BacktestParams, "stopLossPercent" | "takeProfitPercent" | "confidenceThreshold" | "riskPercent">,
): EffectiveBacktestConfig {
  const configs = new Map<string, StrategyConfig>();
  const summary: EffectiveStrategyConfigSummary[] = [];
  const riskOverride = params.riskPercent && params.riskPercent > 0 ? params.riskPercent : null;
  const nameById = new Map(ALL_STRATEGIES.map((s) => [s.strategyId, s.strategyName]));

  for (const [strategyId, dbConfig] of dbConfigs) {
    const effective: StrategyConfig = {
      ...dbConfig, // clone — never mutate the object loadStrategyConfigs() gave us
      stopLossPercent: params.stopLossPercent,
      takeProfitPercent: params.takeProfitPercent,
      confidenceThreshold: params.confidenceThreshold,
      riskPercent: riskOverride ?? dbConfig.riskPercent,
    };
    configs.set(strategyId, effective);

    summary.push({
      strategyId,
      strategyName: nameById.get(strategyId) ?? strategyId,
      enabled: dbConfig.enabled,
      db: {
        stopLossPercent: dbConfig.stopLossPercent,
        takeProfitPercent: dbConfig.takeProfitPercent,
        confidenceThreshold: dbConfig.confidenceThreshold,
        riskPercent: dbConfig.riskPercent,
      },
      effective: {
        stopLossPercent: effective.stopLossPercent,
        takeProfitPercent: effective.takeProfitPercent,
        confidenceThreshold: effective.confidenceThreshold,
        riskPercent: effective.riskPercent,
      },
      riskPercentSource: riskOverride !== null ? "backtest-override" : "strategy-config",
    });
  }

  const result: EffectiveBacktestConfig = {
    configs,
    summary,
    runLevelOverrides: {
      stopLossPercent: params.stopLossPercent,
      takeProfitPercent: params.takeProfitPercent,
      confidenceThreshold: params.confidenceThreshold,
      riskPercentOverride: riskOverride,
    },
  };

  // Self-check: this is exactly the class of bug that motivated this file —
  // if this ever fires, something re-introduced the override-loss bug.
  for (const [strategyId, cfg] of result.configs) {
    if (
      cfg.stopLossPercent !== params.stopLossPercent ||
      cfg.takeProfitPercent !== params.takeProfitPercent ||
      cfg.confidenceThreshold !== params.confidenceThreshold
    ) {
      logger.error(
        { strategyId, cfg, params },
        "BACKTEST_CONFIG_OVERRIDE_FAILED: effective config does not match submitted params — this should never happen, please report",
      );
    }
  }

  logger.info({ runLevelOverrides: result.runLevelOverrides, strategies: summary }, "BACKTEST_EFFECTIVE_CONFIG");

  return result;
}
