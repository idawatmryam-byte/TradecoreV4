/**
 * Optimization Autopsy — "what's wrong with MY configuration?"
 *
 *   POST /backtests/autopsy      — start a walk-forward diagnosis (async, 202)
 *   GET  /backtests/autopsy      — recent autopsies for this user
 *   GET  /backtests/autopsy/:id  — one autopsy (poll while running)
 *
 * Crypto-only in v1 — the forex backtest engine doesn't exist yet, and this
 * feature is honest about that rather than producing wrong numbers.
 */
import { Router, type IRouter } from "express";
import { db, autopsyRunsTable, botConfigTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { startAutopsy } from "../lib/autopsy/autopsyService";
import { ALL_STRATEGIES } from "../lib/strategies";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const VALID_TIMEFRAMES = new Set(["1m", "3m", "5m", "15m", "30m", "1h"]);
const MAX_SYMBOLS = 4;

function serialize(r: typeof autopsyRunsTable.$inferSelect) {
  return {
    id: r.id,
    strategyId: r.strategyId,
    strategyName: r.strategyName,
    symbols: r.symbols.split(",").filter(Boolean),
    timeframe: r.timeframe,
    trainStart: r.trainStart.toISOString(),
    trainEnd: r.trainEnd.toISOString(),
    valStart: r.valStart.toISOString(),
    valEnd: r.valEnd.toISOString(),
    status: r.status,
    progress: r.progress,
    stage: r.stage,
    totalBacktests: r.totalBacktests,
    truncated: r.truncated === 1,
    currentParams: r.currentParams,
    bestParams: r.bestParams,
    currentTrain: r.currentTrain,
    currentVal: r.currentVal,
    bestTrain: r.bestTrain,
    bestVal: r.bestVal,
    verdict: r.verdict,
    diagnosis: r.diagnosis,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  };
}

router.post("/backtests/autopsy", async (req, res): Promise<void> => {
  if (req.section === "forex") {
    res.status(400).json({ error: "The Autopsy runs on the crypto section only for now — the forex backtest engine (market-hours-aware) hasn't shipped yet." });
    return;
  }

  const b = req.body as Record<string, unknown>;
  const strategyId = typeof b.strategyId === "string" ? b.strategyId : "";
  if (!ALL_STRATEGIES.some((s) => s.strategyId === strategyId)) {
    res.status(400).json({ error: `strategyId must be one of: ${ALL_STRATEGIES.map((s) => s.strategyId).join(", ")}` });
    return;
  }

  const timeframe = typeof b.timeframe === "string" && VALID_TIMEFRAMES.has(b.timeframe) ? b.timeframe : "5m";
  const days = Math.min(120, Math.max(14, Number(b.days ?? 45)));

  // Symbols: explicit list, else the user's configured crypto pairs (bounded —
  // each extra symbol multiplies candle prep + sim time across ~30 backtests).
  let symbols = Array.isArray(b.symbols)
    ? (b.symbols as unknown[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : [];
  if (symbols.length === 0) {
    const [cfg] = await db
      .select({ pairs: botConfigTable.pairs })
      .from(botConfigTable)
      .where(and(eq(botConfigTable.userId, req.userId!), eq(botConfigTable.section, "crypto")));
    symbols = (cfg?.pairs ?? "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map((s) => s.trim()).filter(Boolean);
  }
  symbols = symbols.slice(0, MAX_SYMBOLS);

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 3600_000);

  try {
    const id = await startAutopsy(req.userId!, { strategyId, symbols, timeframe, startDate, endDate });
    logger.info({ userId: req.userId, autopsyId: id, strategyId, symbols, timeframe, days }, "AUTOPSY_STARTED");
    res.status(202).json({ id, status: "pending" });
  } catch (err) {
    res.status(400).json({ error: String((err as Error)?.message ?? err) });
  }
});

router.get("/backtests/autopsy", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(autopsyRunsTable)
    .where(eq(autopsyRunsTable.userId, req.userId!))
    .orderBy(desc(autopsyRunsTable.createdAt))
    .limit(20);
  res.json(rows.map(serialize));
});

router.get("/backtests/autopsy/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id!, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [row] = await db
    .select()
    .from(autopsyRunsTable)
    .where(and(eq(autopsyRunsTable.id, id), eq(autopsyRunsTable.userId, req.userId!)));
  if (!row) { res.status(404).json({ error: "Autopsy not found" }); return; }
  res.json(serialize(row));
});

export default router;
