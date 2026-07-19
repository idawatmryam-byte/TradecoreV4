/**
 * TradeCore Pro — Daily trade report
 *
 * One computation, two consumers:
 *   - GET /reports/daily (routes/reports.ts): the Analytics page's report
 *     card + CSV download, for any UTC date.
 *   - BotEngine's UTC-midnight rollover push: the same report for the day
 *     that just ended, formatted as text and sent to the user's alert
 *     webhook (Discord/Slack/Telegram) via sendAlert().
 *
 * All dates are UTC calendar days, matching the engine's dailyPnl /
 * circuit-breaker day boundary (refreshDailyState uses the UTC midnight).
 */
import { db } from "@workspace/db";
import { tradesTable } from "@workspace/db";
import type { Section } from "./engineRegistry";
import { eq, and, gte, lt } from "drizzle-orm";

export interface DailyReportTradeRow {
  id: number;
  symbol: string;
  side: string;
  strategyName: string | null;
  entryTime: string;
  exitTime: string | null;
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  pnl: number | null;
  exitReason: string | null;
}

export interface DailyReport {
  date: string; // YYYY-MM-DD (UTC)
  generatedAt: string;
  summary: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    totalFeesUsdt: number;
    bestTrade: number;
    worstTrade: number;
    openPositions: number;
  };
  byStrategy: Array<{ strategyName: string; trades: number; wins: number; pnl: number }>;
  bySymbol: Array<{ symbol: string; trades: number; wins: number; pnl: number }>;
  exitReasons: Record<string, number>;
  trades: DailyReportTradeRow[];
}

export async function buildDailyReport(userId: number, date: string, section: Section = "crypto"): Promise<DailyReport> {
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const closed = await db
    .select()
    .from(tradesTable)
    .where(and(
      eq(tradesTable.userId, userId),
      eq(tradesTable.section, section),
      eq(tradesTable.status, "closed"),
      gte(tradesTable.exitTime, dayStart),
      lt(tradesTable.exitTime, dayEnd),
    ))
    .orderBy(tradesTable.exitTime);

  const open = await db
    .select({ id: tradesTable.id })
    .from(tradesTable)
    .where(and(eq(tradesTable.userId, userId), eq(tradesTable.section, section), eq(tradesTable.status, "open")));

  const pnls = closed.map((t) => Number(t.pnl ?? 0));
  const wins = pnls.filter((p) => p > 0).length;
  const totalPnl = pnls.reduce((a, b) => a + b, 0);

  const byKey = (key: (t: typeof closed[number]) => string) => {
    const acc = new Map<string, { trades: number; wins: number; pnl: number }>();
    for (const t of closed) {
      const k = key(t);
      const e = acc.get(k) ?? { trades: 0, wins: 0, pnl: 0 };
      e.trades++;
      if (Number(t.pnl ?? 0) > 0) e.wins++;
      e.pnl += Number(t.pnl ?? 0);
      acc.set(k, e);
    }
    return acc;
  };

  const exitReasons: Record<string, number> = {};
  for (const t of closed) {
    const r = t.exitReason ?? "unknown";
    exitReasons[r] = (exitReasons[r] ?? 0) + 1;
  }

  return {
    date,
    generatedAt: new Date().toISOString(),
    summary: {
      totalTrades: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length > 0 ? wins / closed.length : 0,
      totalPnl,
      totalFeesUsdt: closed.reduce((a, t) => a + Number(t.feesUsdt ?? 0), 0),
      bestTrade: pnls.length ? Math.max(...pnls) : 0,
      worstTrade: pnls.length ? Math.min(...pnls) : 0,
      openPositions: open.length,
    },
    byStrategy: [...byKey((t) => t.strategyName ?? "unknown")].map(([strategyName, v]) => ({ strategyName, ...v })),
    bySymbol: [...byKey((t) => t.symbol)].map(([symbol, v]) => ({ symbol, ...v })),
    exitReasons,
    trades: closed.map((t) => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      strategyName: t.strategyName,
      entryTime: t.entryTime.toISOString(),
      exitTime: t.exitTime ? t.exitTime.toISOString() : null,
      entryPrice: Number(t.entryPrice),
      exitPrice: t.exitPrice != null ? Number(t.exitPrice) : null,
      quantity: Number(t.quantity),
      pnl: t.pnl != null ? Number(t.pnl) : null,
      exitReason: t.exitReason,
    })),
  };
}

/** Compact text rendering for the webhook push (Discord/Slack line limits). */
export function formatDailyReportText(r: DailyReport, balanceUsdt: number | null): string {
  const s = r.summary;
  const sign = (n: number) => `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
  const lines = [
    `📊 TradeCore daily report — ${r.date} (UTC)`,
    `P&L ${sign(s.totalPnl)} · ${s.totalTrades} trades · ${s.wins}W/${s.losses}L (${(s.winRate * 100).toFixed(0)}%) · fees $${s.totalFeesUsdt.toFixed(2)}`,
  ];
  if (s.totalTrades > 0) {
    lines.push(`best ${sign(s.bestTrade)} · worst ${sign(s.worstTrade)}`);
    const reasons = Object.entries(r.exitReasons).map(([k, v]) => `${k}:${v}`).join(" ");
    if (reasons) lines.push(`exits — ${reasons}`);
    const strat = r.byStrategy
      .sort((a, b) => b.pnl - a.pnl)
      .map((x) => `${x.strategyName} ${sign(x.pnl)} (${x.trades})`)
      .join(" · ");
    if (strat) lines.push(strat);
  }
  lines.push(`open positions: ${s.openPositions}${balanceUsdt != null ? ` · balance $${balanceUsdt.toFixed(2)}` : ""}`);
  return lines.join("\n");
}
