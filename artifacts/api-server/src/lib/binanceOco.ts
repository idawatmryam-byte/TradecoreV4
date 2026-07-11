/**
 * TradeCore Pro — Binance true-OCO helper  (Phase 4B follow-up)
 *
 * Fixes the "no true OCO" gap flagged in ARCHITECTURE.md: the SL and final
 * take-profit for the protected remainder of a position are now placed as a
 * single atomic Binance OCO (One-Cancels-the-Other) order list instead of
 * two independent resting orders, so the exchange locks the asset ONCE for
 * that qty instead of trying to reserve it twice.
 *
 * Verified against Binance's current REST API docs
 * (https://developers.binance.com/docs/binance-spot-api-docs/rest-api/trading-endpoints#new-order-list---oco-trade):
 *   - `POST /api/v3/order/oco` is deprecated; the replacement is
 *     `POST /api/v3/orderList/oco`, with a DIFFERENT parameter shape
 *     (aboveType/belowType instead of an implicit type per side).
 *   - For a SELL-side OCO (closing a long): the "above" leg (price above
 *     market) is the take-profit (`LIMIT_MAKER`), the "below" leg (price
 *     below market) is the stop-loss (`STOP_LOSS_LIMIT`).
 *
 * What is NOT independently verified: whether ccxt 4.5.63 (the version
 * pinned in this project's lockfile) has already added an implicit/raw
 * method for this endpoint. ccxt mechanically derives a raw method name from
 * every documented REST path (this is how EVERY implicit ccxt method is
 * generated, not exchange-specific behavior) — `POST /api/v3/orderList/oco`
 * becomes `privatePostOrderListOco` — and ccxt has supported the older
 * `/api/v3/order/oco` endpoint the same way since 2019, so this is a
 * well-established mechanical pattern, not a guess at business logic. Still,
 * I could not run `npm ls ccxt` / inspect the installed source in this
 * environment (no network), so `placeSellOco()` checks for the method's
 * existence at runtime and returns `null` instead of throwing if it's
 * missing, letting the caller fall back to the old two-independent-orders
 * behavior rather than crashing. **Test on Binance testnet before relying on
 * this for live capital.**
 */
import { logger } from "./logger";

export interface OcoResult {
  orderListId: string;
  tpOrderId: string;
  slOrderId: string;
}

/**
 * Place a SELL OCO: take-profit (LIMIT_MAKER) above market + stop-loss
 * (STOP_LOSS_LIMIT) below market, as one atomic order list.
 * Returns null (never throws) if the ccxt version lacks the raw method, or
 * if Binance's response doesn't have the shape we expect — callers must
 * treat `null` as "fall back to independent orders," not as an error.
 */
export async function placeSellOco(
  ex: any,
  market: string,
  qty: number,
  tpPrice: number,
  slPrice: number,
  slLimitPrice: number,
): Promise<OcoResult | null> {
  if (typeof ex.privatePostOrderListOco !== "function") {
    logger.warn(
      { market },
      "ccxt build has no privatePostOrderListOco — falling back to independent TP+SL orders (see lib/binanceOco.ts header for why this matters)",
    );
    return null;
  }

  try {
    const marketId = ex.market(market).id;
    const response = await ex.privatePostOrderListOco({
      symbol: marketId,
      side: "SELL",
      quantity: ex.amountToPrecision(market, qty),
      aboveType: "LIMIT_MAKER",
      abovePrice: ex.priceToPrecision(market, tpPrice),
      belowType: "STOP_LOSS_LIMIT",
      belowPrice: ex.priceToPrecision(market, slLimitPrice),
      belowStopPrice: ex.priceToPrecision(market, slPrice),
      belowTimeInForce: "GTC",
    });

    const reports: any[] = response?.orderReports ?? [];
    const tpLeg = reports.find((r) => r.type === "LIMIT_MAKER" || r.type === "TAKE_PROFIT_LIMIT" || r.type === "TAKE_PROFIT");
    const slLeg = reports.find((r) => r.type === "STOP_LOSS_LIMIT" || r.type === "STOP_LOSS");
    const orderListId = response?.orderListId;

    if (!tpLeg || !slLeg || orderListId === undefined) {
      logger.error(
        { market, response },
        "OCO placed but response shape didn't match expectations — treating as failed so caller falls back",
      );
      return null;
    }

    return { orderListId: String(orderListId), tpOrderId: String(tpLeg.orderId), slOrderId: String(slLeg.orderId) };
  } catch (err) {
    logger.warn({ err, market }, "True OCO placement failed — falling back to independent TP+SL orders");
    return null;
  }
}

/** Cancel an entire OCO order list (both legs at once). Best-effort. */
export async function cancelOco(ex: any, market: string, orderListId: string): Promise<void> {
  if (typeof ex.privateDeleteOrderList !== "function") return;
  try {
    const marketId = ex.market(market).id;
    await ex.privateDeleteOrderList({ symbol: marketId, orderListId });
  } catch (err) {
    logger.warn({ err, market, orderListId }, "Failed to cancel OCO order list (may already be filled/cancelled)");
  }
}
