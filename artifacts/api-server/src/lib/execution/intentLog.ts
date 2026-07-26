/**
 * TradeCore Pro — Execution intent log
 *
 * Writes down what we are about to do BEFORE we do it, so a crash mid-order
 * leaves evidence instead of a mystery.
 *
 * The window this protects (botEngine.enterTrade):
 *
 *     ex.createOrder(...)        ← a real position now exists
 *     ...re-anchor SL/TP, validity guards, liquidation check...
 *     db.insert(tradesTable)     ← only NOW does the engine know about it
 *
 * Die anywhere between those and the venue holds a funded, unprotected
 * position the database has never seen. Startup reconciliation can find the
 * position, but not the *intent*: which strategy asked for it, and what stop
 * it was supposed to be protected by. An intent row carries exactly that.
 *
 * Every function here is best-effort by design. The intent log is an
 * observability and recovery aid, and it must never be the reason a trade
 * fails to record or a position goes unprotected — the money path's own
 * guards are authoritative. Failures are logged and swallowed.
 */
import { randomUUID } from "crypto";
import { db, executionEventsTable, executionIntentsTable } from "@workspace/db";
import type { ExecutionState } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { makeClientOrderId } from "./ids";

export { makeClientOrderId };

/** A live intent row we can advance as the order progresses. */
export interface IntentHandle {
  id: number;
  correlationId: string;
  clientOrderId: string;
  state: ExecutionState;
}

export interface OpenIntentArgs {
  userId: number;
  section: string;
  planFingerprint: string;
  symbol: string;
  /** Order side that OPENS the position. */
  side: string;
  marketType: string;
  strategyId?: string;
  plannedEntryPrice: number;
  plannedStopLoss: number;
  plannedTakeProfit: number;
  plannedQuantity: number;
  plannedLeverage?: number;
}

/**
 * Record the intent and return a handle. Call immediately before the broker
 * call — after every pre-flight refusal, so a refused entry leaves no row.
 *
 * Returns null if the write fails; callers treat a null handle as "no
 * logging available" and carry on placing the order.
 */
export async function openIntent(args: OpenIntentArgs): Promise<IntentHandle | null> {
  const correlationId = randomUUID();
  const clientOrderId = makeClientOrderId(args.userId);
  try {
    const [row] = await db
      .insert(executionIntentsTable)
      .values({
        userId: args.userId,
        section: args.section,
        correlationId,
        clientOrderId,
        planFingerprint: args.planFingerprint,
        symbol: args.symbol,
        side: args.side,
        marketType: args.marketType,
        ...(args.strategyId && { strategyId: args.strategyId }),
        plannedEntryPrice: args.plannedEntryPrice.toFixed(8),
        plannedStopLoss: args.plannedStopLoss.toFixed(8),
        plannedTakeProfit: args.plannedTakeProfit.toFixed(8),
        plannedQuantity: args.plannedQuantity.toFixed(8),
        ...(args.plannedLeverage != null && { plannedLeverage: args.plannedLeverage }),
        state: "INTENT_RECORDED",
      })
      .returning();
    if (!row) return null;

    await appendEvent(row.id, null, "INTENT_RECORDED", "intent persisted before broker call");
    return { id: row.id, correlationId, clientOrderId, state: "INTENT_RECORDED" };
  } catch (err) {
    // Never block the trade on the audit trail.
    logger.warn({ err, symbol: args.symbol }, "Could not record execution intent — continuing without it");
    return null;
  }
}

/**
 * Advance an intent. Appends the immutable event and updates the projection.
 * No-ops on a null handle so call sites stay free of null checks.
 */
export async function advanceIntent(
  handle: IntentHandle | null,
  toState: ExecutionState,
  reason?: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  if (!handle) return;
  const fromState = handle.state;
  handle.state = toState; // keep the in-memory handle usable even if the write fails
  try {
    await appendEvent(handle.id, fromState, toState, reason, payload);
    await db
      .update(executionIntentsTable)
      .set({ state: toState })
      .where(eq(executionIntentsTable.id, handle.id));
  } catch (err) {
    logger.warn({ err, intentId: handle.id, toState }, "Could not advance execution intent");
  }
}

/** Link the intent to the trades row once it exists. */
export async function attachTrade(handle: IntentHandle | null, tradeId: number): Promise<void> {
  if (!handle) return;
  try {
    await db
      .update(executionIntentsTable)
      .set({ tradeId })
      .where(eq(executionIntentsTable.id, handle.id));
  } catch (err) {
    logger.warn({ err, intentId: handle.id, tradeId }, "Could not link execution intent to trade");
  }
}

async function appendEvent(
  intentId: number,
  fromState: ExecutionState | null,
  toState: ExecutionState,
  reason?: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await db.insert(executionEventsTable).values({
    intentId,
    fromState,
    toState,
    ...(reason && { reason }),
    ...(payload && { payload }),
  });
}
