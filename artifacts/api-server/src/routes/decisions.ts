import { Router, type IRouter } from "express";
import { db, strategyDecisionsTable } from "@workspace/db";
import { and, eq, lt, desc, type SQL } from "drizzle-orm";

const router: IRouter = Router();

/**
 * GET /decisions — the persistent strategy decision journal.
 *
 * Every trade a strategy genuinely CONSIDERED: executed (with tradeId),
 * approved but not taken (engine stage + reason), or rejected by the
 * strategy's own reasoning (stage + reason + report). Newest first, cursor
 * paginated via ?before=<id>.
 */
router.get("/decisions", async (req, res): Promise<void> => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const before = Number(req.query.before);
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const strategyId = typeof req.query.strategyId === "string" ? req.query.strategyId : undefined;
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol : undefined;

  const where: SQL[] = [
    eq(strategyDecisionsTable.userId, req.userId!),
    eq(strategyDecisionsTable.section, req.section!),
  ];
  if (Number.isFinite(before) && before > 0) where.push(lt(strategyDecisionsTable.id, before));
  if (kind) where.push(eq(strategyDecisionsTable.kind, kind));
  if (strategyId) where.push(eq(strategyDecisionsTable.strategyId, strategyId));
  if (symbol) where.push(eq(strategyDecisionsTable.symbol, symbol));

  const rows = await db
    .select()
    .from(strategyDecisionsTable)
    .where(and(...where))
    .orderBy(desc(strategyDecisionsTable.id))
    .limit(limit);

  res.json(rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    symbol: r.symbol,
    strategyId: r.strategyId,
    strategyName: r.strategyName,
    kind: r.kind,
    side: r.side,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    stage: r.stage,
    reason: r.reason,
    report: r.report ?? null,
    tradeId: r.tradeId,
    occurrences: r.occurrences,
    lastSeenAt: r.lastSeenAt.toISOString(),
  })));
});

export default router;
