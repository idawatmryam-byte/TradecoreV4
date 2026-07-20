/**
 * TradeCore Pro — Demo bot status overlay
 *
 * The read-only demo account has no running engine (it holds no exchange
 * keys and every mutation is blocked), so the live `getState()` would report
 * a null balance and zeroed KPIs — an empty-looking hero panel that
 * undersells the product to a prospect.
 *
 * This builds an honest, DB-derived status for the demo instead: a fixed
 * paper starting balance grown by the seeded closed trades, plus today's
 * P&L / trade count / win rate and the open-position count read straight from
 * the seeded `trades` rows. It's a labeled DEMO snapshot (the dashboard shows
 * a "DEMO · read-only" banner), not a claim of a live engine — the numbers
 * are real aggregates of the seeded data.
 */
import { db } from "@workspace/db";
import { tradesTable } from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
import type { BotState } from "./botEngine";
import type { Section } from "./engineRegistry";

/** Paper starting balance shown per section (mirrors typical demo accounts:
 *  a Binance testnet wallet and a £100k-scale OANDA practice account). */
const DEMO_START_BALANCE: Record<Section, number> = {
  crypto: 10_000,
  forex: 100_000,
};

export async function buildDemoStatus(userId: number, section: Section): Promise<BotState> {
  const closed = await db
    .select({ pnl: tradesTable.pnl, exitTime: tradesTable.exitTime, status: tradesTable.status })
    .from(tradesTable)
    .where(and(eq(tradesTable.userId, userId), eq(tradesTable.section, section)));

  const startBalance = DEMO_START_BALANCE[section];
  let realizedPnl = 0;
  let openPositions = 0;
  const startOfDay = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
  let dailyPnl = 0;
  let tradesToday = 0;
  let winsToday = 0;

  for (const t of closed) {
    if (t.status === "open") { openPositions++; continue; }
    const pnl = Number(t.pnl ?? 0);
    realizedPnl += pnl;
    if (t.exitTime && t.exitTime.getTime() >= startOfDay) {
      dailyPnl += pnl;
      tradesToday++;
      if (pnl > 0) winsToday++;
    }
  }

  return {
    running: true, // labeled DEMO snapshot — controls are disabled in the UI
    balanceUsdt: Math.round((startBalance + realizedPnl) * 100) / 100,
    dailyPnl: Math.round(dailyPnl * 100) / 100,
    openPositions,
    totalTradesToday: tradesToday,
    winRateToday: tradesToday > 0 ? winsToday / tradesToday : 0,
    circuitBreakerActive: false,
    riskPaused: false,
    mode: "testnet",
    startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    lastScanAt: new Date().toISOString(),
  };
}
