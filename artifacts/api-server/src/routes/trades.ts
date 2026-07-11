import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { tradesTable, tradePartialExitsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import {
  GetTradesQueryParams,
  GetTradeParams,
  GetTradeResponse,
  GetTradesResponse,
} from "@workspace/api-zod";
import { isValidExitReason } from "../lib/exitTypes";
import { getOrCreateEngine } from "../lib/engineRegistry";

const router: IRouter = Router();

function num(v: string | null): number | null {
  return v !== null ? Number(v) : null;
}

function mapTrade(t: typeof tradesTable.$inferSelect) {
  return {
    id: t.id,
    symbol: t.symbol,
    side: t.side,
    entryPrice: Number(t.entryPrice),
    exitPrice: t.exitPrice !== null ? Number(t.exitPrice) : null,
    quantity: Number(t.quantity),
    pnl: t.pnl !== null ? Number(t.pnl) : null,
    status: t.status,
    confidence: Number(t.confidence),
    stopLoss: Number(t.stopLoss),
    takeProfit: Number(t.takeProfit),
    entryTime: t.entryTime.toISOString(),
    exitTime: t.exitTime ? t.exitTime.toISOString() : null,
    // Defensively re-validate against the canonical set — a bad historical
    // row should never crash serialization, just come through as null.
    exitReason: isValidExitReason(t.exitReason) ? t.exitReason : null,
    isBacktest: t.isBacktest,
    // Phase 4A: full exit audit trail
    plannedStopLoss: num(t.plannedStopLoss),
    plannedTakeProfit: num(t.plannedTakeProfit),
    plannedQuantity: num(t.plannedQuantity),
    feesUsdt: num(t.feesUsdt),
    slippageUsdt: num(t.slippageUsdt),
    holdingSeconds: t.holdingSeconds,
    grossPnl: num(t.grossPnl),
    // Phase 4B: trade-management state
    remainingQuantity: num(t.remainingQuantity),
    tp1Price: num(t.tp1Price),
    tp1Quantity: num(t.tp1Quantity),
    tp1Filled: t.tp1Filled,
    tp1FillPrice: num(t.tp1FillPrice),
    tp2Price: num(t.tp2Price),
    tp2Quantity: num(t.tp2Quantity),
    tp2Filled: t.tp2Filled,
    tp2FillPrice: num(t.tp2FillPrice),
    breakEvenActive: t.breakEvenActive,
    trailingStopActive: t.trailingStopActive,
    trailingStopMode: t.trailingStopMode,
  };
}

router.get("/trades", async (req, res): Promise<void> => {
  const query = GetTradesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const { status, source, limit } = query.data;
  let q = db.select().from(tradesTable).$dynamic();

  const conditions = [eq(tradesTable.userId, req.userId!)];
  if (status) conditions.push(eq(tradesTable.status, status));
  if (source) conditions.push(eq(tradesTable.isBacktest, source === "backtest"));
  q = q.where(and(...conditions));

  const trades = await q.orderBy(desc(tradesTable.entryTime)).limit(limit ?? 50);
  const mapped = trades.map(mapTrade);

  res.json(GetTradesResponse.parse(mapped));
});

router.get("/trades/:id", async (req, res): Promise<void> => {
  const params = GetTradeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [trade] = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.id, params.data.id), eq(tradesTable.userId, req.userId!)));

  if (!trade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }

  res.json(GetTradeResponse.parse(mapTrade(trade)));
});

// ---------------------------------------------------------------------------
// GET /trades/:id/replay  — Phase 4D: full lifecycle of one trade, including
// every TP1/TP2 partial close, for a "trade replay" review UI.
// ---------------------------------------------------------------------------

router.get("/trades/:id/replay", async (req, res): Promise<void> => {
  const params = GetTradeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [trade] = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.id, params.data.id), eq(tradesTable.userId, req.userId!)));
  if (!trade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }

  const partials = await db
    .select()
    .from(tradePartialExitsTable)
    .where(eq(tradePartialExitsTable.tradeId, trade.id))
    .orderBy(tradePartialExitsTable.time);

  // Build a chronological timeline: entry → each partial → final close.
  const timeline = [
    { event: "entry", time: trade.entryTime.toISOString(), price: Number(trade.entryPrice), quantity: Number(trade.quantity) },
    ...partials.map((p) => ({
      event: p.reason, time: p.time.toISOString(), price: Number(p.price),
      quantity: Number(p.quantity), pnl: Number(p.pnl), fees: Number(p.fees),
    })),
    ...(trade.exitTime
      ? [{
          event: trade.exitReason ?? "manual", time: trade.exitTime.toISOString(),
          price: trade.exitPrice != null ? Number(trade.exitPrice) : null,
          quantity: Number(trade.remainingQuantity ?? trade.quantity),
        }]
      : []),
  ];

  res.json({ trade: mapTrade(trade), partials, timeline });
});

// ---------------------------------------------------------------------------
// GET /trades/monitor/active  — Phase 4D: live per-position monitoring feed
// (distances to SL/TP1/TP2/final-TP, remaining hold time, unrealized P/L,
// expected reward/risk). Powers the "active trades" dashboard panel.
// ---------------------------------------------------------------------------

router.get("/trades/monitor/active", async (req, res): Promise<void> => {
  const openTrades = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.userId, req.userId!), eq(tradesTable.status, "open")));
  if (openTrades.length === 0) {
    res.json([]);
    return;
  }

  const scannerRows = getOrCreateEngine(req.userId!).getScannerData();
  const priceBySymbol = new Map(scannerRows.map((r) => [r.symbol, r.lastPrice]));
  const now = Date.now();

  const monitor = openTrades.map((t) => {
    const entryPrice = Number(t.entryPrice);
    const qty = Number(t.remainingQuantity ?? t.quantity);
    const sl = Number(t.stopLoss);
    const tp = Number(t.takeProfit);
    const currentPrice = priceBySymbol.get(t.symbol) ?? entryPrice;
    const unrealizedPnl = (currentPrice - entryPrice) * qty;
    const riskDistance = entryPrice - Number(t.plannedStopLoss ?? sl);
    const expectedRewardRisk = riskDistance > 0 ? (tp - entryPrice) / riskDistance : null;
    const heldSeconds = Math.round((now - new Date(t.entryTime).getTime()) / 1000);

    return {
      tradeId: t.id,
      symbol: t.symbol,
      strategyId: t.strategyId,
      strategyName: t.strategyName,
      entryPrice, currentPrice,
      remainingQuantity: qty,
      unrealizedPnl,
      unrealizedPnlPercent: entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0,
      confidence: Number(t.confidence),
      distanceToStopLoss: currentPrice - sl,
      distanceToStopLossPercent: currentPrice > 0 ? ((currentPrice - sl) / currentPrice) * 100 : null,
      distanceToTp1: t.tp1Filled || !t.tp1Price ? null : Number(t.tp1Price) - currentPrice,
      distanceToTp2: t.tp2Filled || !t.tp2Price ? null : Number(t.tp2Price) - currentPrice,
      distanceToFinalTakeProfit: tp - currentPrice,
      expectedRewardRisk,
      breakEvenActive: t.breakEvenActive,
      trailingStopActive: t.trailingStopActive,
      trailingStopMode: t.trailingStopMode,
      tp1Filled: t.tp1Filled,
      tp2Filled: t.tp2Filled,
      holdingSeconds: heldSeconds,
    };
  });

  res.json(monitor);
});

export default router;
