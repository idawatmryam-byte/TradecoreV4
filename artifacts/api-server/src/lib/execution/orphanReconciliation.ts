export type OrphanSweepResult =
  | { state: "verified"; cancelled: number; inspectedSymbols: number }
  | {
      state: "unverified";
      cancelled: number;
      inspectedSymbols: number;
      reason: string;
    };

interface OrphanExchange {
  fetchPositions(symbols?: string[]): Promise<unknown[]>;
  fetchOpenOrders(symbol: string): Promise<unknown[]>;
  cancelOrder(id: string, symbol: string): Promise<unknown>;
}

interface PositionLike {
  symbol?: unknown;
  contracts?: unknown;
}

interface OrderLike {
  id?: unknown;
  symbol?: unknown;
  type?: unknown;
  reduceOnly?: unknown;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reconcile Binance Futures protective-order orphans without ever issuing an
 * unscoped fetchOpenOrders call. All provider reads complete first. If any
 * symbol is unknown, no cancellation begins: partial knowledge cannot prove
 * that an order is orphaned.
 */
export async function sweepBinanceFuturesOrphans(input: {
  exchange: OrphanExchange;
  configuredMarkets: readonly string[];
  trackedMarkets: readonly string[];
}): Promise<OrphanSweepResult> {
  let rawPositions: unknown[];
  try {
    rawPositions = await input.exchange.fetchPositions();
  } catch (error) {
    return {
      state: "unverified",
      cancelled: 0,
      inspectedSymbols: 0,
      reason: `fetchPositions failed: ${detail(error)}`,
    };
  }

  const active = new Set(input.trackedMarkets);
  const livePositionMarkets: string[] = [];
  for (const raw of rawPositions) {
    const position = raw as PositionLike;
    if (
      typeof position.symbol !== "string" ||
      Math.abs(Number(position.contracts ?? 0)) <= 0
    )
      continue;
    active.add(position.symbol);
    livePositionMarkets.push(position.symbol);
  }

  const candidates = [
    ...new Set([
      ...input.configuredMarkets,
      ...input.trackedMarkets,
      ...livePositionMarkets,
    ]),
  ].sort();
  const orders: OrderLike[] = [];
  for (const market of candidates) {
    try {
      const rows = await input.exchange.fetchOpenOrders(market);
      for (const raw of rows ?? []) orders.push(raw as OrderLike);
    } catch (error) {
      return {
        state: "unverified",
        cancelled: 0,
        inspectedSymbols: candidates.indexOf(market),
        reason: `fetchOpenOrders(${market}) failed: ${detail(error)}`,
      };
    }
  }

  const orphaned = new Map<string, { id: string; symbol: string }>();
  for (const order of orders) {
    if (typeof order.id !== "string" && typeof order.id !== "number") continue;
    if (typeof order.symbol !== "string" || active.has(order.symbol)) continue;
    const type = String(order.type ?? "").toUpperCase();
    const protective =
      order.reduceOnly === true ||
      type.includes("STOP") ||
      type.includes("TAKE_PROFIT");
    if (!protective) continue;
    orphaned.set(`${order.symbol}:${String(order.id)}`, {
      id: String(order.id),
      symbol: order.symbol,
    });
  }

  let cancelled = 0;
  for (const order of orphaned.values()) {
    try {
      await input.exchange.cancelOrder(order.id, order.symbol);
      cancelled++;
    } catch (error) {
      return {
        state: "unverified",
        cancelled,
        inspectedSymbols: candidates.length,
        reason: `cancelOrder(${order.symbol}, ${order.id}) failed: ${detail(error)}`,
      };
    }
  }
  return { state: "verified", cancelled, inspectedSymbols: candidates.length };
}
