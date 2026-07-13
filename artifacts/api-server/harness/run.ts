/**
 * TradeCore Pro — Backtest-Validation Harness: runner
 *
 * Runs the REAL backtest engine (runBacktest) over the seeded synthetic
 * candles in `historical_candles`, in FAITHFUL mode (each strategy uses its
 * own live config, no flattening — see backtestConfig.buildPerStrategyBacktestConfigs),
 * then reads back the metrics runBacktest computed and writes a labeled JSON
 * snapshot under harness/results/.
 *
 * Workflow:
 *   1. Run against the current engine → snapshot as "baseline".
 *   2. Make ONE alpha change (e.g. unify confidence).
 *   3. Run again → snapshot as e.g. "unified-confidence".
 *   4. `tsx harness/compare.ts baseline unified-confidence`.
 *
 * Because the data is identical and deterministic across runs, any metric
 * delta is attributable to the code change alone. (Absolute P&L on synthetic
 * data is meaningless — only the DELTA between two runs matters. See
 * generate-data.ts for the honest limitation writeup.)
 *
 * Usage:
 *   tsx harness/run.ts --label baseline [--start ISO --end ISO]
 *                      [--symbols BTCUSDT,ETHUSDT,SOLUSDT] [--balance 1000]
 */
import { db, backtestRunsTable, backtestTradesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { runBacktest, type BacktestParams } from "../src/lib/backtestEngine";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_USER_ID = 1;
const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "results");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const label = arg("label");
  if (!label) throw new Error("--label is required (e.g. --label baseline)");

  // Defaults line up with generate-data.ts's printed window (14d ending
  // 2025-06-01, 3.5d pre-roll). Override with --start/--end for other data.
  const start = new Date(arg("start", "2025-05-21T12:00:00.000Z")!);
  const end = new Date(arg("end", "2025-06-01T00:00:00.000Z")!);
  const symbols = arg("symbols", "BTCUSDT,ETHUSDT,SOLUSDT")!.split(",").map((s) => s.trim());
  const startingBalance = Number(arg("balance", "1000"));
  // Optional futures leverage modeling: --market futures --leverage 10
  const marketType = (arg("market", "spot") as "spot" | "futures");
  const leverage = Number(arg("leverage", "1"));
  // Optional faithful-mode R:R reshape: --rr 3 → TP = each strategy's SL × 3
  const rrRatio = Number(arg("rr", "0"));
  // Optional pure exits: --pure → no TP1/break-even/trailing (full SL/TP only)
  const pureExits = process.argv.includes("--pure");
  // Optional swing profile: --hold 24 → every strategy's max hold × 24
  const holdMultiplier = Number(arg("hold", "1"));

  const params: BacktestParams = {
    symbols,
    timeframe: "1m",
    startDate: start,
    endDate: end,
    startingBalance,
    // In faithful mode these run-level values are ignored per-strategy, but
    // BacktestParams still requires them; leave as harmless placeholders.
    confidenceThreshold: 0,
    stopLossPercent: 1.5,
    takeProfitPercent: 2.5,
    positionSizeUsdt: 50,
    maxOpenPositions: 5,
    dailyLossLimitUsdt: 100,
    riskPercent: 0,
    perStrategyConfigs: true, // ← faithful: each strategy uses its own config
    rrRatio,
    pureExits,
    holdMultiplier,
    marketType,
    leverage,
  };

  const [run] = await db
    .insert(backtestRunsTable)
    .values({
      userId: HARNESS_USER_ID,
      symbols: symbols.join(","),
      timeframe: "1m",
      startDate: start,
      endDate: end,
      startingBalance: startingBalance.toFixed(2),
      params: params as unknown as object,
      status: "pending",
    })
    .returning();

  console.log(`[harness] running backtest #${run!.id} (label="${label}")`);
  console.log(`[harness] ${symbols.join(", ")} · ${start.toISOString()} → ${end.toISOString()}`);
  const t0 = Date.now();
  await runBacktest(run!.id, params, HARNESS_USER_ID);
  console.log(`[harness] simulation finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ── Read back what runBacktest computed ───────────────────────────────────
  const [r] = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, run!.id));
  if (!r || r.status !== "completed") {
    throw new Error(`Backtest did not complete (status=${r?.status}, error=${r?.error ?? "none"})`);
  }

  const exitReasons = await db
    .select({ reason: backtestTradesTable.exitReason, n: sql<number>`count(*)::int` })
    .from(backtestTradesTable)
    .where(eq(backtestTradesTable.runId, run!.id))
    .groupBy(backtestTradesTable.exitReason);

  const sides = await db
    .select({ side: backtestTradesTable.side, n: sql<number>`count(*)::int` })
    .from(backtestTradesTable)
    .where(eq(backtestTradesTable.runId, run!.id))
    .groupBy(backtestTradesTable.side);

  const snapshot = {
    label,
    generatedAt: new Date().toISOString(),
    window: { start: start.toISOString(), end: end.toISOString(), symbols },
    metrics: {
      totalTrades: r.totalTrades,
      winningTrades: r.winningTrades,
      losingTrades: r.losingTrades,
      winRate: num(r.winRate),
      totalPnl: num(r.totalPnl),
      totalReturn: num(r.totalReturn),
      endingBalance: num(r.endingBalance),
      profitFactor: num(r.profitFactor),
      sharpeRatio: num(r.sharpeRatio),
      sortinoRatio: num(r.sortinoRatio),
      maxDrawdown: num(r.maxDrawdown),
      expectancy: num(r.expectancy),
      averageWin: num(r.averageWin),
      averageLoss: num(r.averageLoss),
      largestWin: num(r.largestWin),
      largestLoss: num(r.largestLoss),
      tp1HitRate: num(r.tp1HitRate),
      tp2HitRate: num(r.tp2HitRate),
      breakEvenRate: num(r.breakEvenRate),
      trailingStopRate: num(r.trailingStopRate),
    },
    exitReasons: Object.fromEntries(exitReasons.map((e) => [e.reason ?? "unknown", e.n])),
    sides: Object.fromEntries(sides.map((s) => [s.side, s.n])),
    strategyComparison: r.strategyComparison ?? [],
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, `${label}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  printSummary(snapshot);
  console.log(`\n[harness] snapshot written → ${outPath}`);

  await (await import("@workspace/db")).pool.end();
}

function num(v: string | number | null): number | null {
  return v == null ? null : Number(v);
}

function printSummary(s: any) {
  const m = s.metrics;
  console.log(`\n──────── ${s.label} ────────`);
  console.log(`  trades            ${m.totalTrades ?? 0}  (W ${m.winningTrades ?? 0} / L ${m.losingTrades ?? 0})`);
  console.log(`  win rate          ${pct(m.winRate)}`);
  console.log(`  net P&L           ${fix(m.totalPnl)}   (return ${pct(m.totalReturn)})`);
  console.log(`  profit factor     ${fix(m.profitFactor)}`);
  console.log(`  expectancy/trade  ${fix(m.expectancy)}`);
  console.log(`  max drawdown      ${pct(m.maxDrawdown)}`);
  console.log(`  Sharpe / Sortino  ${fix(m.sharpeRatio)} / ${fix(m.sortinoRatio)}`);
  console.log(`  avg win / loss    ${fix(m.averageWin)} / ${fix(m.averageLoss)}`);
  console.log(`  exit reasons      ${JSON.stringify(s.exitReasons)}`);
  console.log(`  sides             ${JSON.stringify(s.sides)}`);
}
function fix(v: number | null): string { return v == null ? "—" : v.toFixed(4); }
function pct(v: number | null): string { return v == null ? "—" : `${(v * 100).toFixed(2)}%`; }

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
