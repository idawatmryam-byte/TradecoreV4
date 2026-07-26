import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { tradesTable, hourlyStatsTable, botConfigTable } from "@workspace/db";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import {
  GetStatsSummaryResponse,
  GetDailyStatsResponse,
  GetHourlyStatsResponse,
} from "@workspace/api-zod";
import {
  isWin,
  maxDrawdownAbsolute,
  round2,
  round4,
  round8,
  winRateOrZero,
} from "../lib/metrics/kernel";

const router: IRouter = Router();

router.get("/stats/summary", async (req, res): Promise<void> => {
  const closed = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.userId, req.userId!), eq(tradesTable.section, req.section!), eq(tradesTable.status, "closed")))
    .orderBy(tradesTable.exitTime); // ascending: oldest→newest for correct drawdown

  const totalTrades = closed.length;
  const pnls = closed.map((t) => Number(t.pnl ?? 0));
  const wins = pnls.filter(isWin);
  const winRate = winRateOrZero(wins.length, totalTrades);
  const totalPnl = pnls.reduce((a, b) => a + b, 0);

  // Max drawdown in dollars (running peak → trough of cumulative P&L).
  const maxDrawdown = maxDrawdownAbsolute(pnls);

  const avgConfidence = closed.length > 0
    ? closed.reduce((sum, t) => sum + Number(t.confidence), 0) / closed.length
    : 0;

  const bestTrade = pnls.length > 0 ? Math.max(...pnls) : 0;
  const worstTrade = pnls.length > 0 ? Math.min(...pnls) : 0;

  // Current streak — walk newest→oldest (closed is ascending for drawdown, so
  // iterate in reverse) so this reflects the MOST RECENT run of wins/losses,
  // not the streak at the very start of history.
  let streakCurrent = 0;
  let streakType: "win" | "loss" | "none" = "none";
  for (let i = closed.length - 1; i >= 0; i--) {
    const t = closed[i]!;
    const p = Number(t.pnl ?? 0);
    if (streakType === "none") {
      streakType = isWin(p) ? "win" : "loss";
      streakCurrent = 1;
    } else if ((streakType === "win" && isWin(p)) || (streakType === "loss" && !isWin(p))) {
      streakCurrent++;
    } else {
      break;
    }
  }

  res.json(
    GetStatsSummaryResponse.parse({
      totalTrades,
      winRate: round4(winRate),
      totalPnl: round8(totalPnl),
      maxDrawdown: round8(maxDrawdown),
      avgConfidence: round2(avgConfidence),
      bestTrade: round8(bestTrade),
      worstTrade: round8(worstTrade),
      streakCurrent,
      streakType: closed.length === 0 ? "none" : streakType,
    })
  );
});

router.get("/stats/daily", async (req, res): Promise<void> => {
  const today = new Date();
  const dateStr = today.toISOString().split("T")[0]!;
  const startOfDay = new Date(dateStr + "T00:00:00Z");
  const configRows = await db.select().from(botConfigTable).where(and(eq(botConfigTable.userId, req.userId!), eq(botConfigTable.section, req.section!))).limit(1);
  const dailyLossLimit = configRows.length > 0 ? Number(configRows[0]!.dailyLossLimitUsdt) : 10;

  const closedToday = await db
    .select()
    .from(tradesTable)
    .where(and(
      eq(tradesTable.userId, req.userId!),
      eq(tradesTable.section, req.section!),
      eq(tradesTable.status, "closed"),
      gte(tradesTable.exitTime, startOfDay),
    ));

  const openToday = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.userId, req.userId!), eq(tradesTable.section, req.section!), eq(tradesTable.status, "open")));

  const pnls = closedToday.map((t) => Number(t.pnl ?? 0));
  const wins = pnls.filter(isWin);
  const totalPnl = pnls.reduce((a, b) => a + b, 0);

  const hourlyRows = await db
    .select()
    .from(hourlyStatsTable)
    .where(and(eq(hourlyStatsTable.userId, req.userId!), eq(hourlyStatsTable.section, req.section!), eq(hourlyStatsTable.date, dateStr)));

  // Build 24-hour breakdown
  const hourlyMap = new Map(hourlyRows.map((r) => [r.hour, r]));
  const hourlyBreakdown = Array.from({ length: 24 }, (_, h) => {
    const r = hourlyMap.get(h);
    const pnl = r ? Number(r.pnl) : 0;
    const tradeCount = r ? r.tradeCount : 0;
    const winRate = winRateOrZero(r?.winCount ?? 0, r?.tradeCount ?? 0);
    return { hour: h, pnl, tradeCount, winRate, isToxic: false };
  });

  // Load toxic hours
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;
  const historicHourly = await db
    .select({
      hour: hourlyStatsTable.hour,
      totalPnl: sql<number>`sum(${hourlyStatsTable.pnl})`,
    })
    .from(hourlyStatsTable)
    .where(and(eq(hourlyStatsTable.userId, req.userId!), eq(hourlyStatsTable.section, req.section!), gte(hourlyStatsTable.date, threeDaysAgo)))
    .groupBy(hourlyStatsTable.hour);

  const toxicHours = new Set(
    historicHourly.filter((r) => Number(r.totalPnl) < 0).map((r) => r.hour)
  );
  for (const row of hourlyBreakdown) {
    row.isToxic = toxicHours.has(row.hour);
  }

  res.json(
    GetDailyStatsResponse.parse({
      date: dateStr,
      tradesCount: closedToday.length,
      winRate: winRateOrZero(wins.length, closedToday.length),
      totalPnl,
      openPositions: openToday.length,
      circuitBreakerHit: totalPnl <= -Math.abs(dailyLossLimit),
      hourlyBreakdown,
    })
  );
});

router.get("/stats/hourly", async (req, res): Promise<void> => {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;

  const rows = await db
    .select({
      hour: hourlyStatsTable.hour,
      pnl: sql<number>`sum(${hourlyStatsTable.pnl})`,
      tradeCount: sql<number>`sum(${hourlyStatsTable.tradeCount})`,
      winCount: sql<number>`sum(${hourlyStatsTable.winCount})`,
    })
    .from(hourlyStatsTable)
    .where(and(eq(hourlyStatsTable.userId, req.userId!), eq(hourlyStatsTable.section, req.section!), gte(hourlyStatsTable.date, threeDaysAgo)))
    .groupBy(hourlyStatsTable.hour);

  const result = Array.from({ length: 24 }, (_, h) => {
    const r = rows.find((row) => row.hour === h);
    const pnl = r ? Number(r.pnl) : 0;
    const tradeCount = r ? Number(r.tradeCount) : 0;
    const winRate = winRateOrZero(Number(r?.winCount ?? 0), Number(r?.tradeCount ?? 0));
    return { hour: h, pnl, tradeCount, winRate, isToxic: pnl < 0 && tradeCount > 0 };
  });

  res.json(GetHourlyStatsResponse.parse(result));
});

export default router;
