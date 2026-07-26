/**
 * GET /journal — the per-trade post-mortem journal.
 *
 * tradeAnalysesTable is already populated automatically whenever a LIVE
 * trade closes (botEngine.ts's onTradeClosed → recordTradeAnalysis →
 * analyzeTrade — see lib/tradeAnalysis.ts). This route is the first thing
 * that exposes it: no new analysis logic, just a read + join against the
 * owning trade for the fields the analysis row doesn't carry itself
 * (symbol, side, pnl, entry/exit time, strategy). Newest first, cursor
 * paginated via ?before=<analysisId>, same convention as /decisions.
 *
 * Backtest trades never get an analysis row (recordTradeAnalysis is only
 * called from the live close path), so this is implicitly live-only —
 * matching the "post-mortem is about YOUR live track record" framing.
 */
import { Router, type IRouter } from "express";
import { db, tradeAnalysesTable, tradesTable } from "@workspace/db";
import { and, eq, lt, desc, type SQL } from "drizzle-orm";

const router: IRouter = Router();

router.get("/journal", async (req, res): Promise<void> => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const before = Number(req.query.before);
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
  const outcome = typeof req.query.outcome === "string" ? req.query.outcome : undefined;

  const where: SQL[] = [
    eq(tradeAnalysesTable.userId, req.userId!),
    eq(tradesTable.section, req.section!),
  ];
  if (Number.isFinite(before) && before > 0) where.push(lt(tradeAnalysesTable.id, before));
  if (symbol) where.push(eq(tradesTable.symbol, symbol));
  if (outcome) where.push(eq(tradeAnalysesTable.outcome, outcome));

  const rows = await db
    .select({
      id: tradeAnalysesTable.id,
      tradeId: tradeAnalysesTable.tradeId,
      outcome: tradeAnalysesTable.outcome,
      rMultiple: tradeAnalysesTable.rMultiple,
      grade: tradeAnalysesTable.grade,
      findings: tradeAnalysesTable.findings,
      summary: tradeAnalysesTable.summary,
      createdAt: tradeAnalysesTable.createdAt,
      symbol: tradesTable.symbol,
      side: tradesTable.side,
      strategyId: tradesTable.strategyId,
      strategyName: tradesTable.strategyName,
      entryPrice: tradesTable.entryPrice,
      exitPrice: tradesTable.exitPrice,
      pnl: tradesTable.pnl,
      entryTime: tradesTable.entryTime,
      exitTime: tradesTable.exitTime,
      exitReason: tradesTable.exitReason,
      holdingSeconds: tradesTable.holdingSeconds,
    })
    .from(tradeAnalysesTable)
    .innerJoin(tradesTable, eq(tradeAnalysesTable.tradeId, tradesTable.id))
    .where(and(...where))
    .orderBy(desc(tradeAnalysesTable.id))
    .limit(limit);

  res.json(rows.map((r) => ({
    id: r.id,
    tradeId: r.tradeId,
    outcome: r.outcome,
    rMultiple: r.rMultiple != null ? Number(r.rMultiple) : null,
    grade: r.grade,
    // Stored as a JSON string (text column) — parse for the API response.
    findings: JSON.parse(r.findings) as string[],
    summary: r.summary,
    createdAt: r.createdAt.toISOString(),
    symbol: r.symbol,
    side: r.side,
    strategyId: r.strategyId,
    strategyName: r.strategyName,
    entryPrice: Number(r.entryPrice),
    exitPrice: r.exitPrice != null ? Number(r.exitPrice) : null,
    pnl: r.pnl != null ? Number(r.pnl) : null,
    entryTime: r.entryTime.toISOString(),
    exitTime: r.exitTime ? r.exitTime.toISOString() : null,
    exitReason: r.exitReason,
    holdingSeconds: r.holdingSeconds,
  })));
});

export default router;
