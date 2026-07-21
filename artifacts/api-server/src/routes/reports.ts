/**
 * Daily trade report — on-demand counterpart of the UTC-midnight webhook
 * push (see botEngine's rollover hook). Same builder, same numbers.
 *
 * Also: GET /reports/edge-forensics — the "where does the losing come from"
 * decomposition (lib/edgeForensics.ts) over this section's closed live
 * trades, plus a live noise-floor audit of the current strategy configs.
 */
import { Router, type IRouter } from "express";
import { db, tradesTable } from "@workspace/db";
import { and, eq, ne, isNotNull } from "drizzle-orm";
import { buildDailyReport } from "../lib/dailyReport";
import { analyzeEdge, type ForensicTradeRow } from "../lib/edgeForensics";
import { analyzeSelection } from "../lib/selectionFilter";
import { loadStrategyConfigs } from "../lib/strategyConfigLoader";
import { getOrCreateEngine } from "../lib/engineRegistry";
import { GetDailyReportResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/reports/edge-forensics", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.userId, req.userId!),
        eq(tradesTable.section, req.section!),
        eq(tradesTable.isBacktest, false),
        ne(tradesTable.status, "open"),
        isNotNull(tradesTable.pnl),
      ),
    );

  const forensicRows: ForensicTradeRow[] = rows.map((t) => ({
    pnl: Number(t.pnl),
    grossPnl: t.grossPnl != null ? Number(t.grossPnl) : null,
    feesUsdt: t.feesUsdt != null ? Number(t.feesUsdt) : null,
    entryPrice: Number(t.entryPrice),
    plannedStopLoss: t.plannedStopLoss != null ? Number(t.plannedStopLoss) : null,
    stopLoss: Number(t.stopLoss),
    plannedQuantity: t.plannedQuantity != null ? Number(t.plannedQuantity) : null,
    quantity: Number(t.quantity),
    exitReason: t.exitReason,
    strategyId: t.strategyId,
    strategyName: t.strategyName,
    symbol: t.symbol,
    entryTimeMs: t.entryTime.getTime(),
    holdingSeconds: t.holdingSeconds,
    tp1Filled: t.tp1Filled,
  }));

  const report = analyzeEdge(forensicRows);

  // Selection filter (analysis half): which cells is it statistically SAFE
  // to stop trading? Sample-gated so it can't act on noise. Read-only — this
  // never changes engine behavior; it just surfaces the actionable table.
  const selectionFilter = analyzeSelection(forensicRows);

  // ── Live noise-floor audit ────────────────────────────────────────────────
  // A dollar plan implies a stop distance of maxLoss/tradeAmount. If that
  // distance is inside the symbol's CURRENT 1m ATR, the stop sits in
  // ordinary candle noise and gets hit before the thesis can play — one of
  // the classic single-digit-win-rate mechanisms. Uses the live scanner's
  // ATR readings, so it needs the engine running to have data.
  const noiseFlags: Array<{ strategyId: string; symbol: string; impliedStopPct: number; atrPct: number; severity: "inside_noise" | "marginal" }> = [];
  let engineOffline = false;
  try {
    const scanner = getOrCreateEngine(req.userId!, req.section!).getScannerData();
    const atrBySymbol = new Map(scanner.filter((r) => r.atrPercent > 0).map((r) => [r.symbol, r.atrPercent]));
    if (atrBySymbol.size === 0) engineOffline = true;
    const configs = await loadStrategyConfigs(req.userId!, req.section!);
    for (const [strategyId, cfg] of configs) {
      if (!cfg.enabled) continue;
      if (cfg.tradeAmountUsdt == null || cfg.maxLossUsdt == null || !(cfg.tradeAmountUsdt > 0) || !(cfg.maxLossUsdt > 0)) continue;
      const impliedStopPct = (cfg.maxLossUsdt / cfg.tradeAmountUsdt) * 100;
      for (const [symbol, atrPct] of atrBySymbol) {
        if (impliedStopPct < atrPct) {
          noiseFlags.push({ strategyId, symbol, impliedStopPct: Math.round(impliedStopPct * 100) / 100, atrPct: Math.round(atrPct * 100) / 100, severity: "inside_noise" });
        } else if (impliedStopPct < atrPct * 1.5) {
          noiseFlags.push({ strategyId, symbol, impliedStopPct: Math.round(impliedStopPct * 100) / 100, atrPct: Math.round(atrPct * 100) / 100, severity: "marginal" });
        }
      }
    }
  } catch {
    engineOffline = true;
  }
  if (noiseFlags.some((f) => f.severity === "inside_noise")) {
    const worst = noiseFlags.filter((f) => f.severity === "inside_noise");
    report.verdicts.unshift({
      severity: "critical",
      title: `${worst.length} strategy×symbol pair(s) have their stop INSIDE current 1-minute noise`,
      detail:
        `A stop closer than the symbol's 1m ATR gets hit by ordinary wiggle before the trade can work (e.g. ` +
        `${worst[0]!.strategyId} on ${worst[0]!.symbol}: implied stop ${worst[0]!.impliedStopPct}% vs ATR ${worst[0]!.atrPct}%). ` +
        `Raise Max Loss or lower Trade Amount until the implied stop clears the ATR with room.`,
    });
  }

  res.json({ ...report, selectionFilter, noiseFlags, engineOffline });
});

// ---------------------------------------------------------------------------
// GET /reports/trades.csv — the user's closed live trades as CSV.
//
// Data portability (a due-diligence plus) and the bridge for offline edge
// analysis: this is the exact history the Edge Forensics + Selection Filter
// run on. Section-scoped, closed trades only, newest first.
// ---------------------------------------------------------------------------
router.get("/reports/trades.csv", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.userId, req.userId!),
        eq(tradesTable.section, req.section!),
        eq(tradesTable.isBacktest, false),
        ne(tradesTable.status, "open"),
      ),
    );
  rows.sort((a, b) => b.entryTime.getTime() - a.entryTime.getTime());

  const COLUMNS: Array<[string, (t: (typeof rows)[number]) => string | number | null]> = [
    ["id", (t) => t.id],
    ["section", (t) => t.section],
    ["symbol", (t) => t.symbol],
    ["side", (t) => t.side],
    ["strategyId", (t) => t.strategyId],
    ["strategyName", (t) => t.strategyName],
    ["status", (t) => t.status],
    ["confidence", (t) => t.confidence],
    ["entryTime", (t) => t.entryTime.toISOString()],
    ["exitTime", (t) => (t.exitTime ? t.exitTime.toISOString() : "")],
    ["holdingSeconds", (t) => t.holdingSeconds],
    ["entryPrice", (t) => t.entryPrice],
    ["exitPrice", (t) => t.exitPrice],
    ["quantity", (t) => t.quantity],
    ["plannedQuantity", (t) => t.plannedQuantity],
    ["stopLoss", (t) => t.stopLoss],
    ["plannedStopLoss", (t) => t.plannedStopLoss],
    ["takeProfit", (t) => t.takeProfit],
    ["exitReason", (t) => t.exitReason],
    ["tp1Filled", (t) => String(t.tp1Filled)],
    ["pnl", (t) => t.pnl],
    ["grossPnl", (t) => t.grossPnl],
    ["feesUsdt", (t) => t.feesUsdt],
    ["slippageUsdt", (t) => t.slippageUsdt],
    ["marketType", (t) => t.marketType],
  ];

  const esc = (v: string | number | null): string => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = COLUMNS.map(([name]) => name).join(",");
  const body = rows.map((t) => COLUMNS.map(([, get]) => esc(get(t))).join(",")).join("\n");
  const csv = `${header}\n${body}\n`;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="tradecore_${req.section}_trades.csv"`);
  res.send(csv);
});

router.get("/reports/daily", async (req, res): Promise<void> => {
  const raw = typeof req.query.date === "string" ? req.query.date : undefined;
  const date = raw ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }

  const report = await buildDailyReport(req.userId!, date, req.section!);
  res.json(GetDailyReportResponse.parse(report));
});

export default router;
