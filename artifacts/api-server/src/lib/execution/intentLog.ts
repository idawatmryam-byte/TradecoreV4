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
import {
  makeCommandClientOrderId,
  makeCommandCorrelationId,
  makeClientOrderId,
} from "./ids";
import type { LiveCommandIdentity } from "./liveSafety";

export { makeClientOrderId };

/** A live intent row we can advance as the order progresses. */
export interface IntentHandle {
  id: number;
  correlationId: string;
  clientOrderId: string;
  state: ExecutionState;
  /** True when an earlier attempt already owns this command identity. */
  existing: boolean;
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
  /** Broker-backed entries set this true; persistence failure is fatal. */
  mandatory?: boolean;
  command?: LiveCommandIdentity;
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
export async function openIntent(
  args: OpenIntentArgs,
): Promise<IntentHandle | null> {
  const stableIdempotencyKey =
    args.command?.idempotencyKey ?? args.autopilot?.idempotencyKey;
  const correlationId = stableIdempotencyKey
    ? makeCommandCorrelationId(stableIdempotencyKey)
    : randomUUID();
  const clientOrderId = stableIdempotencyKey
    ? makeCommandClientOrderId(args.userId, stableIdempotencyKey)
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
        ...(args.command && {
          decisionId: args.command.decisionId,
          riskDecisionId: args.command.riskDecisionId,
          ownershipGeneration: args.command.ownershipGeneration,
          commandIdempotencyKey: args.command.idempotencyKey,
          brainVersion: args.command.brainVersion,
        }),
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
        ...(args.plannedLeverage != null && {
          plannedLeverage: args.plannedLeverage,
        }),
        state: "INTENT_RECORDED",
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      if (!stableIdempotencyKey) {
        throw new Error(
          "Execution intent identity conflicted without a stable command key",
        );
      }
      const [existing] = await db
        .select()
        .from(executionIntentsTable)
        .where(
          eq(executionIntentsTable.commandIdempotencyKey, stableIdempotencyKey),
        )
        .limit(1);
      if (!existing) {
        throw new Error(
          "Execution intent conflict could not be resolved to an existing command",
        );
      }
      return {
        id: existing.id,
        correlationId: existing.correlationId,
        clientOrderId: existing.clientOrderId,
        state: existing.state as ExecutionState,
        existing: true,
      };
    }

    await appendEvent(
      row.id,
      null,
      "INTENT_RECORDED",
      "intent persisted before broker call",
    );
    return {
      id: row.id,
      correlationId,
      clientOrderId,
      state: "INTENT_RECORDED",
      existing: false,
    };
  } catch (err) {
    if (args.mandatory || args.autopilot) {
      throw new Error(
        "Execution refused because its durable intent could not be persisted",
        {
          cause: err,
        },
      );
    }
    // Never block the trade on the audit trail.
    logger.warn(
      { err, symbol: args.symbol },
      "Could not record execution intent — continuing without it",
    );
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
    logger.warn(
      { err, intentId: handle.id, toState },
      "Could not advance execution intent",
    );
  }
}

/** Link the intent to the trades row once it exists. */
export async function attachTrade(
  handle: IntentHandle | null,
  tradeId: number,
): Promise<void> {
  if (!handle) return;
  try {
    await db
      .update(executionIntentsTable)
      .set({ tradeId })
      .where(eq(executionIntentsTable.id, handle.id));
  } catch (err) {
    logger.warn(
      { err, intentId: handle.id, tradeId },
      "Could not link execution intent to trade",
    );
  }
}

/** Persist the stable compensating command before attempting a provider close. */
export async function prepareIntentRecovery(
  handle: IntentHandle | null,
  recoveryClientOrderId: string,
): Promise<boolean> {
  if (!handle) return false;
  const fromState = handle.state;
  handle.state = "RECONCILIATION_REQUIRED";
  try {
    await db.transaction(async (tx) => {
      await tx.insert(executionEventsTable).values({
        intentId: handle.id,
        fromState,
        toState: "RECONCILIATION_REQUIRED",
        reason:
          "Stable compensating recovery command persisted before provider execution",
        payload: {
          reasonCode: "RECOVERY_COMMAND_PREPARED",
          recoveryClientOrderId,
        },
      });
      await tx
        .update(executionIntentsTable)
        .set({
          state: "RECONCILIATION_REQUIRED",
          recoveryClientOrderId,
          recoveryState: "SUBMITTED",
          recoveryAttemptedAt: new Date(),
        })
        .where(eq(executionIntentsTable.id, handle.id));
    });
    return true;
  } catch (err) {
    logger.error(
      { err, intentId: handle.id, recoveryClientOrderId },
      "Could not persist compensating recovery command; deterministic identity remains derivable from the durable entry intent",
    );
    return false;
  }
}

export async function finalizeIntentRecovery(
  handle: IntentHandle | null,
  outcome: "FLATTENED" | "RETRY" | "ESCALATE",
  recoveryBrokerOrderId: string | null,
): Promise<void> {
  if (!handle) return;
  try {
    await db
      .update(executionIntentsTable)
      .set({
        recoveryState:
          outcome === "FLATTENED"
            ? "CONFIRMED"
            : outcome === "ESCALATE"
              ? "FAILED"
              : "UNKNOWN",
        ...(recoveryBrokerOrderId && { recoveryBrokerOrderId }),
      })
      .where(eq(executionIntentsTable.id, handle.id));
  } catch (err) {
    logger.error(
      { err, intentId: handle.id, outcome },
      "Could not persist compensating recovery outcome; reconciliation remains authoritative",
    );
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
