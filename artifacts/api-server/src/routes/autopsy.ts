/**
 * Optimization Autopsy — "what's wrong with MY configuration?"
 *
 *   POST /backtests/autopsy      — start a walk-forward diagnosis (async, 202)
 *   GET  /backtests/autopsy      — recent autopsies for this user
 *   GET  /backtests/autopsy/:id  — one autopsy (poll while running)
 *
 * Section-scoped: a forex autopsy diagnoses the FOREX section's configs on
 * OANDA candles with forex costs; crypto uses Binance data. Never mixed.
 */
import { Router, type IRouter } from "express";
import { db, autopsyRunsTable, botConfigTable, customStrategiesTable } from "@workspace/db";
import { and, eq, desc, asc, sql, lte } from "drizzle-orm";
import { startAutopsy } from "../lib/autopsy/autopsyService";
import { strategiesForSection } from "../lib/strategies";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const VALID_TIMEFRAMES = new Set(["1m", "3m", "5m", "15m", "30m", "1h"]);
const MAX_SYMBOLS = 4;

function serialize(r: typeof autopsyRunsTable.$inferSelect, displayNo?: number) {
  return {
    id: r.id,
    // Friendly per-SECTION run number (1, 2, 3…) computed from this run's
    // position within its own section's history. `id` above is the global DB
    // key (shared across users and both sections) — used only for links; it
    // must never be shown as "the run number" or forex would read #9, #10…
    // continuing crypto's global counter. See the list/detail handlers.
    displayNo: displayNo ?? r.id,
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
  const section = req.section === "forex" ? "forex" : "crypto";
  const b = req.body as Record<string, unknown>;
  const strategyId = typeof b.strategyId === "string" ? b.strategyId : "";
  const catalog = strategiesForSection(section);
  if (!catalog.some((s) => s.strategyId === strategyId)) {
    // Not a built-in — the user's own custom strategies are valid autopsy
    // subjects too (their config rows live in the same table).
    const [customRow] = strategyId.startsWith("custom_")
      ? await db
          .select({ id: customStrategiesTable.id })
          .from(customStrategiesTable)
          .where(and(
            eq(customStrategiesTable.userId, req.userId!),
            eq(customStrategiesTable.section, section),
            eq(customStrategiesTable.strategyId, strategyId),
          ))
      : [];
    if (!customRow) {
      res.status(400).json({ error: `strategyId must be one of: ${catalog.map((s) => s.strategyId).join(", ")} — or one of your custom strategies` });
      return;
    }
  }

  const timeframe = typeof b.timeframe === "string" && VALID_TIMEFRAMES.has(b.timeframe) ? b.timeframe : "5m";
  const days = Math.min(120, Math.max(14, Number(b.days ?? 45)));

  // Symbols: explicit list, else the user's configured pairs for THIS section
  // (bounded — each extra symbol multiplies candle prep + sim time across
  // ~30 backtests).
  let symbols = Array.isArray(b.symbols)
    ? (b.symbols as unknown[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : [];
  if (symbols.length === 0) {
    const [cfg] = await db
      .select({ pairs: botConfigTable.pairs })
      .from(botConfigTable)
      .where(and(eq(botConfigTable.userId, req.userId!), eq(botConfigTable.section, section)));
    symbols = (cfg?.pairs ?? (section === "forex" ? "EUR_USD,GBP_USD,XAU_USD" : "BTCUSDT,ETHUSDT,SOLUSDT"))
      .split(",").map((s) => s.trim()).filter(Boolean);
  }
  symbols = symbols.slice(0, MAX_SYMBOLS);

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 3600_000);

  try {
    const id = await startAutopsy(req.userId!, { strategyId, symbols, timeframe, startDate, endDate, section });
    logger.info({ userId: req.userId, autopsyId: id, strategyId, symbols, timeframe, days, section }, "AUTOPSY_STARTED");
    res.status(202).json({ id, status: "pending" });
  } catch (err) {
    res.status(400).json({ error: String((err as Error)?.message ?? err) });
  }
});

router.get("/backtests/autopsy", async (req, res): Promise<void> => {
  // Section-scoped like every other list: the forex Diagnose panel must not
  // show crypto verdicts (different market, different configs) or vice versa.
  const section = req.section === "forex" ? "forex" : "crypto";
  // Per-section run numbering: rank ALL of this user's autopsies in this
  // section by creation order (oldest = #1), so each section counts 1..N
  // independently regardless of the global DB id.
  const ordered = await db
    .select({ id: autopsyRunsTable.id })
    .from(autopsyRunsTable)
    .where(and(eq(autopsyRunsTable.userId, req.userId!), eq(autopsyRunsTable.section, section)))
    .orderBy(asc(autopsyRunsTable.id));
  const seqById = new Map(ordered.map((r, i) => [r.id, i + 1]));

  const rows = await db
    .select()
    .from(autopsyRunsTable)
    .where(and(eq(autopsyRunsTable.userId, req.userId!), eq(autopsyRunsTable.section, section)))
    .orderBy(desc(autopsyRunsTable.createdAt))
    .limit(20);
  res.json(rows.map((r) => serialize(r, seqById.get(r.id))));
});

router.get("/backtests/autopsy/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id!, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [row] = await db
    .select()
    .from(autopsyRunsTable)
    .where(and(eq(autopsyRunsTable.id, id), eq(autopsyRunsTable.userId, req.userId!)));
  if (!row) { res.status(404).json({ error: "Autopsy not found" }); return; }
  // displayNo = this run's position within its own section (count of same-user,
  // same-section autopsies created up to and including it).
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(autopsyRunsTable)
    .where(and(
      eq(autopsyRunsTable.userId, req.userId!),
      eq(autopsyRunsTable.section, row.section),
      lte(autopsyRunsTable.id, row.id),
    ));
  res.json(serialize(row, n));
});

export default router;
