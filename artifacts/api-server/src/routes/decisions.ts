import { Router, type IRouter } from "express";
import { db, strategyDecisionsTable } from "@workspace/db";
import { and, eq, lt, gte, desc, sql, type SQL } from "drizzle-orm";
import { GetDecisionFunnelResponse } from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * GET /decisions — the persistent strategy decision journal.
 *
 * Every trade a strategy genuinely CONSIDERED: executed (with tradeId),
 * approved but not taken (engine stage + reason), or rejected by the
 * strategy's own reasoning (stage + reason + report). Newest first, cursor
 * paginated via ?before=<id>.
 */
/**
 * GET /decisions/funnel — where this section's signals actually went.
 *
 * The engine can veto every signal it produces for days and no screen says
 * so; that is exactly what happened (~3,300 rejections over two days, all at
 * one stage, zero executions, discovered only by exporting the journal). The
 * data was always here — this aggregates it.
 *
 * Sums `occurrences` rather than counting rows: the journal dedupes an
 * identical repeated decision onto one row with a bumped counter, so row
 * counts would understate a stage that fires every scan by orders of
 * magnitude — which is precisely the stage worth seeing.
 *
 * Declared before GET /decisions so Express matches the literal path first.
 */
router.get("/decisions/funnel", async (req, res): Promise<void> => {
  const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 24));
  const since = new Date(Date.now() - hours * 3600_000);

  const scope = and(
    eq(strategyDecisionsTable.userId, req.userId!),
    eq(strategyDecisionsTable.section, req.section!),
    gte(strategyDecisionsTable.lastSeenAt, since),
  );

  const byKind = await db
    .select({
      kind: strategyDecisionsTable.kind,
      total: sql<number>`sum(${strategyDecisionsTable.occurrences})::int`,
    })
    .from(strategyDecisionsTable)
    .where(scope)
    .groupBy(strategyDecisionsTable.kind);

  const kindTotal = (k: string) => byKind.find((r) => r.kind === k)?.total ?? 0;

  const byStage = await db
    .select({
      stage: strategyDecisionsTable.stage,
      count: sql<number>`sum(${strategyDecisionsTable.occurrences})::int`,
      topReason: sql<string | null>`(array_agg(${strategyDecisionsTable.reason} ORDER BY ${strategyDecisionsTable.occurrences} DESC))[1]`,
    })
    .from(strategyDecisionsTable)
    .where(and(scope, eq(strategyDecisionsTable.kind, "rejected")))
    .groupBy(strategyDecisionsTable.stage)
    .orderBy(desc(sql`sum(${strategyDecisionsTable.occurrences})`));

  const executed = kindTotal("executed");
  const rejected = kindTotal("rejected");
  const approvedNotTaken = kindTotal("approved_not_taken");

  res.json(GetDecisionFunnelResponse.parse({
    hours,
    signals: executed + rejected + approvedNotTaken,
    executed,
    rejected,
    approvedNotTaken,
    stages: byStage.map((r) => ({
      stage: r.stage || "unspecified",
      count: r.count ?? 0,
      topReason: r.topReason ?? null,
    })),
  }));
});

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
