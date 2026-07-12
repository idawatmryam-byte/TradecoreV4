import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { blacklistTable, hourlyStatsTable } from "@workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  GetBlacklistResponse,
  GetToxicHoursResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/memory/blacklist", async (req, res): Promise<void> => {
  const now = new Date();
  const rows = await db
    .select()
    .from(blacklistTable)
    .where(and(eq(blacklistTable.userId, req.userId!), gte(blacklistTable.expiresAt, now)));

  res.json(
    GetBlacklistResponse.parse(
      rows.map((r) => ({
        symbol: r.symbol,
        winRate: Number(r.winRate),
        tradeCount: r.tradeCount,
        blacklistedAt: r.blacklistedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      }))
    )
  );
});

router.get("/memory/toxic-hours", async (req, res): Promise<void> => {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;

  const rows = await db
    .select({
      hour: hourlyStatsTable.hour,
      cumulativePnl: sql<number>`sum(${hourlyStatsTable.pnl})`,
      tradeCount: sql<number>`sum(${hourlyStatsTable.tradeCount})`,
      blockedAt: sql<string>`min(${hourlyStatsTable.createdAt})`,
    })
    .from(hourlyStatsTable)
    .where(and(eq(hourlyStatsTable.userId, req.userId!), gte(hourlyStatsTable.date, threeDaysAgo)))
    .groupBy(hourlyStatsTable.hour)
    .having(sql`sum(${hourlyStatsTable.pnl}) < 0`);

  res.json(
    GetToxicHoursResponse.parse(
      rows.map((r) => ({
        hour: r.hour,
        cumulativePnl: Number(r.cumulativePnl),
        tradeCount: Number(r.tradeCount),
        blockedAt: new Date(r.blockedAt).toISOString(),
      }))
    )
  );
});

export default router;
