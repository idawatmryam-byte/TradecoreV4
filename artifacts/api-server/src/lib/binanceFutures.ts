/**
 * TradeCore Pro — Binance USDⓈ-M Futures order helpers  (Futures Phase)
 *
 * Futures order management is structurally different from spot
 * (lib/binanceOco.ts) in one critical way: Binance USDⓈ-M Futures has NO
 * atomic OCO order-list endpoint. A stop-loss (STOP_MARKET, reduceOnly) and
 * take-profit (TAKE_PROFIT_MARKET, reduceOnly) are always two INDEPENDENT
 * resting orders — filling one does NOT auto-cancel the other the way a
 * spot OCO does. This is exactly the "independent orders" code path
 * ExitManager/TradeManager already support for spot's own OCO-placement-
 * failure fallback (see exitManager.ts: `orderIds.ocoOrderListId` is simply
 * never set for a futures trade, so the existing "cancel the other leg on
 * fill" logic applies unchanged — no changes needed there for this reason).
 *
 * Uses ccxt's raw/implicit `fapiPrivate*` methods (mechanically generated
 * from Binance's documented USDⓈ-M Futures REST API — same reasoning as
 * binanceOco.ts) rather than ccxt's unified order-type strings, since a
 * futures STOP_MARKET/TAKE_PROFIT_MARKET reduceOnly order is exchange-
 * specific enough that unified-API behavior varies across ccxt versions.
 * Verified against Binance's current USDⓈ-M Futures API docs
 * (https://developers.binance.com/docs/derivatives/usds-margined-futures/trade-api):
 *   - `POST /fapi/v1/order` with type=STOP_MARKET/TAKE_PROFIT_MARKET,
 *     `stopPrice`, `reduceOnly=true`, `closePosition=false` (partial-qty
 *     reduce, not "close the whole position").
 * What is NOT independently verified: whether ccxt 4.5.62 (pinned in this
 * project's lockfile) has already exposed `fapiPrivatePostOrder` with the
 * exact param names Binance expects for these types (confirmed present as a
 * *method* in this environment — see below — but not confirmed against a
 * live/testnet account, since this sandbox has no network access to
 * Binance). **Test on Binance Futures testnet before relying on this for
 * live capital**, same caveat as binanceOco.ts.
 */
import { logger } from "./logger";

export interface FuturesStopTpResult {
  slOrderId: string;
  tpOrderId: string;
}

/**
 * Place independent reduceOnly STOP_MARKET + TAKE_PROFIT_MARKET orders that
 * close (all or part of) an open futures position. `positionSide` is the
 * side the position was OPENED with ("buy" = long, "sell" = short) — the
 * closing orders below use the opposite side, same convention as spot.
 * Returns null (never throws) if either leg fails to place; caller must
 * treat that as "no exchange-side protection yet" and retry, same handling
 * as an OCO placement failure on spot.
 */
export async function placeFuturesStopAndTakeProfit(
  ex: any,
  market: string,
  positionSide: "buy" | "sell",
  qty: number,
  slPrice: number,
  tpPrice: number,
): Promise<FuturesStopTpResult | null> {
  if (typeof ex.fapiPrivatePostOrder !== "function") {
    logger.warn({ market }, "ccxt build has no fapiPrivatePostOrder — cannot place futures stop/take-profit orders");
    return null;
  }

  const closingSide = positionSide === "buy" ? "SELL" : "BUY";
  const marketId = ex.market(market).id;
  const preciseQty = ex.amountToPrecision(market, qty);

  let slOrderId = "";
  let tpOrderId = "";

  try {
    const slOrder = await ex.fapiPrivatePostOrder({
      symbol: marketId,
      side: closingSide,
      type: "STOP_MARKET",
      quantity: preciseQty,
      stopPrice: ex.priceToPrecision(market, slPrice),
      reduceOnly: "true",
    });
    slOrderId = String(slOrder?.orderId ?? "");
  } catch (err) {
    logger.error({ err, market, positionSide }, "Futures STOP_MARKET placement failed");
  }

  try {
    const tpOrder = await ex.fapiPrivatePostOrder({
      symbol: marketId,
      side: closingSide,
      type: "TAKE_PROFIT_MARKET",
      quantity: preciseQty,
      stopPrice: ex.priceToPrecision(market, tpPrice),
      reduceOnly: "true",
    });
    tpOrderId = String(tpOrder?.orderId ?? "");
  } catch (err) {
    logger.error({ err, market, positionSide }, "Futures TAKE_PROFIT_MARKET placement failed");
  }

  if (!slOrderId && !tpOrderId) return null;
  return { slOrderId, tpOrderId };
}

/** ReduceOnly market order to flatten (all or part of) a futures position immediately. */
export async function closeFuturesPositionMarket(
  ex: any,
  market: string,
  positionSide: "buy" | "sell",
  qty: number,
): Promise<any> {
  const closingSide = positionSide === "buy" ? "sell" : "buy";
  const preciseQty = ex.amountToPrecision(market, qty);
  return ex.createOrder(market, "market", closingSide, preciseQty, undefined, { reduceOnly: true });
}

/**
 * Per-symbol max leverage, cached per exchange instance (one instance per
 * user). Brackets are effectively static for an account, and this sits on
 * the entry hot path, so it must not re-query the exchange on every scan.
 */
const maxLeverageCache = new WeakMap<object, Map<string, number>>();

/**
 * Resolves the highest leverage Binance actually allows for `market`, or
 * null if it can't be determined (caller must then not clamp).
 *
 * `market.limits.leverage` is NOT usable here: ccxt builds binanceusdm
 * markets from `exchangeInfo`, which carries no leverage data, so that
 * object is always `{}` for every USDⓈ-M symbol. The only source of truth
 * is the leverage-bracket endpoint (`fetchMarketLeverageTiers` → private
 * /fapi/v1/leverageBracket), whose top tier holds the symbol's max.
 */
async function resolveMaxLeverage(ex: any, market: string): Promise<number | null> {
  let perExchange = maxLeverageCache.get(ex);
  if (!perExchange) {
    perExchange = new Map();
    maxLeverageCache.set(ex, perExchange);
  }
  const cached = perExchange.get(market);
  if (cached !== undefined) return cached;

  // Kept as a fast path for any exchange/ccxt version that does populate it.
  const fromLimits = Number(ex.market(market)?.limits?.leverage?.max ?? 0);
  if (fromLimits > 0) {
    perExchange.set(market, fromLimits);
    return fromLimits;
  }

  try {
    const tiers: any[] = await ex.fetchMarketLeverageTiers(market);
    const max = Math.max(
      0,
      ...(tiers ?? []).map((t) => Number(t?.maxLeverage ?? 0)).filter((n) => Number.isFinite(n) && n > 0),
    );
    if (max > 0) {
      perExchange.set(market, max);
      return max;
    }
    logger.warn({ market }, "Leverage brackets returned no usable maxLeverage — cannot clamp leverage");
  } catch (err) {
    logger.warn({ err, market }, "Failed to fetch leverage brackets — cannot clamp leverage");
  }
  return null;
}

/**
 * Sets leverage and margin mode for a symbol before opening a position.
 * Best-effort: Binance rejects a margin-mode call with "no need to change"
 * if it's already set to that mode — treated as success, not an error.
 *
 * Binance caps max leverage per symbol (varies widely — a major pair may
 * allow 125x, a low-cap altcoin often caps at 20x or less). Sending a
 * too-high value makes `setLeverage` throw -4028 and fails the whole entry
 * instead of trading at the highest leverage actually available, so clamp
 * to the symbol's real bracket max first. Returns the leverage actually
 * applied so the caller sizes margin and records the trade against the real
 * value, not the requested one.
 */
export async function configureFuturesLeverage(
  ex: any,
  market: string,
  leverage: number,
  marginMode: "isolated" | "cross",
): Promise<number> {
  const maxAllowed = await resolveMaxLeverage(ex, market);
  const effectiveLeverage = maxAllowed !== null ? Math.min(leverage, maxAllowed) : leverage;
  if (effectiveLeverage < leverage) {
    logger.warn(
      { market, requestedLeverage: leverage, maxAllowed, effectiveLeverage },
      "Requested leverage exceeds this symbol's exchange maximum — clamped down",
    );
  }

  try {
    await ex.setMarginMode(marginMode, market);
  } catch (err) {
    logger.debug({ err, market, marginMode }, "setMarginMode no-op (likely already set to this mode)");
  }

  try {
    await ex.setLeverage(effectiveLeverage, market);
  } catch (err) {
    // -4028 = "Leverage N is not valid". Only reachable if the bracket max
    // was unavailable or has since tightened, so drop the cached value and
    // retry once against a fresh bracket read rather than failing the entry.
    if (!String((err as Error)?.message ?? "").includes("-4028")) throw err;

    maxLeverageCache.get(ex)?.delete(market);
    const refreshedMax = await resolveMaxLeverage(ex, market);
    if (refreshedMax === null || refreshedMax >= effectiveLeverage) throw err;

    logger.warn(
      { market, rejectedLeverage: effectiveLeverage, refreshedMax },
      "Exchange rejected leverage (-4028) — retrying at this symbol's refreshed maximum",
    );
    await ex.setLeverage(refreshedMax, market);
    return refreshedMax;
  }
  return effectiveLeverage;
}

/**
 * Fetches the exchange-computed liquidation price for an open position, or
 * null if the position can't be found (e.g. not yet reflected in a fresh
 * fetch right after opening — caller should treat null as "unknown, be
 * conservative" rather than "no liquidation risk").
 */
export async function getLiquidationPrice(ex: any, market: string): Promise<number | null> {
  try {
    const positions: any[] = await ex.fetchPositions([market]);
    const position = positions.find((p) => p.symbol === market && Number(p.contracts ?? 0) > 0);
    const liq = Number(position?.liquidationPrice ?? 0);
    return liq > 0 ? liq : null;
  } catch (err) {
    logger.warn({ err, market }, "fetchPositions failed — cannot determine liquidation price");
    return null;
  }
}
