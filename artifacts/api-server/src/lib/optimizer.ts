/**
 * TradeCore Pro — Parameter Optimizer
 *
 * Grid-searches combinations of key strategy parameters, runs a backtest
 * simulation for each combination, and stores ranked results.
 */

import { db } from "@workspace/db";
import {
  backtestRunsTable,
  optimizationResultsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { runBacktest, type BacktestParams } from "./backtestEngine";
import { logger } from "./logger";

export interface OptimizeParams {
  symbols: string[];
  timeframe: string;
  startDate: Date;
  endDate: Date;
  startingBalance: number;
  // Parameter ranges to explore
  confidenceThresholds?: number[];
  /** Stop-loss % values to grid-search (Phase 5A — replaces atrMultiplierSls) */
  stopLossPercents?: number[];
  /** Take-profit % values to grid-search (Phase 5A — replaces atrMultiplierTps) */
  takeProfitPercents?: number[];
  positionSizeUsdts?: number[];
  rankBy?: "pnl" | "profitFactor" | "sharpeRatio" | "winRate" | "maxDrawdown";
}

export interface OptimizeResult {
  optimizationRunId: number; // the parent "container" run
  combinations: number;
  childRunIds: number[];
}

/**
 * Generate all combinations from arrays of parameter values.
 */
function* cartesian(
  confidenceThresholds: number[],
  stopLossPercents: number[],
  takeProfitPercents: number[],
  positionSizes: number[]
): Generator<{
  confidenceThreshold: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  positionSizeUsdt: number;
}> {
  for (const ct of confidenceThresholds)
    for (const sl of stopLossPercents)
      for (const tp of takeProfitPercents)
        for (const ps of positionSizes)
          yield {
            confidenceThreshold: ct,
            stopLossPercent: sl,
            takeProfitPercent: tp,
            positionSizeUsdt: ps,
          };
}

export async function runOptimization(
  parentRunId: number,
  params: OptimizeParams
): Promise<void> {
  const {
    symbols,
    timeframe,
    startDate,
    endDate,
    startingBalance,
    confidenceThresholds = [60, 65, 70, 75, 80],
    stopLossPercents = [1.0, 1.5, 2.0],
    takeProfitPercents = [2.0, 2.5, 3.0],
    positionSizeUsdts = [10],
    rankBy = "profitFactor",
  } = params;

  const combos = [
    ...cartesian(
      confidenceThresholds,
      stopLossPercents,
      takeProfitPercents,
      positionSizeUsdts
    ),
  ];

  logger.info(
    { parentRunId, combinations: combos.length },
    "Optimizer: starting grid search"
  );

  await db
    .update(backtestRunsTable)
    .set({ status: "running", progress: 0 })
    .where(eq(backtestRunsTable.id, parentRunId));

  const childRunIds: number[] = [];

  for (let i = 0; i < combos.length; i++) {
    const combo = combos[i];

    // Create a child backtest run record for this parameter set
    const [childRun] = await db
      .insert(backtestRunsTable)
      .values({
        strategyVersion: "1.0",
        strategyName: "TradeCore v1 (Optimization)",
        symbols: symbols.join(","),
        timeframe,
        startDate,
        endDate,
        startingBalance: startingBalance.toFixed(2),
        params: combo,
        status: "pending",
      })
      .returning();

    childRunIds.push(childRun.id);

    const runParams: BacktestParams = {
      symbols,
      timeframe,
      startDate,
      endDate,
      startingBalance,
      maxOpenPositions: 5,
      dailyLossLimitUsdt: startingBalance * 0.05, // 5% of balance
      ...combo,
    };

    try {
      await runBacktest(childRun.id, runParams);

      // Fetch the completed run to get metrics
      const [completed] = await db
        .select()
        .from(backtestRunsTable)
        .where(eq(backtestRunsTable.id, childRun.id));

      if (completed?.status === "completed") {
        const score = getRankScore(completed, rankBy);

        await db.insert(optimizationResultsTable).values({
          runId: parentRunId,
          parameterSet: combo,
          score: score.toFixed(4),
          winRate: completed.winRate ?? "0",
          pnl: completed.totalPnl ?? "0",
          drawdown: completed.maxDrawdown ?? "0",
          profitFactor: completed.profitFactor ?? "0",
          totalTrades: completed.totalTrades ?? 0,
        });
      }
    } catch (err) {
      logger.warn(
        { err, combo, childRunId: childRun.id },
        "Optimizer: combo failed, continuing"
      );
    }

    const pct = Math.round(((i + 1) / combos.length) * 100);
    await db
      .update(backtestRunsTable)
      .set({ progress: pct })
      .where(eq(backtestRunsTable.id, parentRunId));
  }

  await db
    .update(backtestRunsTable)
    .set({ status: "completed", progress: 100 })
    .where(eq(backtestRunsTable.id, parentRunId));

  logger.info(
    { parentRunId, combinations: combos.length },
    "Optimizer: complete"
  );
}

function getRankScore(
  run: typeof backtestRunsTable.$inferSelect,
  rankBy: string
): number {
  switch (rankBy) {
    case "pnl":
      return Number(run.totalPnl ?? 0);
    case "sharpeRatio":
      return Number(run.sharpeRatio ?? 0);
    case "winRate":
      return Number(run.winRate ?? 0);
    case "maxDrawdown":
      // Lower is better — invert
      return -(Number(run.maxDrawdown ?? 1));
    case "profitFactor":
    default:
      return Number(run.profitFactor ?? 0);
  }
}
