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
  /** Called after every close (the trade row is fully written) so the host can
   *  generate + persist the post-trade analysis. Best-effort — must never
   *  throw back into the close path. */
  onTradeClosed(tradeId: number): void;
}

export interface ExitOutcome {
  closed: boolean;
  exitReason: ExitReason | null;
  exitPrice: number | null;
  pnl: number | null;
}

const NOT_CLOSED: ExitOutcome = { closed: false, exitReason: null, exitPrice: null, pnl: null };

/** Binance USDⓈ-M rejections that mean "there is no position to reduce":
 *  -2022 ReduceOnly Order is rejected; -4118 reduce-only conflict. Matched
 *  loosely on code or wording since ccxt wraps them in its own error text. */
function looksLikeNoPositionError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return msg.includes("-2022") || msg.includes("-4118") || (msg.includes("reduceonly") && msg.includes("reject"));
}

/** Best-effort exit price for a position that closed outside our tracking:
 *  weighted average of actual closing fills since entry when the exchange
 *  still has them, else the current ticker, else entry (neutral placeholder). */
async function bestEffortExitPrice(ex: any, trade: Trade, market: string): Promise<number> {
  const closingSide = trade.side === "sell" ? "buy" : "sell";
  try {
    const myTrades: any[] = await ex.fetchMyTrades(market, undefined, 20);
    const entryTime = new Date(trade.entryTime).getTime();
    const fills = myTrades.filter((t) => t.side === closingSide && t.timestamp >= entryTime);
    const qty = fills.reduce((s, t) => s + Number(t.amount), 0);
    if (qty > 0) {
      return fills.reduce((s, t) => s + Number(t.amount) * Number(t.price), 0) / qty;
    }
  } catch { /* fall through */ }
  try {
    const ticker = await ex.fetchTicker(market);
    const last = Number(ticker?.last ?? ticker?.close ?? 0);
    if (last > 0) return last;
  } catch { /* fall through */ }
  return Number(trade.entryPrice);
}

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

    // ── Step 3: time-based exits ─────────────────────────────────────────────
    if (!exitReason) {
      const heldSeconds = (now.getTime() - new Date(trade.entryTime).getTime()) / 1000;
      const hardTimeout = !!maxHoldingSeconds && maxHoldingSeconds > 0 && heldSeconds >= maxHoldingSeconds;

      // Stale-thesis exit ("time stop"): a plan-carrying trade sitting well
      // past its EXPECTED resolution time with price going nowhere gets cut
      // early instead of blocking capital until the hard deadline — observed
      // live: a "20-minute" trade held 2 hours at +0.01% unrealized. Fires
      // only when the move is genuinely dead (within ±0.25R of entry) —
      // winners and losers in progress are left to their stops/targets.
      // Legacy trades persist expectedHold = the hard max hold, so 1.5× that
      // can never fire before the hard timeout — their behavior is unchanged.
      let staleTimeout = false;
      const expectedHold = Number(trade.expectedHoldSeconds);
      // Fire only on a GENUINELY dead trade: held ≥ 2× its expected
      // resolution AND still within ±0.15R of entry (the move never
      // developed in either direction). Tighter than a first cut so trades
      // that are quietly working toward their target are left alone.
      if (!hardTimeout && expectedHold > 0 && heldSeconds >= expectedHold * 2) {
        const lastClose = candles1m[candles1m.length - 1]?.[4];
        const entry = Number(trade.entryPrice);
        const plannedSl = Number(trade.plannedStopLoss ?? trade.stopLoss);
        const risk = Math.abs(entry - plannedSl);
        if (lastClose != null && risk > 0) {
          const isShort = trade.side === "sell";
          const unrealizedR = (isShort ? entry - lastClose : lastClose - entry) / risk;
          if (Math.abs(unrealizedR) <= 0.15) {
            staleTimeout = true;
            logger.info(
              {
                tradeId: trade.id, symbol: trade.symbol,
                heldMinutes: Math.round(heldSeconds / 60),
                expectedMinutes: Math.round(expectedHold / 60),
                unrealizedR: unrealizedR.toFixed(2),
              },
              "Stale-thesis exit — held well past the expected resolution with price going nowhere",
            );
          }
        }
      }

      if (hardTimeout || staleTimeout) {
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
    orderIds?: OpenOrderIds,
  ): Promise<ExitOutcome> {
    // Cancel the resting SL/TP legs BEFORE the market close: on spot the OCO
    // holds the asset balance (a market sell against locked funds is rejected
    // — the close would silently fail), and on futures skipping this leaves
    // orphaned reduceOnly triggers behind after the position is gone.
    if (orderIds?.tpOrderId) await ex.cancelOrder(orderIds.tpOrderId, market).catch(() => {});
    if (orderIds?.slOrderId) await ex.cancelOrder(orderIds.slOrderId, market).catch(() => {});
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

      // Determine the REAL fill price. The old fallback here was
      // `order.average ?? order.price ?? (touched ? sl : tp)` — but Binance
      // futures (testnet especially) often returns a market order with NO
      // average/price in the create response, so every TIMEOUT close (touched
      // = false) fell through to `tp` and was recorded as a full take-profit
      // win that never happened. Observed live: 51/51 "wins", each pinned at
      // exactly the planned TP price, all exitReason=timeout. A market close
      // says nothing about where price is, so the honest chain is: the
      // order's own fill → re-fetch the order for its fill → the current
      // market price. Only a touched level may fall back to that level
      // (price demonstrably reached it); a timeout with everything unknown
      // falls back to entry (bounded drift error, not a fabricated +13% win).
      let fillPrice: number | null = order.average ?? order.price ?? null;
      if (fillPrice == null && order.id != null) {
        try {
          const fetched = await ex.fetchOrder(String(order.id), market);
          fillPrice = fetched?.average ?? fetched?.price ?? null;
        } catch { /* fall through to ticker */ }
      }
      if (fillPrice == null) {
        try {
          const ticker = await ex.fetchTicker(market);
          fillPrice = ticker?.last ?? ticker?.close ?? null;
        } catch { /* fall through to last resort */ }
      }
      if (fillPrice == null) {
        fillPrice = touched ? (reasonOverride === "stop_loss" ? sl : tp) : Number(trade.entryPrice);
        logger.error(
          { symbol: trade.symbol, tradeId: trade.id, reason: reasonOverride, fallbackPrice: fillPrice },
          "Protective close: no fill price from order, fetchOrder, or ticker — recorded P&L is an approximation",
        );
      }
      logger.warn(
        { symbol: trade.symbol, tradeId: trade.id, fillPrice, reason: reasonOverride },
        "Protective market close executed",
      );
      return { exitReason: reasonOverride, exitPrice: fillPrice };
    } catch (err) {
      // PHANTOM-POSITION DETECTION: a futures reduceOnly close rejected with
      // "no position to reduce" means the position ALREADY closed on the
      // exchange (liquidated, or closed while the bot was offline) and the DB
      // row is stale. Without this, the trade loops forever: every scan (and
      // every manual Close click) retries the same close, Binance rejects it
      // the same way, and the row can never be cleared — observed live as a
      // 71-hour "open" position whose stop had been blown through days
      // earlier. Verify with fetchPositions before trusting the error, then
      // resolve the close with a best-effort exit price instead of failing.
      if (trade.marketType === "futures" && looksLikeNoPositionError(err)) {
        try {
          const positions: any[] = await ex.fetchPositions([market]);
          const live = positions.find((p) => p.symbol === market && Math.abs(Number(p.contracts ?? 0)) > 0);
          if (!live) {
            const exitPrice = await bestEffortExitPrice(ex, trade, market);
            logger.error(
              { symbol: trade.symbol, tradeId: trade.id, exitPrice },
              "PHANTOM POSITION: exchange holds no position for this open trade — it closed/liquidated outside our tracking. Marking reconciled_missing with a best-effort exit price.",
            );
            await this.host
              .sendAlert(
                `⚠️ ${trade.symbol} (trade #${trade.id}) no longer exists on the exchange — it closed or was liquidated ` +
                  `while untracked. Recorded with a best-effort exit price of ${exitPrice.toFixed(6)}; verify on Binance.`,
              )
              .catch(() => {});
            return { exitReason: "reconciled_missing", exitPrice };
          }
        } catch (verifyErr) {
          logger.warn({ err: verifyErr, tradeId: trade.id }, "Phantom-position verification (fetchPositions) failed — falling through to normal close-failure handling");
        }
      }
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

    // ADMINISTRATIVE closes (reconciled_missing: the position already died on
    // the exchange while untracked — liquidation or offline close) are
    // bookkeeping, NOT live trade-management outcomes. They must not feed any
    // of the machinery that reacts to live trading quality: the risk-violation
    // streak (3 strikes pauses ALL entries), the hourly stats that drive
    // toxic-hour skips, the symbol cooldown, or the post-trade learning
    // memory. Observed live: sweeping 5 stale liquidated positions recorded
    // their (days-old) losses as fresh violations/PnL and silently froze the
    // engine for hours via risk-pause + daily circuit breaker.
    const administrative = exitReason === "reconciled_missing";

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
        ...(isRiskViolation && !administrative && { riskViolation: true, riskViolationReason }),
      })
      .where(eq(tradesTable.id, trade.id));

    if (!administrative) {
      await this.host.recordHourlyStat(now, netPnl, netPnl > 0);
      this.host.setCooldown(trade.symbol, cooldownMinutes);

      if (isRiskViolation) {
        this.host.recordRiskViolation(trade.id, trade.symbol, riskViolationReason!);
      } else if (storedSlValid) {
        this.host.recordCleanClose();
      }
    }

    logger.info({ symbol: trade.symbol, netPnl: netPnl.toFixed(4), exitReason, administrative }, "Trade closed");

    // Generate + persist the post-trade analysis (best-effort; the host swallows
    // its own errors so a failure here can never affect the actual close).
    // Administrative closes are excluded — their prices are best-effort
    // placeholders, and the learning memory must only ever hold real outcomes.
    if (!administrative) {
      this.host.onTradeClosed(trade.id);
    }

    return { closed: true, exitReason, exitPrice, pnl: netPnl };
  }
}
