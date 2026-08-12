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
 * Legacy/manual intent writes remain best-effort so logging cannot strand an
 * already-started money path. Phase 10 autonomous entry is stricter: its
 * pre-order intent is mandatory and a persistence failure refuses execution.
 * Later event/projection advances remain recovery evidence and are retried by
 * normal reconciliation rather than weakening protection.
 */
import { randomUUID } from "crypto";
import { db, executionEventsTable, executionIntentsTable } from "@workspace/db";
import type { ExecutionState } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { makeAutopilotClientOrderId, makeAutopilotCorrelationId, makeClientOrderId } from "./ids";

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
  autopilot?: {
    claimId: number;
    mandateId: number;
    mandateFingerprint: string;
    brainVersion: string;
    decisionFingerprint: string;
    riskFingerprint: string;
    idempotencyKey: string;
  };
}

/**
 * Record the intent and return a handle. Call immediately before the broker
 * call — after every pre-flight refusal, so a refused entry leaves no row.
 *
 * Returns null on a legacy/manual write failure. Autonomous callers throw and
 * therefore cannot cross the executor boundary without a durable intent.
 */
export async function openIntent(args: OpenIntentArgs): Promise<IntentHandle | null> {
  const correlationId = args.autopilot ? makeAutopilotCorrelationId(args.autopilot.idempotencyKey) : randomUUID();
  const clientOrderId = args.autopilot
    ? makeAutopilotClientOrderId(args.userId, args.autopilot.idempotencyKey)
    : makeClientOrderId(args.userId);
  try {
    const [row] = await db
      .insert(executionIntentsTable)
      .values({
        userId: args.userId,
        section: args.section,
        correlationId,
        clientOrderId,
        planFingerprint: args.planFingerprint,
        ...(args.autopilot && {
          autopilotClaimId: args.autopilot.claimId,
          autopilotMandateId: args.autopilot.mandateId,
          autopilotMandateFingerprint: args.autopilot.mandateFingerprint,
          brainVersion: args.autopilot.brainVersion,
          brainDecisionFingerprint: args.autopilot.decisionFingerprint,
          riskDecisionFingerprint: args.autopilot.riskFingerprint,
          autopilotIdempotencyKey: args.autopilot.idempotencyKey,
        }),
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
    if (args.autopilot) {
      throw new Error("Autonomous execution refused because its durable intent could not be persisted", { cause: err });
    }
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
