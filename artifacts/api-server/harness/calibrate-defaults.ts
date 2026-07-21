/**
 * TradeCore Pro — Default Strategy Calibration Harness
 *
 * Answers: "are the strategies' DEFAULT parameter values any good, and can we
 * find better ones?" — without falling into the trap that makes this
 * dangerous: overfitting the defaults to one lucky backtest window.
 *
 * METHOD — multi-window walk-forward voting:
 *   1. Split the history into N contiguous FOLDS (independent market periods).
 *   2. In EACH fold, run the same walk-forward the Optimization Autopsy uses:
 *      sweep the parameter grid on that fold's TRAIN window, then measure the
 *      winner on that fold's held-out VALIDATION window. A fold only yields a
 *      suggestion if a candidate beat the current default OUT OF SAMPLE.
 *   3. Promote a new default value ONLY when a MAJORITY of folds independently
 *      agree on the same direction. The promoted value is the median of the
 *      agreeing folds (robust to one outlier fold). A parameter that helps in
 *      one period but not the others is LEFT ALONE.
 *
 * This is the difference between calibration and curve-fitting: a value that
 * wins on 2015-style, 2020-style and 2024-style data is a real default; a
 * value that only wins on last month is noise, and this refuses to ship it.
 *
 * It PROPOSES changes to DEFAULT_STRATEGY_CONFIGS (base.ts) — it never edits
 * code or live configs. Changing a default only affects NEWLY-seeded config
 * rows, so existing users are untouched. Review the report, then apply by
 * hand (or have your reviewer apply it).
 *
 * ⚠ Run this against REAL historical data (the VPS, where ensureCandles
 * fetches Binance history). On the synthetic sandbox candles the machinery
 * runs but the trading conclusions are meaningless — see generate-data.ts.
 *
 * Usage:
 *   tsx harness/calibrate-defaults.ts \
 *     --section crypto --symbols BTCUSDT,ETHUSDT,SOLUSDT \
 *     --start 2024-01-01 --end 2024-12-31 --folds 3 [--strategy trend_pullback] [--timeframe 5m]
 */
import { db, backtestRunsTable, backtestTradesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { runBacktest, type BacktestParams } from "../src/lib/backtestEngine";
import { DEFAULT_STRATEGY_CONFIGS, strategiesForSection } from "../src/lib/strategies";
import {
  dollarPlanGrid, timingGrid, diagnose,
  type AutopsyParams, type WindowMetrics,
} from "../src/lib/autopsy/diagnose";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CALIB_USER_ID = 1; // harness user; configs come from strategyOverride, not this user's rows
const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "results");
const CONCURRENCY = 2;
const MIN_TRAIN_TRADES = 5;
const TOP_CANDIDATES = 3;
/** Params the calibrator can move (the autopsy's surface). */
const PARAM_KEYS: Array<keyof AutopsyParams> = ["maxLossUsdt", "targetProfitUsdt", "confidenceThreshold", "maxHoldingSeconds"];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

interface Fold { index: number; trainStart: Date; trainEnd: Date; valStart: Date; valEnd: Date; }

/** Split [start,end] into N contiguous folds, each split 2/3 train, 1/3 val. */
function buildFolds(start: Date, end: Date, n: number): Fold[] {
  const total = end.getTime() - start.getTime();
  const foldLen = total / n;
  const folds: Fold[] = [];
  for (let i = 0; i < n; i++) {
    const foldStart = new Date(start.getTime() + i * foldLen);
    const foldEnd = new Date(start.getTime() + (i + 1) * foldLen);
    const trainEnd = new Date(foldStart.getTime() + foldLen * (2 / 3));
    folds.push({ index: i, trainStart: foldStart, trainEnd, valStart: trainEnd, valEnd: foldEnd });
  }
  return folds;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface Ctx {
  section: "crypto" | "forex";
  symbols: string[];
  timeframe: string;
  createdRunIds: number[];
  done: number;   // backtests completed so far (live heartbeat)
  total: number;  // rough estimate for the heartbeat denominator
}

/** Run ONE candidate on ONE window through the real engine; harvest metrics.
 *  Mirrors autopsyService.evaluate but standalone (no autopsy_runs row). */
async function evaluate(
  ctx: Ctx, strategyId: string, params: AutopsyParams, windowStart: Date, windowEnd: Date,
): Promise<WindowMetrics | null> {
  const [child] = await db
    .insert(backtestRunsTable)
    .values({
      userId: CALIB_USER_ID,
      section: ctx.section,
      strategyName: `Calibration child (${strategyId})`,
      symbols: ctx.symbols.join(","),
      timeframe: ctx.timeframe,
      startDate: windowStart,
      endDate: windowEnd,
      startingBalance: "1000.00",
      params: { type: "calibration-child", strategyId, candidate: params },
      status: "pending",
    })
    .returning();
  ctx.createdRunIds.push(child!.id);

  const btParams: BacktestParams = {
    symbols: ctx.symbols,
    timeframe: ctx.timeframe,
    startDate: windowStart,
    endDate: windowEnd,
    startingBalance: 1000,
    confidenceThreshold: 0,
    stopLossPercent: 1,
    takeProfitPercent: 2,
    positionSizeUsdt: 100,
    maxOpenPositions: 5,
    dailyLossLimitUsdt: 1_000_000,
    perStrategyConfigs: true,
    ...(ctx.section === "forex" && { marketType: "forex" as const }),
    onlyStrategyId: strategyId,
    strategyOverride: {
      strategyId,
      patch: {
        maxLossUsdt: params.maxLossUsdt,
        targetProfitUsdt: params.targetProfitUsdt,
        confidenceThreshold: params.confidenceThreshold,
        maxHoldingSeconds: params.maxHoldingSeconds,
      },
    },
  };

  await runBacktest(child!.id, btParams, CALIB_USER_ID);
  // Live heartbeat so a long run never looks frozen (newline-terminated so it
  // survives line-buffering / tee / tail -f).
  ctx.done++;
  if (ctx.done % 5 === 0) console.log(`   … ${ctx.done}/~${ctx.total} backtests done`);
  const [run] = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, child!.id));
  if (!run || run.status !== "completed") return null;

  const trades = await db
    .select({ exitReason: backtestTradesTable.exitReason })
    .from(backtestTradesTable)
    .where(eq(backtestTradesTable.runId, child!.id));
  const exitReasons: Record<string, number> = {};
  for (const t of trades) { const r = t.exitReason ?? "unknown"; exitReasons[r] = (exitReasons[r] ?? 0) + 1; }

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

async function sweep(
  ctx: Ctx, strategyId: string, cands: AutopsyParams[], trainStart: Date, trainEnd: Date,
): Promise<Array<{ params: AutopsyParams; train: WindowMetrics }>> {
  const out: Array<{ params: AutopsyParams; train: WindowMetrics }> = [];
  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= cands.length) return;
      const m = await evaluate(ctx, strategyId, cands[i]!, trainStart, trainEnd).catch(() => null);
      if (m && m.totalTrades >= MIN_TRAIN_TRADES) out.push({ params: cands[i]!, train: m });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

interface FoldResult {
  fold: number;
  verdict: "improved" | "no_better" | "insufficient_data";
  currentVal: WindowMetrics | null;
  suggested: AutopsyParams | null;
  suggestedVal: WindowMetrics | null;
}

/** One fold's independent walk-forward (autopsy-lite) for one strategy. */
async function calibrateFold(ctx: Ctx, strategyId: string, current: AutopsyParams, fold: Fold): Promise<FoldResult> {
  // Stage 1: dollar-plan grid on TRAIN.
  const stage1 = await sweep(ctx, strategyId, dollarPlanGrid(current), fold.trainStart, fold.trainEnd);
  const ranked1 = stage1.sort((a, b) => b.train.profitFactor - a.train.profitFactor);
  const bestDollar = ranked1[0]?.params ?? current;
  // Stage 2: confidence × hold grid around the stage-1 winner, on TRAIN.
  const stage2 = await sweep(ctx, strategyId, timingGrid(bestDollar), fold.trainStart, fold.trainEnd);

  const topByTrain = [...ranked1, ...stage2]
    .sort((a, b) => b.train.profitFactor - a.train.profitFactor)
    .slice(0, TOP_CANDIDATES);

  // Validation on the held-out window (never used for fitting).
  const currentVal = await evaluate(ctx, strategyId, current, fold.valStart, fold.valEnd);
  const validated: Array<{ params: AutopsyParams; val: WindowMetrics }> = [];
  for (const c of topByTrain) {
    const v = await evaluate(ctx, strategyId, c.params, fold.valStart, fold.valEnd).catch(() => null);
    if (v && v.totalTrades > 0) validated.push({ params: c.params, val: v });
  }
  const winner = validated.sort((a, b) => b.val.profitFactor - a.val.profitFactor)[0] ?? null;
  const report = diagnose(current, currentVal, winner?.params ?? null, winner?.val ?? null);

  return {
    fold: fold.index,
    verdict: report.verdict,
    currentVal,
    suggested: report.verdict === "improved" ? winner!.params : null,
    suggestedVal: report.verdict === "improved" ? winner!.val : null,
  };
}

interface ParamVote { key: keyof AutopsyParams; current: number | null; promoted: number | null; agreeingFolds: number; suggestions: Array<number | null>; }

/** Promote a parameter only when a MAJORITY of folds moved it the same way. */
function aggregate(current: AutopsyParams, folds: FoldResult[]): ParamVote[] {
  const nFolds = folds.length;
  const majority = Math.floor(nFolds / 2) + 1;
  const votes: ParamVote[] = [];
  for (const key of PARAM_KEYS) {
    const cur = current[key];
    const suggestions = folds.map((f) => (f.suggested ? f.suggested[key] : null));
    // Collect folds that improved AND moved this param off current.
    const moved = folds
      .filter((f) => f.suggested && f.suggested[key] != null && cur != null && f.suggested[key] !== cur)
      .map((f) => ({ dir: Math.sign((f.suggested![key] as number) - (cur as number)), val: f.suggested![key] as number }));
    // Count agreement by direction.
    const up = moved.filter((m) => m.dir > 0).map((m) => m.val);
    const down = moved.filter((m) => m.dir < 0).map((m) => m.val);
    let promoted: number | null = null;
    let agreeing = 0;
    if (up.length >= majority && up.length >= down.length) { promoted = median(up); agreeing = up.length; }
    else if (down.length >= majority) { promoted = median(down); agreeing = down.length; }
    votes.push({ key, current: cur, promoted, agreeingFolds: agreeing, suggestions });
  }
  return votes;
}

async function main() {
  const section = (arg("section", "crypto") as "crypto" | "forex");
  const symbols = arg("symbols", section === "forex" ? "EUR_USD,GBP_USD,XAU_USD" : "BTCUSDT,ETHUSDT,SOLUSDT")!
    .split(",").map((s) => s.trim()).filter(Boolean);
  const start = new Date(arg("start", "2024-01-01T00:00:00.000Z")!);
  const end = new Date(arg("end", "2024-06-30T00:00:00.000Z")!);
  const timeframe = arg("timeframe", "5m")!;
  const nFolds = Math.max(2, Math.min(6, Number(arg("folds", "3"))));
  const onlyStrategy = arg("strategy");

  const catalog = strategiesForSection(section);
  const strategyIds = (onlyStrategy ? catalog.filter((s) => s.strategyId === onlyStrategy) : catalog).map((s) => s.strategyId);
  if (strategyIds.length === 0) throw new Error(`No such strategy in ${section} catalog: ${onlyStrategy}`);

  const folds = buildFolds(start, end, nFolds);
  // ~27 backtests per (strategy × fold): the dollar grid + timing grid on
  // train, plus baseline + top-candidate validation. Just for the heartbeat.
  const estTotal = strategyIds.length * nFolds * 27;
  const ctx: Ctx = { section, symbols, timeframe, createdRunIds: [], done: 0, total: estTotal };

  console.log(`\n═══ Default calibration — ${section} · ${symbols.join(",")} · ${timeframe} ═══`);
  console.log(`Window ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}, ${nFolds} folds`);
  console.log(`Strategies: ${strategyIds.join(", ")}`);
  console.log(`\n⏱  This runs ~${estTotal} backtests and is SLOW on real data (many minutes${strategyIds.length > 1 ? "; the whole catalog can take 30-60+ min" : ""}).`);
  console.log(`   Progress prints below as it goes — it is NOT frozen. Do not pipe through 'tail' (that hides output until it finishes).`);
  if (strategyIds.length > 1) console.log(`   Tip: run one strategy first — pass e.g. --strategy ${strategyIds[0]} (or './calibrate.sh ${section} ${strategyIds[0]}').`);
  console.log(`⚠  Only trust this on REAL data. On synthetic candles the machinery runs but conclusions are meaningless.\n`);

  const results: Array<{ strategyId: string; current: AutopsyParams; folds: FoldResult[]; votes: ParamVote[]; proposed: AutopsyParams; changed: boolean }> = [];

  for (const strategyId of strategyIds) {
    const d = DEFAULT_STRATEGY_CONFIGS[strategyId];
    if (!d) { console.log(`skip ${strategyId} (no defaults)`); continue; }
    const current: AutopsyParams = {
      maxLossUsdt: d.maxLossUsdt ?? null,
      targetProfitUsdt: d.targetProfitUsdt ?? null,
      confidenceThreshold: d.confidenceThreshold,
      maxHoldingSeconds: d.maxHoldingSeconds,
    };

    console.log(`▸ ${strategyId} — ${folds.length} folds…`);
    const foldResults: FoldResult[] = [];
    for (const fold of folds) {
      const r = await calibrateFold(ctx, strategyId, current, fold);
      foldResults.push(r);
      const mark = r.verdict === "improved" ? "▲ better config found" : r.verdict === "no_better" ? "= current is fine" : "· too few trades";
      console.log(`    fold ${fold.index + 1}/${folds.length}: ${mark}`);
    }
    const votes = aggregate(current, foldResults);
    const proposed: AutopsyParams = { ...current };
    for (const v of votes) if (v.promoted != null) (proposed[v.key] as number) = v.promoted;
    const changed = PARAM_KEYS.some((k) => proposed[k] !== current[k]);
    results.push({ strategyId, current, folds: foldResults, votes, proposed, changed });
    console.log(changed ? "→ NEW DEFAULT proposed" : "→ keep current");
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n═══ Proposed default changes (majority-of-${nFolds}-folds agreement required) ═══\n`);
  let anyChange = false;
  for (const r of results) {
    if (!r.changed) continue;
    anyChange = true;
    console.log(`● ${r.strategyId}`);
    for (const v of r.votes) {
      if (v.promoted == null) continue;
      console.log(`    ${v.key}: ${v.current} → ${v.promoted}   (${v.agreeingFolds}/${folds.length} folds agreed; per-fold: ${v.suggestions.map((s) => s ?? "—").join(", ")})`);
    }
  }
  if (!anyChange) {
    console.log("No parameter change reached majority agreement across folds — the current defaults are not measurably beaten out-of-sample.");
    console.log("That is a real, honest result: either the defaults are already reasonable, or the strategies' edge doesn't depend on these knobs in this data.");
  } else {
    console.log(`\nApply by editing DEFAULT_STRATEGY_CONFIGS in src/lib/strategies/base.ts. Changing a default only affects NEWLY-seeded config rows — existing users are untouched. Re-run to confirm the new values hold up.`);
  }

  // Clean up the child backtest rows so nobody's Backtesting list fills up.
  if (ctx.createdRunIds.length) {
    await db.delete(backtestTradesTable).where(inArray(backtestTradesTable.runId, ctx.createdRunIds));
    await db.delete(backtestRunsTable).where(inArray(backtestRunsTable.id, ctx.createdRunIds));
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, `calibration-${section}-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ section, symbols, timeframe, start, end, nFolds, results }, null, 2));
  console.log(`\nFull evidence written → ${outPath}`);
  console.log(`Backtests run: ${ctx.createdRunIds.length} (child rows cleaned up).\n`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
