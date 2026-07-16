/**
 * Backtest API routes
 *
 * GET    /backtests                 — list all runs
 * GET    /backtests/:id             — full run detail (trades + equity curve)
 * POST   /backtests/run             — start a new backtest (async)
 * POST   /backtests/preview-config  — compute the effective per-strategy config WITHOUT running a backtest
 * POST   /backtests/optimize        — start parameter optimization (async)
 * DELETE /backtests/:id             — delete run and all associated data
 * GET    /backtests/:id/export      — export trades as CSV, JSON, or HTML report
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  backtestRunsTable,
  backtestTradesTable,
  backtestTradePartialExitsTable,
  equityCurveTable,
  optimizationResultsTable,
} from "@workspace/db";
import { and, eq, desc, asc } from "drizzle-orm";
import { runBacktest, cancelBacktestRun, getTimeframeMs } from "../lib/backtestEngine";
import { runOptimization } from "../lib/optimizer";
import { loadStrategyConfigs } from "../lib/strategyConfigLoader";
import { buildEffectiveBacktestConfigs } from "../lib/backtestConfig";
import { minViableTakeProfitPercent, DEFAULT_FEE_RATE, FUTURES_FEE_RATE, DEFAULT_SLIPPAGE_RATE, DEFAULT_MAKER_FEE_RATE, FUTURES_MAKER_FEE_RATE } from "../lib/tradingCosts";
import { planDollarRiskFractions } from "../lib/dollarRisk";
import { logger } from "../lib/logger";

const router = Router();

const VALID_TIMEFRAMES = new Set(["1m","3m","5m","15m","30m","1h","4h","1d"]);

// ---------------------------------------------------------------------------
// GET /backtests
// ---------------------------------------------------------------------------

router.get("/backtests", async (req, res) => {
  const runs = await db
    .select()
    .from(backtestRunsTable)
    .where(eq(backtestRunsTable.userId, req.userId!))
    .orderBy(desc(backtestRunsTable.createdAt));
  res.json(runs.map(serializeRun));
});

// ---------------------------------------------------------------------------
// GET /backtests/:id
// ---------------------------------------------------------------------------

router.get("/backtests/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [run] = await db
    .select()
    .from(backtestRunsTable)
    .where(and(eq(backtestRunsTable.id, id), eq(backtestRunsTable.userId, req.userId!)));
  if (!run) return res.status(404).json({ error: "Run not found" });

  const [trades, equity, optimizations] = await Promise.all([
    db
      .select()
      .from(backtestTradesTable)
      .where(eq(backtestTradesTable.runId, id))
      .orderBy(asc(backtestTradesTable.entryTime)),
    db
      .select()
      .from(equityCurveTable)
      .where(eq(equityCurveTable.runId, id))
      .orderBy(asc(equityCurveTable.timestamp)),
    db
      .select()
      .from(optimizationResultsTable)
      .where(eq(optimizationResultsTable.runId, id))
      .orderBy(desc(optimizationResultsTable.score)),
  ]);

  return res.json({
    run: serializeRun(run),
    trades: trades.map(serializeTrade),
    equityCurve: equity.map((p) => ({
      timestamp: p.timestamp,
      balance: Number(p.balance),
      drawdown: Number(p.drawdown),
    })),
    optimizationResults: optimizations.map((o) => ({
      id: o.id,
      parameterSet: o.parameterSet,
      score: Number(o.score ?? 0),
      winRate: Number(o.winRate ?? 0),
      pnl: Number(o.pnl ?? 0),
      drawdown: Number(o.drawdown ?? 0),
      profitFactor: Number(o.profitFactor ?? 0),
      totalTrades: o.totalTrades ?? 0,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /backtests/preview-config
//
// Bug-fix feature: lets the Backtest UI show the "Effective Backtest
// Configuration" BEFORE the user clicks Run, by applying the exact same
// override logic runBacktest() itself uses (buildEffectiveBacktestConfigs)
// against the current live strategy_configs, without creating a run or
// touching any historical data. Pass the same override fields the run form
// collects; anything omitted falls back to the same defaults /backtests/run
// uses.
// ---------------------------------------------------------------------------

router.post("/backtests/preview-config", async (req, res) => {
  const b = req.body as Record<string, unknown>;

  const params = {
    confidenceThreshold: Number(b.confidenceThreshold ?? 65),
    stopLossPercent: Number(b.stopLossPercent ?? 1.5),
    takeProfitPercent: Number(b.takeProfitPercent ?? 2.5),
    riskPercent: Number(b.riskPercent ?? 0),
  };

  const dbConfigs = await loadStrategyConfigs(req.userId!);
  const effective = buildEffectiveBacktestConfigs(dbConfigs, params);

  res.json({
    runLevelOverrides: effective.runLevelOverrides,
    strategies: effective.summary,
  });
});

// ---------------------------------------------------------------------------
// POST /backtests/run
// ---------------------------------------------------------------------------

router.post("/backtests/run", async (req, res) => {
  const b = req.body as Record<string, unknown>;

  // Validate required fields
  if (!Array.isArray(b.symbols) || b.symbols.length === 0) {
    return res.status(400).json({ error: "symbols must be a non-empty array" });
  }
  if (typeof b.timeframe !== "string" || !VALID_TIMEFRAMES.has(b.timeframe)) {
    return res.status(400).json({ error: `timeframe must be one of: ${[...VALID_TIMEFRAMES].join(",")}` });
  }
  if (!b.startDate || !b.endDate) {
    return res.status(400).json({ error: "startDate and endDate are required" });
  }

  const startDate = new Date(b.startDate as string);
  const endDate = new Date(b.endDate as string);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return res.status(400).json({ error: "Invalid date format" });
  }
  if (startDate >= endDate) {
    return res.status(400).json({ error: "startDate must be before endDate" });
  }

  const symbols = (b.symbols as string[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const startingBalance = Number(b.startingBalance ?? 1000);
  const confidenceThreshold = Number(b.confidenceThreshold ?? 65);
  const stopLossPercent = Number(b.stopLossPercent ?? 1.5);
  const takeProfitPercent = Number(b.takeProfitPercent ?? 2.5);
  const positionSizeUsdt = Number(b.positionSizeUsdt ?? 10);
  const maxOpenPositions = Number(b.maxOpenPositions ?? 5);
  const dailyLossLimitUsdt = Number(b.dailyLossLimitUsdt ?? 50);
  const riskPercent = Number(b.riskPercent ?? 0);
  const marketType = b.marketType === "futures" ? "futures" : "spot";
  // Default the fee to the market being simulated: Binance USDⓈ-M taker is
  // 0.05%, half of spot's 0.1% — assuming spot fees for a futures run
  // overstates round-trip costs 2×. An explicit feeRate still wins.
  const feeRate = Number(b.feeRate ?? (marketType === "futures" ? FUTURES_FEE_RATE : DEFAULT_FEE_RATE));
  const slippageRate = Number(b.slippageRate ?? DEFAULT_SLIPPAGE_RATE);
  // Maker modeling is a single opt-in. When OFF, every fill is taker exactly
  // as before (makerFeeRate === feeRate) so existing baselines are unchanged.
  // When ON: entries post as maker limits (honest fill/miss) AND passive exits
  // (take-profit limits) are charged the maker rate. An explicit makerFeeRate
  // always wins.
  const makerEntry = b.makerEntry === true;
  const makerFeeRate = b.makerFeeRate !== undefined
    ? Number(b.makerFeeRate)
    : (makerEntry ? (marketType === "futures" ? FUTURES_MAKER_FEE_RATE : DEFAULT_MAKER_FEE_RATE) : feeRate);
  const makerEntryFillWindowMinutes = Math.max(1, Math.min(1440, Number(b.makerEntryFillWindowMinutes ?? 30) || 30));
  const leverage = Math.max(1, Math.min(125, Math.floor(Number(b.leverage ?? 1)) || 1));
  const marginMode = b.marginMode === "cross" ? "cross" : "isolated";
  // Dollar risk model (Phase 8): size each trade from a fixed max-loss/target-
  // profit using the same planner as live. Percent (default) leaves behavior
  // unchanged. maxLossUsdt/targetProfitUsdt only matter in dollar mode.
  const riskModel = b.riskModel === "dollar" ? "dollar" : "percent";
  const maxLossUsdt = Math.max(0, Number(b.maxLossUsdt ?? 0) || 0);
  const targetProfitUsdt = Math.max(0, Number(b.targetProfitUsdt ?? 0) || 0);
  // Single-strategy test: run just this strategy with its own saved config.
  const onlyStrategyId = typeof b.onlyStrategyId === "string" && b.onlyStrategyId
    ? b.onlyStrategyId : undefined;
  // Faithful mode (default): each strategy uses its OWN SL/TP/confidence — what
  // the live bot trades — instead of flattening every strategy to the form's
  // single SL/TP. Only when explicitly false does the flat form override apply
  // (a single-config sweep). See backtestConfig.ts. Isolating one strategy
  // ALWAYS uses its own saved config — testing a strategy against flat
  // overrides it doesn't use would be meaningless.
  const perStrategyConfigs = onlyStrategyId ? true : b.perStrategyConfigs !== false;
  // Faithful-mode R:R reshape: TP = each strategy's own SL × ratio (0 = off).
  const rrRatio = Math.max(0, Math.min(10, Number(b.rrRatio ?? 0) || 0));
  // Faithful-mode pure exits: no TP1/break-even/trailing — full SL/TP only.
  const pureExits = b.pureExits === true;
  // Faithful-mode swing profile: every strategy's maxHoldingSeconds × this.
  const holdMultiplier = Math.max(0.1, Math.min(100, Number(b.holdMultiplier ?? 1) || 1));

  // Phase 6 audit Finding B fix: this exact route produced the bt6 scenario
  // — a takeProfitPercent (0.25%) smaller than round-trip trading costs,
  // guaranteeing a net loss on every winning trade (confirmed empirically:
  // 30/30 take-profit exits were net losers with identical P&L). Reject
  // rather than silently run a backtest that can't possibly be profitable
  // regardless of strategy quality.
  // In percent mode the run-level takeProfitPercent must clear round-trip costs;
  // in dollar mode SL/TP come from the dollar plan instead, so skip this check
  // and validate the dollar plan below.
  if (riskModel === "percent") {
    const minViableTp = minViableTakeProfitPercent(feeRate, slippageRate);
    if (takeProfitPercent < minViableTp) {
      return res.status(400).json({
        error: `takeProfitPercent (${takeProfitPercent}%) is below round-trip trading costs (${minViableTp.toFixed(3)}% at feeRate=${feeRate}, slippageRate=${slippageRate}) — every winning trade would still be a net loss. Raise takeProfitPercent or lower feeRate/slippageRate.`,
      });
    }
  } else {
    // Dollar mode: reject up-front (with the concrete fix) rather than silently
    // producing a tradeless run when the plan can't place a safe stop.
    if (!(maxLossUsdt > 0) || !(targetProfitUsdt > 0)) {
      return res.status(400).json({ error: "Dollar risk model requires maxLossUsdt and targetProfitUsdt to be greater than 0." });
    }
    const plan = planDollarRiskFractions({
      marketType, tradeAmountUsdt: positionSizeUsdt, leverage, maxLossUsdt, targetProfitUsdt, feeRate,
    });
    if (!plan.feasible || !plan.safe) {
      return res.status(400).json({
        error: plan.suggestion ?? plan.warnings[0] ?? "Dollar risk plan is not placeable with these settings.",
      });
    }
  }

  // Phase 6 audit Finding A/E: maxHoldingSeconds shorter than (or close to)
  // the selected primary timeframe's candle interval means the position is
  // guaranteed (or near-guaranteed) to time out before a single genuine
  // SL/TP check can produce a meaningful result — this was the dominant
  // failure mode across every backtest in the audit. Warn (don't block —
  // a deliberately short backtest for a single fast strategy is legitimate)
  // so the result isn't silently misread as "the strategy doesn't work"
  // when it's really "this timeframe can't resolve trades in time."
  const candleIntervalMs = getTimeframeMs(b.timeframe as string);
  const dbStrategyConfigsForWarning = await loadStrategyConfigs(req.userId!);
  const timeframeWarnings: string[] = [];
  for (const [, cfg] of dbStrategyConfigsForWarning) {
    if (!cfg.enabled) continue;
    const maxHoldingMs = cfg.maxHoldingSeconds * 1000;
    if (maxHoldingMs <= candleIntervalMs) {
      timeframeWarnings.push(
        `${cfg.strategyId ?? "strategy"}: maxHoldingSeconds=${cfg.maxHoldingSeconds}s ≤ the ${b.timeframe} candle interval (${candleIntervalMs / 1000}s) — every trade from this strategy will time out before a single SL/TP check can run. Consider a finer primary timeframe or a longer maxHoldingSeconds.`,
      );
    }
  }
  if (timeframeWarnings.length > 0) {
    logger.warn({ timeframe: b.timeframe, timeframeWarnings }, "BACKTEST_TIMEFRAME_MISMATCH_WARNING");
  }

  const [run] = await db
    .insert(backtestRunsTable)
    .values({
      userId: req.userId!,
      symbols: symbols.join(","),
      timeframe: b.timeframe,
      startDate,
      endDate,
      startingBalance: startingBalance.toFixed(2),
      params: b,
      status: "pending",
      ...(timeframeWarnings.length > 0 && { timeframeWarnings }),
    })
    .returning();

  // Fire-and-forget — run in background
  runBacktest(run.id, {
    symbols,
    timeframe: b.timeframe,
    startDate,
    endDate,
    startingBalance,
    confidenceThreshold,
    stopLossPercent,
    takeProfitPercent,
    positionSizeUsdt,
    maxOpenPositions,
    dailyLossLimitUsdt,
    riskPercent,
    feeRate,
    makerFeeRate,
    makerEntry,
    makerEntryFillWindowMinutes,
    slippageRate,
    marketType,
    leverage,
    marginMode,
    riskModel,
    maxLossUsdt,
    targetProfitUsdt,
    onlyStrategyId,
    perStrategyConfigs,
    rrRatio,
    pureExits,
    holdMultiplier,
  }, req.userId!).catch((err) => {
    logger.error({ err, runId: run.id }, "Background backtest error");
  });

  return res.status(202).json({ runId: run.id, status: "pending" });
});

// ---------------------------------------------------------------------------
// POST /backtests/optimize
// ---------------------------------------------------------------------------

router.post("/backtests/optimize", async (req, res) => {
  const b = req.body as Record<string, unknown>;

  if (!Array.isArray(b.symbols) || b.symbols.length === 0) {
    return res.status(400).json({ error: "symbols must be a non-empty array" });
  }
  if (typeof b.timeframe !== "string" || !VALID_TIMEFRAMES.has(b.timeframe)) {
    return res.status(400).json({ error: "Invalid timeframe" });
  }
  if (!b.startDate || !b.endDate) {
    return res.status(400).json({ error: "startDate and endDate are required" });
  }

  const startDate = new Date(b.startDate as string);
  const endDate = new Date(b.endDate as string);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return res.status(400).json({ error: "Invalid date format" });
  }

  const symbols = (b.symbols as string[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const startingBalance = Number(b.startingBalance ?? 1000);

  // Phase 6 audit Finding B fix — same floor as /backtests/run, applied to
  // every value in the grid: silently letting an optimizer sweep include a
  // guaranteed-net-loss takeProfitPercent wastes a slot in the results table
  // on a combination that can never win.
  const requestedFeeRate = Number(b.feeRate ?? DEFAULT_FEE_RATE);
  const requestedSlippageRate = Number(b.slippageRate ?? DEFAULT_SLIPPAGE_RATE);
  const minViableTp = minViableTakeProfitPercent(requestedFeeRate, requestedSlippageRate);
  const rawTpGrid = Array.isArray(b.takeProfitPercents) ? (b.takeProfitPercents as number[]) : undefined;
  const invalidTps = rawTpGrid?.filter((tp) => tp < minViableTp) ?? [];
  if (invalidTps.length > 0) {
    return res.status(400).json({
      error: `takeProfitPercents contains value(s) below round-trip trading costs (${minViableTp.toFixed(3)}%): ${invalidTps.join(", ")}. Every trade at these values would be a net loss even when "right." Remove them or raise them.`,
    });
  }

  const [parentRun] = await db
    .insert(backtestRunsTable)
    .values({
      userId: req.userId!,
      strategyName: "TradeCore v1 (Optimization)",
      symbols: symbols.join(","),
      timeframe: b.timeframe,
      startDate,
      endDate,
      startingBalance: startingBalance.toFixed(2),
      params: { ...b, type: "optimization" },
      status: "pending",
    })
    .returning();

  runOptimization(parentRun.id, {
    symbols,
    timeframe: b.timeframe,
    startDate,
    endDate,
    startingBalance,
    confidenceThresholds: Array.isArray(b.confidenceThresholds) ? b.confidenceThresholds as number[] : undefined,
    stopLossPercents: Array.isArray(b.stopLossPercents) ? b.stopLossPercents as number[] : undefined,
    takeProfitPercents: rawTpGrid,
    positionSizeUsdts: Array.isArray(b.positionSizeUsdts) ? b.positionSizeUsdts as number[] : undefined,
    rankBy: (b.rankBy as any) ?? "profitFactor",
  }, req.userId!).catch((err) => {
    logger.error({ err, runId: parentRun.id }, "Background optimizer error");
  });

  return res.status(202).json({ runId: parentRun.id, status: "pending" });
});

// ---------------------------------------------------------------------------
// DELETE /backtests/:id
// ---------------------------------------------------------------------------

router.delete("/backtests/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  cancelBacktestRun(id);

  const deleted = await db
    .delete(backtestRunsTable)
    .where(and(eq(backtestRunsTable.id, id), eq(backtestRunsTable.userId, req.userId!)))
    .returning();

  if (deleted.length === 0) return res.status(404).json({ error: "Run not found" });

  return res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// GET /backtests/:id/export
// ---------------------------------------------------------------------------

router.get("/backtests/:id/export", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const format = (req.query.format as string) || "json";

  const [run] = await db
    .select()
    .from(backtestRunsTable)
    .where(and(eq(backtestRunsTable.id, id), eq(backtestRunsTable.userId, req.userId!)));
  if (!run) return res.status(404).json({ error: "Run not found" });

  const trades = await db
    .select()
    .from(backtestTradesTable)
    .where(eq(backtestTradesTable.runId, id))
    .orderBy(asc(backtestTradesTable.entryTime));

  if (format === "csv") {
    const headers = [
      "symbol","side","strategyId","strategyName","entryTime","exitTime","entryPrice","exitPrice",
      "quantity","stopLoss","takeProfit","slPercent","tpPercent","fees","slippage",
      "pnl","grossPnl","pnlPercent","confidence","exitReason","durationSeconds",
      "mfe","mae","riskReward",
      "tp1Filled","tp1Price","tp1FillPrice","tp2Filled","tp2Price","tp2FillPrice",
      "breakEvenActive","trailingStopActive","trailingStopMode",
    ];
    const rows = trades.map((t) => {
      const entryPrice = Number(t.entryPrice);
      const slPercent = entryPrice > 0 ? ((entryPrice - Number(t.stopLoss)) / entryPrice) * 100 : null;
      const tpPercent = entryPrice > 0 ? ((Number(t.takeProfit) - entryPrice) / entryPrice) * 100 : null;
      const derived: Record<string, unknown> = { ...t, slPercent: slPercent?.toFixed(3), tpPercent: tpPercent?.toFixed(3) };
      return headers
        .map((h) => {
          const val = derived[h];
          return val instanceof Date ? val.toISOString() : String(val ?? "");
        })
        .join(",");
    });
    // Effective-config header block (always know exactly which values were
    // used, even from a raw CSV — Stop Loss %/Take Profit % now, not ATR).
    // Phase 6 audit Finding D fix: previously this omitted timeframe,
    // symbols, date range, and starting balance entirely — reproducing
    // *which* backtest produced a given CSV required inferring the primary
    // timeframe from trade-duration granularity, which is exactly what this
    // audit had to do by hand. All of this was already on `run`; it just
    // wasn't being written out.
    const effRun = serializeRun(run);
    const effConfig = effRun.effectiveConfig as { summary?: any[]; runLevelOverrides?: any } | null;
    const configLines = [
      "# Effective Backtest Configuration",
      `# timeframe=${run.timeframe}, symbols=${run.symbols}, startDate=${run.startDate.toISOString()}, endDate=${run.endDate.toISOString()}, startingBalance=${run.startingBalance}`,
    ];
    if (effConfig?.runLevelOverrides) {
      const o = effConfig.runLevelOverrides;
      configLines.push(
        `# stopLossPercent=${o.stopLossPercent}, takeProfitPercent=${o.takeProfitPercent}, confidenceThreshold=${o.confidenceThreshold}, riskPercentOverride=${o.riskPercentOverride ?? "none (per-strategy)"}`,
      );
    }
    for (const s of effConfig?.summary ?? []) {
      configLines.push(
        `# ${s.strategyName}: stopLossPercent=${s.effective.stopLossPercent}, takeProfitPercent=${s.effective.takeProfitPercent}, confidenceThreshold=${s.effective.confidenceThreshold}, riskPercent=${s.effective.riskPercent} (${s.riskPercentSource})`,
      );
    }
    if (Array.isArray(run.timeframeWarnings) && run.timeframeWarnings.length > 0) {
      configLines.push("# ⚠ TIMEFRAME WARNINGS:");
      for (const w of run.timeframeWarnings as string[]) configLines.push(`#   ${w}`);
    }
    configLines.push("#");

    const csv = [...configLines, headers.join(","), ...rows].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="backtest_${id}_trades.csv"`
    );
    return res.send(csv);
  }

  if (format === "html") {
    const html = renderHtmlReport(serializeRun(run), trades.map(serializeTrade));
    res.setHeader("Content-Type", "text/html");
    return res.send(html);
  }

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="backtest_${id}.json"`
  );
  return res.json({ run: serializeRun(run), trades: trades.map(serializeTrade) });
});

// ---------------------------------------------------------------------------
// HTML report renderer
// ---------------------------------------------------------------------------

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

function pct(n: number | null): string {
  return n != null ? `${(n * 100).toFixed(2)}%` : "—";
}

function money(n: number | null): string {
  return n != null ? n.toFixed(2) : "—";
}

function renderHtmlReport(run: ReturnType<typeof serializeRun>, trades: ReturnType<typeof serializeTrade>[]): string {
  const strategyRows = (run.strategyComparison as any[])
    .map(
      (s) => `<tr><td>${esc(s.strategyName)}</td><td>${s.trades}</td><td>${pct(s.winRate)}</td>
        <td class="${s.pnl >= 0 ? "pos" : "neg"}">${money(s.pnl)}</td><td>${s.profitFactor.toFixed(2)}</td></tr>`
    )
    .join("");

  const effConfig = (run.effectiveConfig as { summary?: any[]; runLevelOverrides?: any } | null) ?? null;
  const effectiveConfigRows = (effConfig?.summary ?? [])
    .map(
      (s) => `<tr><td>${esc(s.strategyName)}</td>
        <td>${s.db.stopLossPercent}% → ${s.effective.stopLossPercent}%</td>
        <td>${s.db.takeProfitPercent}% → ${s.effective.takeProfitPercent}%</td>
        <td>${s.db.confidenceThreshold} → ${s.effective.confidenceThreshold}</td>
        <td>${s.db.riskPercent} → ${s.effective.riskPercent}</td>
        <td>${esc(s.riskPercentSource)}</td></tr>`
    )
    .join("");

  const tradeRows = trades
    .map(
      (t) => `<tr>
        <td>${esc(t.symbol)}</td>
        <td>${esc(t.strategyName ?? "—")}</td>
        <td>${new Date(t.entryTime).toLocaleString()}</td>
        <td>${t.exitTime ? new Date(t.exitTime).toLocaleString() : "—"}</td>
        <td>${money(t.entryPrice)}</td><td>${money(t.exitPrice)}</td>
        <td>${t.slPercent != null ? t.slPercent.toFixed(2) + "%" : "—"}</td>
        <td>${t.tpPercent != null ? t.tpPercent.toFixed(2) + "%" : "—"}</td>
        <td>${esc(t.exitReason)}</td>
        <td>${[t.tp1Filled && "TP1", t.tp2Filled && "TP2", t.breakEvenActive && "BE", t.trailingStopActive && "Trail"].filter(Boolean).join(" → ") || "—"}</td>
        <td class="${(t.pnl ?? 0) >= 0 ? "pos" : "neg"}">${money(t.pnl)}</td>
        <td>${t.riskReward != null ? t.riskReward.toFixed(2) : "—"}</td>
        <td>${money(t.mfe)}</td><td>${money(t.mae)}</td>
      </tr>`
    )
    .join("");

  const timeframeWarningsHtml = (run.timeframeWarnings as string[] ?? []).length > 0
    ? `<div style="background:#fff3cd;border:1px solid #ffe69c;border-radius:8px;padding:12px 16px;margin-bottom:1.5rem;font-size:0.85rem;">
        <strong>⚠ Timeframe warnings</strong>
        <ul style="margin:6px 0 0 0;padding-left:1.2rem;">
          ${(run.timeframeWarnings as string[]).map((w) => `<li>${esc(w)}</li>`).join("")}
        </ul>
      </div>`
    : "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Backtest Report #${run.id} — ${esc(run.strategyName)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; color: #1a1a1a; background: #fafafa; }
  h1 { margin-bottom: 0.2rem; }
  .subtitle { color: #666; margin-bottom: 1.5rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 2rem; }
  .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px 16px; }
  .card .label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.03em; }
  .card .value { font-size: 1.4rem; font-weight: 600; margin-top: 4px; }
  table { border-collapse: collapse; width: 100%; background: #fff; margin-bottom: 2rem; }
  th, td { border: 1px solid #e5e5e5; padding: 6px 10px; font-size: 0.85rem; text-align: right; }
  th { background: #f2f2f2; text-align: right; }
  td:first-child, th:first-child { text-align: left; }
  .pos { color: #0a7a2f; } .neg { color: #b3261e; }
  h2 { margin-top: 2.5rem; }
</style></head>
<body>
  <h1>Backtest Report #${run.id}</h1>
  <div class="subtitle">${esc(run.strategyName)} · ${esc(run.symbols.join(", "))} · ${esc(run.timeframe)} ·
    ${new Date(run.startDate).toLocaleDateString()} – ${new Date(run.endDate).toLocaleDateString()}</div>

  ${timeframeWarningsHtml}

  <div class="grid">
    <div class="card"><div class="label">Total Return</div><div class="value">${pct(run.totalReturn)}</div></div>
    <div class="card"><div class="label">Total P/L</div><div class="value">${money(run.totalPnl)}</div></div>
    <div class="card"><div class="label">Win Rate</div><div class="value">${pct(run.winRate)}</div></div>
    <div class="card"><div class="label">Profit Factor</div><div class="value">${run.profitFactor?.toFixed(2) ?? "—"}</div></div>
    <div class="card"><div class="label">Expectancy</div><div class="value">${money(run.expectancy)}</div></div>
    <div class="card"><div class="label">Max Drawdown</div><div class="value">${pct(run.maxDrawdown)}</div></div>
    <div class="card"><div class="label">Sharpe</div><div class="value">${run.sharpeRatio?.toFixed(2) ?? "—"}</div></div>
    <div class="card"><div class="label">Sortino</div><div class="value">${run.sortinoRatio?.toFixed(2) ?? "—"}</div></div>
    <div class="card"><div class="label">Largest Win</div><div class="value pos">${money(run.largestWin)}</div></div>
    <div class="card"><div class="label">Largest Loss</div><div class="value neg">${money(run.largestLoss)}</div></div>
    <div class="card"><div class="label">Avg Win / Loss</div><div class="value">${money(run.averageWin)} / ${money(run.averageLoss)}</div></div>
    <div class="card"><div class="label">Total Trades</div><div class="value">${run.totalTrades ?? 0}</div></div>
    <div class="card"><div class="label">TP1 Hit Rate</div><div class="value">${pct(run.tp1HitRate)}</div></div>
    <div class="card"><div class="label">TP2 Hit Rate</div><div class="value">${pct(run.tp2HitRate)}</div></div>
    <div class="card"><div class="label">Break-even Rate</div><div class="value">${pct(run.breakEvenRate)}</div></div>
    <div class="card"><div class="label">Trailing-Stop Rate</div><div class="value">${pct(run.trailingStopRate)}</div></div>
  </div>

  <h2>Effective Backtest Configuration</h2>
  <p style="color:#666;font-size:0.85rem;margin-top:-0.5rem">
    Values shown as "database value → effective value" — the effective value is what this run actually used.
  </p>
  <table>
    <thead><tr><th>Strategy</th><th>Stop Loss %</th><th>Take Profit %</th><th>Confidence ≥</th><th>Risk %</th><th>Risk % source</th></tr></thead>
    <tbody>${effectiveConfigRows || `<tr><td colspan="6">No effective config recorded for this run</td></tr>`}</tbody>
  </table>

  <h2>Strategy Comparison</h2>
  <table>
    <thead><tr><th>Strategy</th><th>Trades</th><th>Win Rate</th><th>P/L</th><th>Profit Factor</th></tr></thead>
    <tbody>${strategyRows || `<tr><td colspan="5">No trades</td></tr>`}</tbody>
  </table>

  <h2>Trades (${trades.length})</h2>
  <table>
    <thead><tr>
      <th>Symbol</th><th>Strategy</th><th>Entry</th><th>Exit</th><th>Entry $</th><th>Exit $</th>
      <th>SL %</th><th>TP %</th><th>Reason</th><th>Stage</th><th>P/L</th><th>R:R</th><th>MFE</th><th>MAE</th>
    </tr></thead>
    <tbody>${tradeRows || `<tr><td colspan="14">No trades</td></tr>`}</tbody>
  </table>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function serializeRun(run: typeof backtestRunsTable.$inferSelect) {
  return {
    id: run.id,
    strategyVersion: run.strategyVersion,
    strategyName: run.strategyName,
    symbols: run.symbols.split(","),
    timeframe: run.timeframe,
    startDate: run.startDate,
    endDate: run.endDate,
    startingBalance: Number(run.startingBalance),
    endingBalance: run.endingBalance != null ? Number(run.endingBalance) : null,
    totalReturn: run.totalReturn != null ? Number(run.totalReturn) : null,
    totalPnl: run.totalPnl != null ? Number(run.totalPnl) : null,
    totalTrades: run.totalTrades,
    winningTrades: run.winningTrades,
    losingTrades: run.losingTrades,
    winRate: run.winRate != null ? Number(run.winRate) : null,
    profitFactor: run.profitFactor != null ? Number(run.profitFactor) : null,
    sharpeRatio: run.sharpeRatio != null ? Number(run.sharpeRatio) : null,
    sortinoRatio: run.sortinoRatio != null ? Number(run.sortinoRatio) : null,
    maxDrawdown: run.maxDrawdown != null ? Number(run.maxDrawdown) : null,
    averageWin: run.averageWin != null ? Number(run.averageWin) : null,
    averageLoss: run.averageLoss != null ? Number(run.averageLoss) : null,
    expectancy: run.expectancy != null ? Number(run.expectancy) : null,
    largestWin: run.largestWin != null ? Number(run.largestWin) : null,
    largestLoss: run.largestLoss != null ? Number(run.largestLoss) : null,
    dailyReturns: run.dailyReturns ?? [],
    monthlyReturns: run.monthlyReturns ?? [],
    strategyComparison: run.strategyComparison ?? [],
    // Phase 7: how much of the trade-management ladder actually engaged —
    // see backtestEngine.ts computeMetrics() for what these mean.
    tp1HitRate: run.tp1HitRate != null ? Number(run.tp1HitRate) : null,
    tp2HitRate: run.tp2HitRate != null ? Number(run.tp2HitRate) : null,
    breakEvenRate: run.breakEvenRate != null ? Number(run.breakEvenRate) : null,
    trailingStopRate: run.trailingStopRate != null ? Number(run.trailingStopRate) : null,
    // Phase 6 audit Finding A/E: populated when any enabled strategy's
    // maxHoldingSeconds is ≤ this run's candle interval.
    timeframeWarnings: run.timeframeWarnings ?? [],
    // Diagnostics: the config actually used for this run (see
    // lib/backtestConfig.ts) — { summary: [...per-strategy], runLevelOverrides: {...} }.
    // BUG FIX (Phase 5A audit): this used to store only the bare `summary`
    // array, so `runLevelOverrides` was silently always undefined downstream
    // (the CSV/HTML export's "run-level overrides" line was permanently
    // blank). Now the full object is persisted.
    effectiveConfig: run.effectiveConfig ?? null,
    params: run.params,
    status: run.status,
    progress: run.progress,
    error: run.error,
    aiAnalysis: run.aiAnalysis,
    createdAt: run.createdAt,
  };
}

function serializeTrade(t: typeof backtestTradesTable.$inferSelect) {
  const entryPrice = Number(t.entryPrice);
  const stopLoss = Number(t.stopLoss);
  const takeProfit = Number(t.takeProfit);
  return {
    id: t.id,
    runId: t.runId,
    symbol: t.symbol,
    side: t.side,
    strategyId: t.strategyId,
    strategyName: t.strategyName,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    entryPrice,
    exitPrice: t.exitPrice != null ? Number(t.exitPrice) : null,
    quantity: Number(t.quantity),
    stopLoss,
    takeProfit,
    // Derived, not stored — entryPrice/stopLoss/takeProfit are the source of
    // truth (Phase 5A); % is always computed fresh from them at read time.
    slPercent: entryPrice > 0 ? ((entryPrice - stopLoss) / entryPrice) * 100 : null,
    tpPercent: entryPrice > 0 ? ((takeProfit - entryPrice) / entryPrice) * 100 : null,
    fees: t.fees != null ? Number(t.fees) : null,
    slippage: t.slippage != null ? Number(t.slippage) : null,
    pnl: t.pnl != null ? Number(t.pnl) : null,
    grossPnl: t.grossPnl != null ? Number(t.grossPnl) : null,
    // Phase 6 audit fix: net-of-fees now (see grossPnl above for the gross figure).
    pnlPercent: t.pnlPercent != null ? Number(t.pnlPercent) : null,
    confidence: t.confidence != null ? Number(t.confidence) : null,
    exitReason: t.exitReason,
    durationSeconds: t.durationSeconds,
    mfe: t.mfe != null ? Number(t.mfe) : null,
    mae: t.mae != null ? Number(t.mae) : null,
    riskReward: t.riskReward != null ? Number(t.riskReward) : null,
    // ── Phase 7: trade-management ladder ──────────────────────────────────
    tp1Price: t.tp1Price != null ? Number(t.tp1Price) : null,
    tp1Filled: t.tp1Filled,
    tp1FillPrice: t.tp1FillPrice != null ? Number(t.tp1FillPrice) : null,
    tp2Price: t.tp2Price != null ? Number(t.tp2Price) : null,
    tp2Filled: t.tp2Filled,
    tp2FillPrice: t.tp2FillPrice != null ? Number(t.tp2FillPrice) : null,
    breakEvenActive: t.breakEvenActive,
    trailingStopActive: t.trailingStopActive,
    trailingStopMode: t.trailingStopMode,
  };
}

export default router;
