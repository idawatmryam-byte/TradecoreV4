/**
 * TradeCore Pro — ExitManager  (Phase 4A)
 *
 * Centralized exit pipeline. This is the ONLY code in the project allowed to
 * write `status: "closed"` to the trades table. Every way a position can end
 * — a confirmed exchange fill, a price touch that must be reconciled against
 * the exchange, a protective market close, or the max-holding-time exit —
 * funnels through `ExitManager.evaluate()`, which:
 *
 *   1. Determines the exit reason from real exchange state (never assumes a
 *      fill from a candle wick alone).
 *   2. Validates the close: planned vs. actual SL, planned vs. actual TP,
 *      planned vs. actual position size, expected vs. actual P/L, fees, and
 *      slippage — logging any mismatch automatically.
 *   3. Writes the single, final "closed" row.
 *
 * botEngine.ts must not update tradesTable.status directly for an open
 * position — it only calls this class and reacts to the result (cooldowns,
 * risk-pause bookkeeping via the injected host callbacks).
 */
import { db } from "@workspace/db";
import { tradesTable, tradePartialExitsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { normalizeExitReason, type ExitReason } from "./exitTypes";
import { closeFuturesPositionMarket } from "./binanceFutures";

// ccxt OHLCV candle: [timestamp, open, high, low, close, volume]
type Candle = [number, number, number, number, number, number];
type Trade = typeof tradesTable.$inferSelect;

export interface OpenOrderIds {
  tpOrderId: string;
  slOrderId: string;
  /** Set when the final TP+SL pair was placed as one atomic Binance OCO order
   *  list (see lib/binanceOco.ts) rather than two independent orders. When
   *  present, a fill on either leg auto-cancels the other on the exchange
   *  side, so ExitManager/TradeManager must NOT separately cancel the
   *  "remaining" leg in that case. */
  ocoOrderListId?: string;
}

export interface ExitManagerHost {
  /** Current taker fee per side as a fraction (0.001 spot / 0.0005 futures).
   *  A function so it always reflects the engine's ACTIVE market type. */
  readonly takerFee: () => number;
  sendAlert(message: string): Promise<void>;
  setCooldown(symbol: string, minutes: number): void;
  recordHourlyStat(now: Date, pnl: number, win: boolean): Promise<void>;
  /** Called after a validated close whose actual loss exceeded the expected max. */
  recordRiskViolation(tradeId: number, symbol: string, detail: string): void;
  /** Called after a validated close that was NOT a risk violation, to reset any streak. */
  recordCleanClose(): void;
}

export interface ExitOutcome {
  closed: boolean;
  exitReason: ExitReason | null;
  exitPrice: number | null;
  pnl: number | null;
}

const NOT_CLOSED: ExitOutcome = { closed: false, exitReason: null, exitPrice: null, pnl: null };

export class ExitManager {
  constructor(private readonly host: ExitManagerHost) {}

  /**
   * Single entry point. Call this once per scan tick for every open trade.
   * `orderIds` is whatever the caller has cached for this trade's resting
   * TP/SL orders (may be undefined if placement failed for both legs).
   */
  async evaluate(
    ex: any,
    trade: Trade,
    market: string,
    candles1m: Candle[],
    now: Date,
    cooldownMinutes: number,
    maxHoldingSeconds: number | undefined,
    orderIds: OpenOrderIds | undefined,
  ): Promise<ExitOutcome> {
    const sl = Number(trade.stopLoss);
    const tp = Number(trade.takeProfit);

    let exitReason: string | null = null;
    let exitPrice: number | null = null;

    // ── Step 1: trust confirmed exchange order status first ──────────────────
    if (orderIds) {
      const confirmed = await this.checkOrderStatus(ex, trade, market, orderIds, sl, tp);
      exitReason = confirmed.exitReason;
      exitPrice = confirmed.exitPrice;
    }

    // ── Step 2: price-touch fallback — reconcile against the exchange before
    // trusting it; never assume a trade closed just because a candle touched
    // SL/TP ────────────────────────────────────────────────────────────────
    if (!exitReason) {
      const lastCandle = candles1m[candles1m.length - 1];
      if (lastCandle) {
        const [, , high, low] = lastCandle;
        // Futures Phase: a short's SL sits ABOVE entry (hit by price rising)
        // and TP sits BELOW entry (hit by price falling) — mirror of long.
        const isShort = trade.side === "sell";
        const slTouched = isShort ? high >= sl : low <= sl;
        const tpTouched = isShort ? low <= tp : high >= tp;
        if (slTouched || tpTouched) {
          const resolved = await this.reconcilePriceTouch(ex, trade, market, orderIds, sl, tp, slTouched, tpTouched);
          exitReason = resolved.exitReason;
          exitPrice = resolved.exitPrice;
        }
      }
    }

    // ── Step 3: max-holding-time exit ─────────────────────────────────────────
    if (!exitReason && maxHoldingSeconds && maxHoldingSeconds > 0) {
      const heldSeconds = (now.getTime() - new Date(trade.entryTime).getTime()) / 1000;
      if (heldSeconds >= maxHoldingSeconds) {
        const resolved = await this.protectiveMarketClose(ex, trade, market, sl, tp, /* touched */ false, "timeout");
        if (resolved.exitReason) {
          exitReason = resolved.exitReason;
          exitPrice = resolved.exitPrice;
          if (orderIds?.tpOrderId) await ex.cancelOrder(orderIds.tpOrderId, market).catch(() => {});
          if (orderIds?.slOrderId) await ex.cancelOrder(orderIds.slOrderId, market).catch(() => {});
        }
      }
    }

    if (!exitReason || exitPrice === null) return NOT_CLOSED;

    return this.closeTrade(trade, exitReason, exitPrice, now, cooldownMinutes);
  }

  /**
   * Close a trade that isn't going through SL/TP/timeout — e.g. a manual
   * close from the UI, or an emergency/circuit-breaker forced flatten.
   * Still funnels through the same validated `closeTrade()` write.
   */
  async closeManually(
    ex: any,
    trade: Trade,
    market: string,
    now: Date,
    cooldownMinutes: number,
    reason: "manual" | "emergency_stop" | "circuit_breaker",
  ): Promise<ExitOutcome> {
    const resolved = await this.protectiveMarketClose(
      ex, trade, market, Number(trade.stopLoss), Number(trade.takeProfit), false, reason,
    );
    if (!resolved.exitReason || resolved.exitPrice === null) return NOT_CLOSED;
    return this.closeTrade(trade, resolved.exitReason, resolved.exitPrice, now, cooldownMinutes);
  }

  // ---------------------------------------------------------------------------
  // Step 1 helper: confirmed exchange order status
  // ---------------------------------------------------------------------------

  private async checkOrderStatus(
    ex: any,
    trade: Trade,
    market: string,
    orderIds: OpenOrderIds,
    sl: number,
    tp: number,
  ): Promise<{ exitReason: string | null; exitPrice: number | null }> {
    try {
      const [tpStatus, slStatus] = await Promise.all([
        orderIds.tpOrderId ? ex.fetchOrder(orderIds.tpOrderId, market).catch(() => null) : Promise.resolve(null),
        orderIds.slOrderId ? ex.fetchOrder(orderIds.slOrderId, market).catch(() => null) : Promise.resolve(null),
      ]);

      if (tpStatus?.status === "closed" || tpStatus?.status === "filled") {
        if (!orderIds.ocoOrderListId) {
          // Independent-orders fallback path only — a true OCO's other leg
          // is already auto-cancelled by the exchange itself.
          await this.cancelRemainingOCOLeg(ex, market, "take_profit", orderIds).catch((err) =>
            logger.warn({ err }, "Failed to cancel remaining leg"),
          );
        }
        return { exitReason: "take_profit", exitPrice: tpStatus.average ?? tpStatus.price ?? tp };
      }
      if (slStatus?.status === "closed" || slStatus?.status === "filled") {
        if (!orderIds.ocoOrderListId) {
          await this.cancelRemainingOCOLeg(ex, market, "stop_loss", orderIds).catch((err) =>
            logger.warn({ err }, "Failed to cancel remaining leg"),
          );
        }
        return { exitReason: "stop_loss", exitPrice: slStatus.average ?? slStatus.price ?? sl };
      }
    } catch (err) {
      logger.warn({ err, tradeId: trade.id }, "Order status check failed, falling back to price");
    }
    return { exitReason: null, exitPrice: null };
  }

  /** Cancel-the-other-leg fallback used only when NOT running a true OCO
   *  (see OpenOrderIds.ocoOrderListId) — kept for when placeSellOco() falls
   *  back to independent orders (e.g. an older ccxt build). */
  private async cancelRemainingOCOLeg(
    ex: any,
    market: string,
    exitReason: "take_profit" | "stop_loss",
    orderIds: OpenOrderIds,
  ): Promise<void> {
    const remainingId = exitReason === "take_profit" ? orderIds.slOrderId : orderIds.tpOrderId;
    if (remainingId) await ex.cancelOrder(remainingId, market);
  }

  // ---------------------------------------------------------------------------
  // Step 2 helper: price-touch reconciliation
  // ---------------------------------------------------------------------------

  private async reconcilePriceTouch(
    ex: any,
    trade: Trade,
    market: string,
    orderIds: OpenOrderIds | undefined,
    sl: number,
    tp: number,
    slTouched: boolean,
    tpTouched: boolean,
  ): Promise<{ exitReason: string | null; exitPrice: number | null }> {
    let tpFilled = false;
    let slFilled = false;
    let tpFillPrice = tp;
    let slFillPrice = sl;

    // Note: if orderIds.ocoOrderListId is set (a true Binance OCO — see
    // lib/binanceOco.ts), canceling either leg below cancels the WHOLE list
    // on the exchange side, so the second cancel call will simply fail
    // (already resolved) and fall into the same fetchOrder-and-check-status
    // path used for the independent-orders fallback. No special-casing
    // needed here — "already resolved, check what it resolved to" is correct
    // either way.
    if (orderIds?.tpOrderId) {
      try {
        await ex.cancelOrder(orderIds.tpOrderId, market);
      } catch {
        const st = await ex.fetchOrder(orderIds.tpOrderId, market).catch(() => null);
        if (st?.status === "closed" || st?.status === "filled") {
          tpFilled = true;
          tpFillPrice = st.average ?? st.price ?? tp;
        }
      }
    }
    if (orderIds?.slOrderId) {
      try {
        await ex.cancelOrder(orderIds.slOrderId, market);
      } catch {
        const st = await ex.fetchOrder(orderIds.slOrderId, market).catch(() => null);
        if (st?.status === "closed" || st?.status === "filled") {
          slFilled = true;
          slFillPrice = st.average ?? st.price ?? sl;
        }
      }
    }

    if (tpFilled) {
      logger.info({ symbol: trade.symbol, tradeId: trade.id }, "Reconciled: TP order confirmed filled");
      return { exitReason: "take_profit", exitPrice: tpFillPrice };
    }
    if (slFilled) {
      logger.info({ symbol: trade.symbol, tradeId: trade.id }, "Reconciled: SL order confirmed filled");
      return { exitReason: "stop_loss", exitPrice: slFillPrice };
    }

    // Neither leg confirmed filled — both are cancelled now, so the position
    // is unprotected. Price already breached a level, so close at market
    // rather than leave real exposure unprotected until the next scan tick.
    logger.warn(
      { symbol: trade.symbol, tradeId: trade.id, slTouched, tpTouched },
      "Price touched SL/TP but neither resting order filled — closing at market to avoid unprotected exposure",
    );
    return this.protectiveMarketClose(ex, trade, market, sl, tp, true, slTouched ? "stop_loss" : "take_profit");
  }

  // ---------------------------------------------------------------------------
  // Protective market close (unprotected-position flatten)
  // ---------------------------------------------------------------------------

  private async protectiveMarketClose(
    ex: any,
    trade: Trade,
    market: string,
    sl: number,
    tp: number,
    touched: boolean,
    reasonOverride: string,
  ): Promise<{ exitReason: string | null; exitPrice: number | null }> {
    try {
      // Phase 4B: after a TP1/TP2 partial close, `quantity` is the ORIGINAL
      // size — the exchange only holds `remainingQuantity` of base asset.
      // Selling the original quantity here gets rejected for insufficient
      // balance, which silently defeats both the timeout exit and the
      // unprotected-position reconciliation fallback (see closeTrade() below,
      // which already reads remainingQuantity correctly).
      const closeQty = parseFloat(ex.amountToPrecision(market, Number(trade.remainingQuantity ?? trade.quantity)));
      // Futures Phase: a short position (side="sell") is closed by BUYING
      // back; a long (side="buy", spot's only option) is closed by selling.
      const isShort = trade.side === "sell";
      const order = trade.marketType === "futures"
        ? await closeFuturesPositionMarket(ex, market, isShort ? "sell" : "buy", closeQty)
        : await ex.createOrder(market, "market", isShort ? "buy" : "sell", closeQty);
      const fillPrice = order.average ?? order.price ?? (touched ? sl : tp);
      logger.warn(
        { symbol: trade.symbol, tradeId: trade.id, fillPrice, reason: reasonOverride },
        "Protective market close executed",
      );
      return { exitReason: reasonOverride, exitPrice: fillPrice };
    } catch (err) {
      logger.error(
        { err, symbol: trade.symbol, tradeId: trade.id },
        "PROTECTIVE CLOSE FAILED — position may still be open on the exchange, manual intervention required",
      );
      await this.host
        .sendAlert(
          `🚨 Protective close FAILED for ${trade.symbol} (trade #${trade.id}). ` +
            `Position may still be open on the exchange — please check manually.`,
        )
        .catch(() => {});
      // Do not fabricate a close — leave the DB trade "open" and retry next tick.
      return { exitReason: null, exitPrice: null };
    }
  }

  // ---------------------------------------------------------------------------
  // The single, validated "close" write
  // ---------------------------------------------------------------------------

  private async closeTrade(
    trade: Trade,
    rawExitReason: string,
    exitPrice: number,
    now: Date,
    cooldownMinutes: number,
  ): Promise<ExitOutcome> {
    const { reason: exitReason, wasUnknown } = normalizeExitReason(rawExitReason);
    if (wasUnknown) {
      logger.error(
        { symbol: trade.symbol, tradeId: trade.id, rawExitReason },
        "ExitManager: unknown exit reason produced internally — coerced to 'manual'. This is a bug, please report.",
      );
    }

    const entryPrice = Number(trade.entryPrice);
    // Futures Phase: a short (side="sell") profits when price FALLS — every
    // directional P&L calc below multiplies by this so "profit"/"loss"
    // always mean the same thing regardless of side. Long (side="buy",
    // spot's only option) is unaffected (direction=1, identical to before).
    const isShort = trade.side === "sell";
    const direction = isShort ? -1 : 1;
    // Phase 4B: if TP1/TP2 partial closes happened, `quantity` is the ORIGINAL
    // size and `remainingQuantity` is what's actually being closed right now.
    // `stopLoss`/`takeProfit` may already reflect a break-even move, a
    // trailing update, or (with tp3Enabled) a TP2→TP3 target swap — all of
    // which TradeManager wrote directly to these columns, so reading them
    // here automatically picks up the position's current, real state.
    const qty = Number(trade.remainingQuantity ?? trade.quantity);
    const sl = Number(trade.stopLoss);
    const tp = Number(trade.takeProfit);
    const plannedQty = trade.plannedQuantity != null ? Number(trade.plannedQuantity) : Number(trade.quantity);
    const plannedSl = trade.plannedStopLoss != null ? Number(trade.plannedStopLoss) : sl;
    const plannedTp = trade.plannedTakeProfit != null ? Number(trade.plannedTakeProfit) : tp;

    const holdingSeconds = Math.max(0, Math.round((now.getTime() - new Date(trade.entryTime).getTime()) / 1000));

    // ── Validation: fees, slippage, gross vs. net P/L for THIS (final) leg ────
    const takerFee = this.host.takerFee();
    const legFeesUsdt = entryPrice * qty * takerFee + exitPrice * qty * takerFee;
    const legGrossPnl = (exitPrice - entryPrice) * qty * direction;
    const legNetPnl = legGrossPnl - legFeesUsdt;

    // ── Roll in any TP1/TP2 partial closes so pnl/fees reflect the WHOLE trade ─
    const partials = await db
      .select()
      .from(tradePartialExitsTable)
      .where(eq(tradePartialExitsTable.tradeId, trade.id));
    const partialsNetPnl = partials.reduce((s, p) => s + Number(p.pnl), 0);
    const partialsFees = partials.reduce((s, p) => s + Number(p.fees), 0);
    const partialsGrossPnl = partialsNetPnl + partialsFees;

    const feesUsdt = legFeesUsdt + partialsFees;
    const grossPnl = legGrossPnl + partialsGrossPnl;
    const netPnl = legNetPnl + partialsNetPnl;

    const slippageUsdt =
      exitReason === "stop_loss"
        ? Math.abs(exitPrice - sl) * qty
        : exitReason === "take_profit"
          ? Math.abs(exitPrice - tp) * qty
          : 0;

    // ── Validation: planned vs. actual SL/TP/qty — log any drift ──────────────
    // Note: qty drift is checked against the ORIGINAL full quantity, not the
    // current remaining quantity — a smaller remaining qty after a TP1/TP2
    // partial close is expected behavior, not a sizing bug.
    const originalQty = Number(trade.quantity);
    const slDrift = Math.abs(sl - plannedSl);
    const tpDrift = Math.abs(tp - plannedTp);
    const qtyDrift = Math.abs(originalQty - plannedQty);
    const slDriftPct = plannedSl > 0 ? (slDrift / plannedSl) * 100 : 0;
    const tpDriftPct = plannedTp > 0 ? (tpDrift / plannedTp) * 100 : 0;
    const qtyDriftPct = plannedQty > 0 ? (qtyDrift / plannedQty) * 100 : 0;
    // Once TradeManager has legitimately moved SL (break-even/trailing) or TP
    // (TP2→TP3 swap), comparing against the entry-time "planned" values would
    // just re-flag every managed trade as a false positive — skip that part
    // of the check once management has kicked in; qty drift is still always
    // checked against the ORIGINAL quantity (unaffected by partial closes).
    const managementActive = trade.breakEvenActive || trade.trailingStopActive || trade.tp2Filled;
    if ((!managementActive && (slDriftPct > 0.5 || tpDriftPct > 0.5)) || qtyDriftPct > 0.5) {
      logger.warn(
        {
          tradeId: trade.id, symbol: trade.symbol,
          plannedSl, actualSl: sl, slDriftPct: slDriftPct.toFixed(3),
          plannedTp, actualTp: tp, tpDriftPct: tpDriftPct.toFixed(3),
          plannedQty, actualQty: originalQty, qtyDriftPct: qtyDriftPct.toFixed(3),
        },
        "TRADE_VALIDATION_MISMATCH: planned vs. actual SL/TP/qty drifted more than 0.5%",
      );
    }

    // ── Validation: expected max loss vs. actual loss (risk audit) ─────────────
    // pnlPerUnit(price): positive = profit direction, negative = loss
    // direction, regardless of long/short — see `direction` above.
    const pnlPerUnit = (price: number) => (price - entryPrice) * direction;
    const storedSlValid = sl > 0 && pnlPerUnit(sl) < 0;
    const expectedMaxLossUsdt = storedSlValid ? Math.max(0, -pnlPerUnit(sl) * qty) : 0;
    const exitPnlPerUnit = pnlPerUnit(exitPrice);
    const actualLossUsdt = exitPnlPerUnit < 0 ? -exitPnlPerUnit * qty : 0;
    const actualProfitUsdt = exitPnlPerUnit > 0 ? exitPnlPerUnit * qty : 0;
    const expectedProfitUsdt = Math.max(0, pnlPerUnit(tp) * qty);
    const tolerance = Math.max(0.1, expectedMaxLossUsdt * 0.02) + feesUsdt;
    const isRiskViolation =
      storedSlValid && actualLossUsdt > 0 && expectedMaxLossUsdt > 0 && actualLossUsdt > expectedMaxLossUsdt + tolerance;

    logger.info(
      {
        tradeId: trade.id, symbol: trade.symbol, exitReason,
        entryPrice: entryPrice.toFixed(6), exitPrice: exitPrice.toFixed(6),
        slPrice: sl.toFixed(6), tpPrice: tp.toFixed(6), qty: qty.toFixed(6),
        holdingSeconds,
        expectedMaxLossUsdt: expectedMaxLossUsdt.toFixed(4),
        actualLossUsdt: actualLossUsdt.toFixed(4),
        actualProfitUsdt: actualProfitUsdt.toFixed(4),
        expectedProfitUsdt: expectedProfitUsdt.toFixed(4),
        feesUsdt: feesUsdt.toFixed(4),
        slippageUsdt: slippageUsdt.toFixed(4),
        toleranceUsdt: tolerance.toFixed(4),
        grossPnl: grossPnl.toFixed(4),
        netPnl: netPnl.toFixed(4),
        riskViolation: isRiskViolation,
      },
      "TRADE_RISK_AUDIT",
    );

    const riskViolationReason = isRiskViolation
      ? `Loss ${actualLossUsdt.toFixed(4)} USDT > expected ${expectedMaxLossUsdt.toFixed(4)} + tolerance ${tolerance.toFixed(4)} USDT`
      : undefined;

    await db
      .update(tradesTable)
      .set({
        status: "closed",
        exitPrice: exitPrice.toFixed(8),
        exitTime: now,
        exitReason,
        pnl: netPnl.toFixed(8),
        grossPnl: grossPnl.toFixed(8),
        feesUsdt: feesUsdt.toFixed(8),
        slippageUsdt: slippageUsdt.toFixed(8),
        holdingSeconds,
        ...(isRiskViolation && { riskViolation: true, riskViolationReason }),
      })
      .where(eq(tradesTable.id, trade.id));

    await this.host.recordHourlyStat(now, netPnl, netPnl > 0);
    this.host.setCooldown(trade.symbol, cooldownMinutes);

    if (isRiskViolation) {
      this.host.recordRiskViolation(trade.id, trade.symbol, riskViolationReason!);
    } else if (storedSlValid) {
      this.host.recordCleanClose();
    }

    logger.info({ symbol: trade.symbol, netPnl: netPnl.toFixed(4), exitReason }, "Trade closed");

    return { closed: true, exitReason, exitPrice, pnl: netPnl };
  }
}
