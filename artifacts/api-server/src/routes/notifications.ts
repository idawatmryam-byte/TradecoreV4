/**
 * In-app notifications — a second, always-on channel for the exact same
 * alerts that already fire the risk-alert webhook (circuit breaker,
 * risk-pause, untracked-position detection, startup reconciliation
 * failures). See botEngine.ts's sendAlert() for the single write chokepoint.
 *
 * GET /notifications        — unread-first, cursor-paginated
 * POST /notifications/:id/read       — mark one read
 * POST /notifications/read-all       — mark all (this section) read
 */
import { Router, type IRouter } from "express";
import { db, notificationsTable } from "@workspace/db";
import { and, eq, isNull, lt, desc, sql, type SQL } from "drizzle-orm";

const router: IRouter = Router();

router.get("/notifications", async (req, res): Promise<void> => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const before = Number(req.query.before);
  const unreadOnly = req.query.unreadOnly === "true";

  const where: SQL[] = [
    eq(notificationsTable.userId, req.userId!),
    eq(notificationsTable.section, req.section!),
  ];
  if (Number.isFinite(before) && before > 0) where.push(lt(notificationsTable.id, before));
  if (unreadOnly) where.push(isNull(notificationsTable.readAt));

  const [rows, [{ unreadCount }]] = await Promise.all([
    db.select().from(notificationsTable).where(and(...where)).orderBy(desc(notificationsTable.id)).limit(limit),
    db.select({ unreadCount: sql<number>`count(*)::int` }).from(notificationsTable).where(and(
      eq(notificationsTable.userId, req.userId!),
      eq(notificationsTable.section, req.section!),
      isNull(notificationsTable.readAt),
    )),
  ]);

  res.json({
    unreadCount,
    notifications: rows.map((r) => ({
      id: r.id,
      type: r.type,
      message: r.message,
      severity: r.severity,
      createdAt: r.createdAt.toISOString(),
      readAt: r.readAt ? r.readAt.toISOString() : null,
    })),
  });
});

router.post("/notifications/:id/read", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(and(
      eq(notificationsTable.id, id),
      eq(notificationsTable.userId, req.userId!),
      eq(notificationsTable.section, req.section!),
    ));
  res.json({ success: true });
});

router.post("/notifications/read-all", async (req, res): Promise<void> => {
  await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(and(
      eq(notificationsTable.userId, req.userId!),
      eq(notificationsTable.section, req.section!),
      isNull(notificationsTable.readAt),
    ));
  res.json({ success: true });
});

export default router;
