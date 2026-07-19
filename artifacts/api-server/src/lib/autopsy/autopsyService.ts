/**
 * TradeCore Pro — Optimization Autopsy orchestrator
 *
 * Runs the staged, walk-forward-validated parameter sweep for ONE strategy:
 *
 *   1. Split the window: first ⅔ = TRAIN, last ⅓ = VALIDATION.
 *   2. Stage 1 (train): sweep the dollar plan (Max Loss × Target) around the
 *      current values. Stage 2 (train): sweep confidence × hold time around
 *      the stage-1 winner. Coordinate descent keeps a full autopsy ≈ 25-30
 *      backtests instead of a 100+ Cartesian blow-up.
 *   3. Take the top candidates by train profit factor and re-run them — and
 *      the CURRENT config — on the validation window neither ever saw.
 *      Only a candidate that beats current out-of-sample becomes a
 *      suggestion (see diagnose.ts for the honesty rules).
 *
 * Every combo runs through the real backtest engine (live-parity code) as a
 * hidden child backtest_runs row; children are deleted when the autopsy
 * finishes so the user's backtest list stays clean. Two children run at a
 * time (the VPS also hosts the live engines), and a wall-clock budget
 * truncates the sweep rather than letting it run away.
 */
import { db, backtestRunsTable, backtestTradesTable, autopsyRunsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { runBacktest, type BacktestParams } from "../backtestEngine";
import { loadStrategyConfigs } from "../strategyConfigLoader";
import { ALL_STRATEGIES } from "../strategies";
import { logger } from "../logger";
import {
  diagnose, dollarPlanGrid, timingGrid,
  type AutopsyParams, type WindowMetrics,
} from "./diagnose";

const CONCURRENCY = 2;
const TIME_BUDGET_MS = 10 * 60_000;
/** Candidates need at least this many TRAIN trades to advance to validation. */
const MIN_TRAIN_TRADES = 5;
const TOP_CANDIDATES = 3;

export interface AutopsyRequest {
  strategyId: string;
  symbols: string[];
  timeframe: string;
  startDate: Date;
  endDate: Date;
}

interface Candidate {
  params: AutopsyParams;
  train?: WindowMetrics;
  val?: WindowMetrics;
}

export async function startAutopsy(userId: number, req: AutopsyRequest): Promise<number> {
  const totalMs = req.endDate.getTime() - req.startDate.getTime();
  const trainEnd = new Date(req.startDate.getTime() + Math.round(totalMs * (2 / 3)));
  const strategyName = ALL_STRATEGIES.find((s) => s.strategyId === req.strategyId)?.strategyName ?? req.strategyId;

  const configs = await loadStrategyConfigs(userId, "crypto");
  const cfg = configs.get(req.strategyId);
  if (!cfg) throw new Error(`Unknown strategy: ${req.strategyId}`);

  const currentParams: AutopsyParams = {
    maxLossUsdt: cfg.maxLossUsdt,
    targetProfitUsdt: cfg.targetProfitUsdt,
    confidenceThreshold: cfg.confidenceThreshold,
    maxHoldingSeconds: cfg.maxHoldingSeconds,
  };

  const [row] = await db
    .insert(autopsyRunsTable)
    .values({
      userId,
      section: "crypto",
      strategyId: req.strategyId,
      strategyName,
      symbols: req.symbols.join(","),
      timeframe: req.timeframe,
      trainStart: req.startDate,
      trainEnd,
      valStart: trainEnd,
      valEnd: req.endDate,
      status: "pending",
      currentParams,
    })
    .returning();

  // Fire-and-forget with full error capture onto the row.
  void runAutopsy(row!.id, userId, req, trainEnd, currentParams).catch(async (err) => {
    logger.error({ err, autopsyId: row!.id }, "AUTOPSY_FAILED");
    await db
      .update(autopsyRunsTable)
      .set({ status: "failed", error: String((err as Error)?.message ?? err), completedAt: new Date() })
      .where(eq(autopsyRunsTable.id, row!.id));
  });

  return row!.id;
}

async function runAutopsy(
  autopsyId: number,
  userId: number,
  req: AutopsyRequest,
  trainEnd: Date,
  currentParams: AutopsyParams,
): Promise<void> {
  const startedAt = Date.now();
  const childRunIds: number[] = [];
  const overBudget = () => Date.now() - startedAt > TIME_BUDGET_MS;

  const setState = (patch: Partial<typeof autopsyRunsTable.$inferInsert>) =>
    db.update(autopsyRunsTable).set(patch).where(eq(autopsyRunsTable.id, autopsyId));

  await setState({ status: "running", stage: "preparing candles" });

  /** Run one config on one window through the real engine; returns metrics. */
  let completed = 0;
  async function evaluate(params: AutopsyParams, windowStart: Date, windowEnd: Date, label: string): Promise<WindowMetrics | null> {
    const [child] = await db
      .insert(backtestRunsTable)
      .values({
        userId,
        strategyName: `Autopsy child (${label})`,
        symbols: req.symbols.join(","),
        timeframe: req.timeframe,
        startDate: windowStart,
        endDate: windowEnd,
        startingBalance: "1000.00",
        params: { type: "autopsy-child", autopsyId, candidate: params },
        status: "pending",
      })
      .returning();
    childRunIds.push(child!.id);

    const btParams: BacktestParams = {
      symbols: req.symbols,
      timeframe: req.timeframe,
      startDate: windowStart,
      endDate: windowEnd,
      startingBalance: 1000,
      // Run-level knobs are inert in faithful mode; the breaker is opened
      // wide so daily-loss clipping can't mask a config's true behavior.
      confidenceThreshold: 0,
      stopLossPercent: 1,
      takeProfitPercent: 2,
      positionSizeUsdt: 100,
      maxOpenPositions: 5,
      dailyLossLimitUsdt: 1_000_000,
      perStrategyConfigs: true,
      onlyStrategyId: req.strategyId,
      strategyOverride: {
        strategyId: req.strategyId,
        patch: {
          maxLossUsdt: params.maxLossUsdt,
          targetProfitUsdt: params.targetProfitUsdt,
          confidenceThreshold: params.confidenceThreshold,
          maxHoldingSeconds: params.maxHoldingSeconds,
        },
      },
    };

    await runBacktest(child!.id, btParams, userId);
    completed++;

    const [run] = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, child!.id));
    if (!run || run.status !== "completed") return null;

    const trades = await db
      .select({ exitReason: backtestTradesTable.exitReason })
      .from(backtestTradesTable)
      .where(eq(backtestTradesTable.runId, child!.id));
    const exitReasons: Record<string, number> = {};
    for (const t of trades) {
      const r = t.exitReason ?? "unknown";
      exitReasons[r] = (exitReasons[r] ?? 0) + 1;
    }

    return {
      totalTrades: run.totalTrades ?? 0,
      winRate: Number(run.winRate ?? 0),
      profitFactor: Number(run.profitFactor ?? 0),
      sharpeRatio: Number(run.sharpeRatio ?? 0),
      maxDrawdown: Number(run.maxDrawdown ?? 0),
      totalPnl: Number(run.totalPnl ?? 0),
      exitReasons,
    };
  }

  /** Bounded-concurrency pool over a candidate list on the TRAIN window. */
  async function sweepTrain(cands: Candidate[], stageLabel: string, progressBase: number, progressSpan: number): Promise<void> {
    let idx = 0;
    let truncated = false;
    async function worker(): Promise<void> {
      for (;;) {
        if (overBudget()) { truncated = true; return; }
        const i = idx++;
        if (i >= cands.length) return;
        await setState({
          stage: `${stageLabel} ${Math.min(i + 1, cands.length)}/${cands.length}`,
          progress: progressBase + Math.round(((i + 1) / cands.length) * progressSpan),
        });
        const m = await evaluate(cands[i]!.params, req.startDate, trainEnd, stageLabel).catch((err) => {
          logger.warn({ err, autopsyId }, "Autopsy candidate backtest failed — skipping combo");
          return null;
        });
        if (m) cands[i]!.train = m;
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (truncated) await setState({ truncated: 1 });
  }

  try {
    // ── Baseline: current config on the TRAIN window ─────────────────────────
    await setState({ stage: "baseline (current config, train window)", progress: 2 });
    const currentTrain = await evaluate(currentParams, req.startDate, trainEnd, "baseline-train");

    // ── Stage 1: dollar plan sweep ───────────────────────────────────────────
    const stage1: Candidate[] = dollarPlanGrid(currentParams).map((params) => ({ params }));
    await sweepTrain(stage1, "sweeping dollar plans", 5, 45);

    const ranked1 = stage1
      .filter((c) => c.train && c.train.totalTrades >= MIN_TRAIN_TRADES)
      .sort((a, b) => b.train!.profitFactor - a.train!.profitFactor);
    const bestDollar = ranked1[0]?.params ?? currentParams;

    // ── Stage 2: confidence × hold sweep around the stage-1 winner ───────────
    const stage2: Candidate[] = overBudget() ? [] : timingGrid(bestDollar).map((params) => ({ params }));
    await sweepTrain(stage2, "sweeping confidence & hold time", 50, 25);

    // ── Validation: top train candidates + current, on the held-out window ───
    const allCands = [...ranked1, ...stage2.filter((c) => c.train && c.train.totalTrades >= MIN_TRAIN_TRADES)]
      .sort((a, b) => b.train!.profitFactor - a.train!.profitFactor)
      .slice(0, TOP_CANDIDATES);

    await setState({ stage: "walk-forward validation (held-out window)", progress: 78 });
    const currentVal = await evaluate(currentParams, trainEnd, req.endDate, "baseline-validation");
    for (const cand of allCands) {
      if (overBudget()) { await setState({ truncated: 1 }); break; }
      cand.val = (await evaluate(cand.params, trainEnd, req.endDate, "candidate-validation").catch(() => null)) ?? undefined;
    }

    // Winner = best VALIDATION profit factor among candidates that got one.
    const validated = allCands
      .filter((c) => c.val && c.val.totalTrades > 0)
      .sort((a, b) => b.val!.profitFactor - a.val!.profitFactor);
    const winner = validated[0] ?? null;

    const report = diagnose(currentParams, currentVal, winner?.params ?? null, winner?.val ?? null);

    await setState({
      status: "completed",
      progress: 100,
      stage: null,
      totalBacktests: completed,
      currentTrain,
      currentVal,
      bestParams: report.verdict === "improved" ? winner!.params : null,
      bestTrain: report.verdict === "improved" ? winner!.train ?? null : null,
      bestVal: report.verdict === "improved" ? winner!.val ?? null : null,
      verdict: report.verdict,
      diagnosis: report,
      completedAt: new Date(),
    });
    logger.info({ autopsyId, verdict: report.verdict, backtests: completed }, "AUTOPSY_COMPLETE");
  } finally {
    // Children served their purpose — metrics live on the autopsy row now.
    // Cascade removes their trades/equity/optimization rows.
    if (childRunIds.length > 0) {
      await db
        .delete(backtestRunsTable)
        .where(and(eq(backtestRunsTable.userId, userId), inArray(backtestRunsTable.id, childRunIds)))
        .catch((err: unknown) => logger.warn({ err, autopsyId }, "Autopsy child cleanup failed"));
    }
  }
}
