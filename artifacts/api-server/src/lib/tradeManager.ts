/**
 * TradeCore Pro — TradeManager  (Phase 4B, OCO-safe)
 *
 * Manages an *open* trade's SL/TP scaling before ExitManager ever gets a
 * chance to fully close it: partial take-profits (TP1, optional TP2), the
 * break-even move after TP1, and trailing stops (ATR / percent / dynamic /
 * emergency). It never fully closes a trade itself — it only ever narrows
 * the risk (moves stopLoss up) and/or partially reduces size, then hands the
 * (possibly updated) trade row to ExitManager for the final SL/TP/timeout
 * decision. This keeps "who can fully close a trade" as ExitManager's sole
 * responsibility per Phase 4A.
 *
 * IMPORTANT: TP1/TP2 are TICK-CHECKED TRIGGERS, not resting exchange orders.
 * The only thing resting on the exchange at any time is one SL+take-profit
 * pair, ideally as a single atomic Binance OCO (see lib/binanceOco.ts) for
 * whatever the current remaining qty is. A real OCO requires both legs to
 * share one quantity, so a smaller TP1/TP2 slice can't rest alongside a
 * full-size SL — instead, when a bar's high crosses tp1Price/tp2Price,
 * TradeManager cancels the current OCO, market-sells that slice, and
 * re-places a fresh OCO (moved to break-even after TP1) for what's left.
 *
 * All state changes are written straight to `trades` columns that
 * ExitManager already reads (`stopLoss`, `takeProfit`, `remainingQuantity`)
 * — ExitManager doesn't need to know *why* they changed, just their current
 * values.
 */
import { db } from "@workspace/db";
import { tradesTable, tradePartialExitsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { type Candle } from "./strategy";
import type { StrategyConfig } from "./strategies";
import type { OpenOrderIds } from "./exitManager";

type Trade = typeof tradesTable.$inferSelect;

export interface StopReplacementResult {
  slOrderId: string;
  /** Set only when the replacement was a true OCO re-placement (see lib/binanceOco.ts) — both legs' ids change together. */
  tpOrderId?: string;
  ocoOrderListId?: string;
}

export interface PolicyManagementResult {
  applied: boolean;
  protectionHealthy: boolean;
  orderIds: OpenOrderIds | undefined;
  remainingQuantity: number;
  fillPrice?: number;
  reason: string;
}

export interface TradeManagerHost {
  /** Current taker fee per side as a fraction (0.001 spot / 0.0005 futures);
   *  a function so it reflects the engine's ACTIVE market type. */
  takerFee: () => number;
  sendAlert(message: string): Promise<void>;
  /** Cancel whatever is currently resting for this trade (a true OCO order list, or the independent-orders fallback) without placing anything new. Used before a TP1/TP2 partial market-sell, since the resting protection reserves the entire remaining qty and would otherwise starve the sell of balance. Best-effort. */
  cancelProtection(ex: any, market: string, orderIds: OpenOrderIds | undefined): Promise<void>;
  /** Replace the resting SL protection for this trade with one at `newStopPrice`, sized for `qty`, targeting the SAME final take-profit (`tp`) the trade already has. Cancels `oldOrderIds` first (best-effort, redundant if cancelProtection was already called). Returns null if placement failed (caller keeps the old order in that case) — prefers a true OCO re-placement when the exchange supports it, falling back to an independent stop order otherwise. */
  replaceStopOrder(ex: any, trade: Trade, market: string, newStopPrice: number, tp: number, qty: number, oldOrderIds: OpenOrderIds | undefined): Promise<StopReplacementResult | null>;
  /** Fill (or attempt to fill) a partial close for `qty` at market. Returns the actual fill price, or null if it failed. */
  executePartialClose(ex: any, trade: Trade, market: string, qty: number): Promise<number | null>;
  /** Cancel a resting order by id, best-effort. */
  cancelOrder(ex: any, market: string, orderId: string): Promise<void>;
}

// computeTrailingStop moved to execution/trailing.ts so the simulated fill
// model can share the exact live formula without importing the database.
// Re-exported here: existing importers (backtestEngine, tests) are unaffected.
import { computeTrailingStop } from "./execution/trailing";
export { computeTrailingStop };

/** Merge a successful order-replacement result into the OpenOrderIds that
 *  should now be tracked — builds a fresh object even when `prev` is
 *  undefined, so a first-ever successful protection placement (e.g. entry
 *  placement failed but a later re-protect attempt succeeded) is never
 *  silently discarded for lack of an existing object to mutate. */
function mergeOrderIds(prev: OpenOrderIds | undefined, result: StopReplacementResult): OpenOrderIds {
  return {
    slOrderId: result.slOrderId,
    tpOrderId: result.tpOrderId ?? prev?.tpOrderId ?? "",
    ocoOrderListId: result.ocoOrderListId,
  };
}

export class TradeManager {
  constructor(private readonly host: TradeManagerHost) {}

  /**
   * Run one management tick for an open trade. Returns the OpenOrderIds that
   * should now be tracked for this trade — the caller MUST persist this back
   * into its own tracking map (even when the caller passed `undefined` in,
   * since a re-protection attempt after a fully-failed entry-time placement
   * can produce a first-ever trackable order here). Always re-read the trade
   * row from the DB after this call if the freshest stopLoss/takeProfit/
   * remainingQuantity is needed, since this may have written to any of them.
   */
  async manage(
    ex: any,
    trade: Trade,
    market: string,
    candles1m: Candle[],
    stratConfig: StrategyConfig | undefined,
    orderIds: OpenOrderIds | undefined,
  ): Promise<OpenOrderIds | undefined> {
    if (!stratConfig || stratConfig.tp1RMultiple <= 0) return orderIds; // trade management disabled for this strategy
    if (candles1m.length === 0) return orderIds;

    // Futures Phase: a short (side="sell") mirrors every direction-dependent
    // calc below — SL/TP1/TP2 sit on the opposite side of entry, trailing
    // tightens downward instead of upward, etc.
    const isShort = trade.side === "sell";

    const lastCandle = candles1m[candles1m.length - 1]!;
    const [, , high, low] = lastCandle;
    const entryPrice = Number(trade.entryPrice);

    // Original risk distance — always measured from the *planned* SL (Phase 4A),
    // not the current one, since the current one may already be at break-even.
    const plannedSl = Number(trade.plannedStopLoss ?? trade.stopLoss);
    const originalRiskDistance = isShort ? plannedSl - entryPrice : entryPrice - plannedSl;
    if (originalRiskDistance <= 0) return orderIds; // can't compute R-multiples safely

    // ── TP1: partial close + move SL to break-even ────────────────────────────
    // Long TP1 sits above entry (triggered by a high); short TP1 sits below
    // (triggered by a low).
    if (!trade.tp1Filled && trade.tp1Price && Number(trade.tp1Price) > 0) {
      const tp1Hit = isShort ? low <= Number(trade.tp1Price) : high >= Number(trade.tp1Price);
      if (tp1Hit) {
        orderIds = await this.fillPartial(ex, trade, market, "tp1", Number(trade.tp1Price), Number(trade.tp1Quantity), orderIds);
        // Re-read — fillPartial updated the DB row.
        trade = (await db.select().from(tradesTable).where(eq(tradesTable.id, trade.id)))[0] ?? trade;
      }
    }

    // ── TP2 (only when tp3Enabled): partial close of another slice ────────────
    // The remainder after TP2 continues targeting the strategy's own original
    // `takeProfit` (untouched) — TP1/TP2 are interior scale-out waypoints
    // between entry and that target, never a target beyond it (see enterTrade,
    // which only enables TP1/TP2 when they land strictly inside entry->takeProfit).
    if (stratConfig.tp3Enabled && trade.tp1Filled && !trade.tp2Filled && trade.tp2Price && Number(trade.tp2Price) > 0) {
      const tp2Hit = isShort ? low <= Number(trade.tp2Price) : high >= Number(trade.tp2Price);
      if (tp2Hit) {
        orderIds = await this.fillPartial(ex, trade, market, "tp2", Number(trade.tp2Price), Number(trade.tp2Quantity), orderIds);
        trade = (await db.select().from(tradesTable).where(eq(tradesTable.id, trade.id)))[0] ?? trade;
      }
    }

    // ── Trailing stop (normal or emergency) ────────────────────────────────────
    const currentPrice = lastCandle[4];
    const unrealizedR = (isShort ? entryPrice - currentPrice : currentPrice - entryPrice) / originalRiskDistance;

    // ── Pre-TP1 break-even arm ────────────────────────────────────────────────
    // A professional doesn't wait for TP1 to protect a working trade: once
    // unrealized profit reaches breakEvenRMultiple × R, the stop moves to the
    // ENTRY price — from here the trade can no longer turn into a loss, even
    // if the market reverses before any target fills. Stops only ever
    // tighten; TP1's own break-even move later is a no-op on top of this.
    if (
      stratConfig.breakEvenRMultiple > 0 &&
      !trade.breakEvenActive &&
      !trade.tp1Filled &&
      unrealizedR >= stratConfig.breakEvenRMultiple
    ) {
      const currentStop = Number(trade.stopLoss);
      const beStop = entryPrice;
      if (isShort ? beStop < currentStop : beStop > currentStop) {
        const qty = Number(trade.remainingQuantity ?? trade.quantity);
        const tp = Number(trade.takeProfit);
        const result = await this.host.replaceStopOrder(ex, trade, market, beStop, tp, qty, orderIds);
        await db
          .update(tradesTable)
          .set({ stopLoss: beStop.toFixed(8), breakEvenActive: true })
          .where(eq(tradesTable.id, trade.id));
        if (result) {
          orderIds = mergeOrderIds(orderIds, result);
        }
        trade = (await db.select().from(tradesTable).where(eq(tradesTable.id, trade.id)))[0] ?? trade;
        logger.info(
          { tradeId: trade.id, symbol: trade.symbol, unrealizedR: unrealizedR.toFixed(2), oldStop: currentStop, newStop: beStop },
          "Break-even armed pre-TP1 — trade can no longer lose",
        );
      }
    }
    const trailingArmed = trade.tp1Filled || !stratConfig.trailingAfterTp1Only;
    const emergencyArmed =
      !trailingArmed &&
      stratConfig.emergencyTrailingRMultiple > 0 &&
      unrealizedR >= stratConfig.emergencyTrailingRMultiple;

    if ((trailingArmed && stratConfig.trailingStopMode !== "none") || emergencyArmed) {
      const mode = emergencyArmed ? "emergency" : stratConfig.trailingStopMode;
      const candidate = computeTrailingStop(mode, currentPrice, candles1m, stratConfig, emergencyArmed, isShort);
      const currentStop = Number(trade.stopLoss);
      // Only ever tighten the stop — raise it for a long, lower it for a
      // short — never loosen it.
      if (isShort ? candidate < currentStop : candidate > currentStop) {
        const qty = Number(trade.remainingQuantity ?? trade.quantity);
        const tp = Number(trade.takeProfit);
        const result = await this.host.replaceStopOrder(ex, trade, market, candidate, tp, qty, orderIds);
        await db
          .update(tradesTable)
          .set({
            stopLoss: candidate.toFixed(8),
            trailingStopActive: true,
            trailingStopMode: mode,
            trailingStopArmedPrice: currentPrice.toFixed(8),
          })
          .where(eq(tradesTable.id, trade.id));
        if (result) {
          orderIds = mergeOrderIds(orderIds, result);
        }
        logger.info(
          { tradeId: trade.id, symbol: trade.symbol, mode, oldStop: currentStop, newStop: candidate },
          "Trailing stop tightened",
        );
      }
    }

    return orderIds;
  }

  /** Apply an already-validated Phase 7 stop tightening through the existing
   * broker protection seam. A failed replacement is reported as unhealthy so
   * BotEngine can immediately flatten through ExitManager; the DB stop is not
   * advanced unless replacement protection was confirmed. */
  async tightenStopByPolicy(
    ex: any,
    trade: Trade,
    market: string,
    newStopPrice: number,
    orderIds: OpenOrderIds | undefined,
    trailing: boolean,
  ): Promise<PolicyManagementResult> {
    const isShort = trade.side === "sell";
    const currentStop = Number(trade.stopLoss);
    const currentTp = Number(trade.takeProfit);
    const remaining = Number(trade.remainingQuantity ?? trade.quantity);
    const tighter = Number.isFinite(newStopPrice) && (isShort ? newStopPrice < currentStop : newStopPrice > currentStop);
    if (!tighter || !(remaining > 0)) {
      return { applied: false, protectionHealthy: true, orderIds, remainingQuantity: remaining, reason: "stop was not strictly tighter" };
    }
    const result = await this.host.replaceStopOrder(ex, trade, market, newStopPrice, currentTp, remaining, orderIds);
    if (!result) {
      return { applied: false, protectionHealthy: false, orderIds, remainingQuantity: remaining, reason: "replacement protection was not confirmed" };
    }
    const nextOrderIds = mergeOrderIds(orderIds, result);
    await db.update(tradesTable).set({
      stopLoss: newStopPrice.toFixed(8),
      ...(trailing
        ? { trailingStopActive: true, trailingStopMode: "phase7-atr", trailingStopArmedPrice: newStopPrice.toFixed(8) }
        : { breakEvenActive: newStopPrice === Number(trade.entryPrice) }),
    }).where(eq(tradesTable.id, trade.id));
    return { applied: true, protectionHealthy: true, orderIds: nextOrderIds, remainingQuantity: remaining, reason: "stop tightened and protection confirmed" };
  }

  /** Execute the one-time bounded Phase 7 reduction. Protection is restored
   * for the remainder before success is reported. A partial fill followed by
   * failed re-protection is surfaced to BotEngine for an emergency flatten. */
  async reduceByPolicy(
    ex: any,
    trade: Trade,
    market: string,
    reductionFraction: number,
    orderIds: OpenOrderIds | undefined,
  ): Promise<PolicyManagementResult> {
    const remaining = Number(trade.remainingQuantity ?? trade.quantity);
    const currentSl = Number(trade.stopLoss);
    const currentTp = Number(trade.takeProfit);
    const rawQty = remaining * reductionFraction;
    const qty = Math.min(rawQty, remaining * 0.5);
    if (!(qty > 0) || !(remaining > qty)) {
      return { applied: false, protectionHealthy: true, orderIds, remainingQuantity: remaining, reason: "reduction quantity is outside policy" };
    }

    await this.host.cancelProtection(ex, market, orderIds);
    const fillPrice = await this.host.executePartialClose(ex, trade, market, qty);
    if (fillPrice === null) {
      const restored = await this.host.replaceStopOrder(ex, trade, market, currentSl, currentTp, remaining, orderIds);
      const nextOrderIds = restored ? mergeOrderIds(orderIds, restored) : orderIds;
      return {
        applied: false,
        protectionHealthy: Boolean(restored),
        orderIds: nextOrderIds,
        remainingQuantity: remaining,
        reason: restored ? "reduction failed; original protection restored" : "reduction and protection restoration failed",
      };
    }

    const isShort = trade.side === "sell";
    const entryPrice = Number(trade.entryPrice);
    const takerFee = this.host.takerFee();
    const fees = (entryPrice + fillPrice) * qty * takerFee;
    const pnl = (isShort ? entryPrice - fillPrice : fillPrice - entryPrice) * qty - fees;
    const newRemaining = remaining - qty;
    await db.transaction(async (tx) => {
      await tx.insert(tradePartialExitsTable).values({
        tradeId: trade.id,
        reason: "phase7_reduce",
        quantity: qty.toFixed(8),
        price: fillPrice.toFixed(8),
        fees: fees.toFixed(8),
        pnl: pnl.toFixed(8),
        time: new Date(),
      });
      await tx.update(tradesTable).set({
        remainingQuantity: newRemaining.toFixed(8),
        phase7ReductionApplied: true,
      }).where(eq(tradesTable.id, trade.id));
    });
    const replacement = await this.host.replaceStopOrder(ex, trade, market, currentSl, currentTp, newRemaining, orderIds);
    const nextOrderIds = replacement ? mergeOrderIds(orderIds, replacement) : orderIds;
    return {
      applied: true,
      protectionHealthy: Boolean(replacement),
      orderIds: nextOrderIds,
      remainingQuantity: newRemaining,
      fillPrice,
      reason: replacement ? "position reduced and remainder re-protected" : "position reduced but remainder protection was not confirmed",
    };
  }

  /**
   * Returns the OpenOrderIds that should now be tracked for this trade —
   * which may be a NEW object even if the caller passed `undefined` in (e.g.
   * entry-time protection placement fully failed, so nothing was tracked
   * yet, but this partial-close's re-protection attempt succeeded). The
   * caller MUST persist whatever comes back into its own tracking map;
   * mutating a possibly-undefined `orderIds` in place can silently discard
   * a freshly-placed order's id forever.
   */
  private async fillPartial(
    ex: any,
    trade: Trade,
    market: string,
    reason: "tp1" | "tp2",
    triggerPrice: number,
    plannedQty: number,
    orderIds: OpenOrderIds | undefined,
  ): Promise<OpenOrderIds | undefined> {
    if (!(plannedQty > 0)) return orderIds;
    const remaining = Number(trade.remainingQuantity ?? trade.quantity);
    const qty = Math.min(plannedQty, remaining);
    if (qty <= 0) return orderIds;

    const isShort = trade.side === "sell";
    const entryPrice = Number(trade.entryPrice);
    const currentSl = Number(trade.stopLoss);
    const currentTp = Number(trade.takeProfit);

    // The resting protection (a true OCO, or the independent-orders fallback)
    // reserves the ENTIRE remaining qty on the exchange side. A Binance OCO's
    // two legs must share one quantity, so there's no way to carve a TP1/TP2
    // slice out of it while it's resting — free the reservation first, then
    // re-protect what's left afterward. This is why TP1/TP2 are tick-checked
    // triggers (see manage()) rather than their own resting orders.
    await this.host.cancelProtection(ex, market, orderIds);

    const fillPrice = await this.host.executePartialClose(ex, trade, market, qty);
    if (fillPrice === null) {
      logger.error(
        { tradeId: trade.id, symbol: trade.symbol, reason },
        "Partial close market order failed AFTER cancelling protection — position is temporarily unprotected, restoring the original SL/TP now",
      );
      const restored = await this.host.replaceStopOrder(ex, trade, market, currentSl, currentTp, remaining, orderIds);
      if (restored) {
        orderIds = mergeOrderIds(orderIds, restored);
      } else {
        await this.host.sendAlert(
          `🚨 ${trade.symbol} (trade #${trade.id}): failed to restore SL/TP protection after a failed ${reason} partial-close attempt. Position may be UNPROTECTED — please check manually.`,
        ).catch(() => {});
      }
      return orderIds;
    }

    const takerFee = this.host.takerFee();
    const entryFeeShare = entryPrice * qty * takerFee;
    const exitFee = fillPrice * qty * takerFee;
    const fees = entryFeeShare + exitFee;
    const pnl = (isShort ? entryPrice - fillPrice : fillPrice - entryPrice) * qty - fees;
    const newRemaining = remaining - qty;
    const now = new Date();

    await db.insert(tradePartialExitsTable).values({
      tradeId: trade.id, reason, quantity: qty.toFixed(8), price: fillPrice.toFixed(8),
      fees: fees.toFixed(8), pnl: pnl.toFixed(8), time: now,
    });

    // TP1 may follow an earlier trailing tighten; never give that protection back.
    const newSl = reason === "tp1"
      ? (isShort ? Math.min(currentSl, entryPrice) : Math.max(currentSl, entryPrice))
      : currentSl;
    const updates: Record<string, unknown> = { remainingQuantity: newRemaining.toFixed(8), stopLoss: newSl.toFixed(8) };
    if (reason === "tp1") {
      updates.tp1Filled = true;
      updates.tp1FillPrice = fillPrice.toFixed(8);
      updates.tp1FillTime = now;
      updates.breakEvenActive = true;
    } else {
      updates.tp2Filled = true;
      updates.tp2FillPrice = fillPrice.toFixed(8);
      updates.tp2FillTime = now;
    }
    await db.update(tradesTable).set(updates).where(eq(tradesTable.id, trade.id));

    if (newRemaining > 0) {
      const result = await this.host.replaceStopOrder(ex, trade, market, newSl, currentTp, newRemaining, orderIds);
      if (result) {
        orderIds = mergeOrderIds(orderIds, result);
      } else {
        logger.error(
          { tradeId: trade.id, symbol: trade.symbol, reason },
          "Failed to re-place protection after a partial close — position is running with NO exchange-side SL/TP until the next tick retries this",
        );
        await this.host.sendAlert(
          `🚨 ${trade.symbol} (trade #${trade.id}): no SL/TP resting on the exchange after ${reason} filled. Will retry automatically, but please check manually if this recurs.`,
        ).catch(() => {});
      }
    }
    // else: newRemaining === 0 — the whole position was closed via TP1/TP2
    // partials alone (only possible if tp1ClosePercent/tp2ClosePercent were
    // misconfigured to sum to 100%; enterTrade clamps against this, so this
    // branch should not normally be reached). Nothing left to protect.

    logger.info(
      { tradeId: trade.id, symbol: trade.symbol, reason, qty, fillPrice, pnl, newRemaining },
      `${reason.toUpperCase()} partial close filled`,
    );
    return orderIds;
  }
}
