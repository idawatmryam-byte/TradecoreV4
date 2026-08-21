import {
  db,
  executionEventsTable,
  executionIntentsTable,
  liveSafetyEventsTable,
  type ExecutionIntent,
  type ExecutionState,
} from "@workspace/db";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Section } from "../engineRegistry";
import {
  classifyBrokerOrder,
  planExposureRecovery,
  type BrokerOrderEvidence,
  type ExposureRecoveryPlan,
} from "./reconciliationPolicy";
import { makeRecoveryClientOrderId } from "./ids";

const TERMINAL_STATES: ExecutionState[] = [
  "PROTECTED",
  "FLATTENED",
  "FAILED",
  "ABANDONED",
  "ESCALATED",
];

export interface IntentReconciliationIssue {
  intentId: number;
  clientOrderId: string;
  state: ExecutionState;
  reasonCode: string;
  reason: string;
}

export type BrokerOrderResolver = (
  intent: ExecutionIntent,
) => Promise<BrokerOrderEvidence>;

export type ExposureRecoveryResult =
  | {
      outcome: "FLATTENED";
      brokerOrderId: string | null;
      filledQuantity: number;
      evidenceSource: string;
    }
  | {
      outcome: "RETRY" | "ESCALATE";
      reasonCode: string;
      reason: string;
    };

export type ExposureRecoveryExecutor = (input: {
  intent: Pick<
    ExecutionIntent,
    "id" | "symbol" | "side" | "marketType" | "clientOrderId"
  > &
    Partial<ExecutionIntent>;
  evidence: BrokerOrderEvidence;
  plan: Extract<
    ExposureRecoveryPlan,
    { action: "CANCEL_REMAINDER_THEN_REDUCE" | "REDUCE" }
  >;
  recoveryClientOrderId: string;
}) => Promise<ExposureRecoveryResult>;

function finiteString(value: number | null): string | null {
  return value !== null && Number.isFinite(value) ? value.toFixed(8) : null;
}

async function persistResolution(input: {
  intent: ExecutionIntent;
  toState: ExecutionState;
  reasonCode: string;
  reason: string;
  evidence?: BrokerOrderEvidence;
}): Promise<void> {
  const { intent, toState, reasonCode, reason, evidence } = input;
  await db.transaction(async (tx) => {
    if (intent.state !== toState || intent.resolutionCode !== reasonCode) {
      await tx.insert(executionEventsTable).values({
        intentId: intent.id,
        fromState: intent.state,
        toState,
        reason,
        payload: evidence
          ? {
              reasonCode,
              brokerOrderId: evidence.brokerOrderId,
              brokerTradeId: evidence.brokerTradeId,
              requestedQuantity: evidence.requestedQuantity,
              filledQuantity: evidence.filledQuantity,
              averageFillPrice: evidence.averageFillPrice,
              brokerStatus: evidence.status,
            }
          : { reasonCode },
      });
    }
    await tx
      .update(executionIntentsTable)
      .set({
        state: toState,
        resolutionCode: reasonCode,
        lastReconciledAt: new Date(),
        ...(evidence?.brokerOrderId && {
          brokerOrderId: evidence.brokerOrderId,
        }),
        ...(evidence?.brokerTradeId && {
          brokerTradeId: evidence.brokerTradeId,
        }),
        ...(finiteString(evidence?.filledQuantity ?? null) !== null && {
          filledQuantity: finiteString(evidence?.filledQuantity ?? null),
        }),
        ...(finiteString(evidence?.averageFillPrice ?? null) !== null && {
          averageFillPrice: finiteString(evidence?.averageFillPrice ?? null),
        }),
      })
      .where(eq(executionIntentsTable.id, intent.id));
  });
}

/**
 * Reconcile every non-terminal intent. Only authoritative unfilled rejection
 * or cancellation becomes FAILED; every ambiguity remains blocking.
 */
export async function reconcileNonTerminalIntents(input: {
  userId: number;
  section: Section;
  resolveOrder: BrokerOrderResolver;
  recoverExposure?: ExposureRecoveryExecutor;
}): Promise<{ inspected: number; issues: IntentReconciliationIssue[] }> {
  const intents = await db
    .select()
    .from(executionIntentsTable)
    .where(
      and(
        eq(executionIntentsTable.userId, input.userId),
        eq(executionIntentsTable.section, input.section),
        notInArray(executionIntentsTable.state, TERMINAL_STATES),
      ),
    );
  const issues: IntentReconciliationIssue[] = [];

  for (const intent of intents) {
    let evidence: BrokerOrderEvidence;
    try {
      evidence = await input.resolveOrder(intent);
    } catch {
      // Provider messages may contain account identifiers or request details.
      // Durable audit records keep only the stable classification; full error
      // context belongs in the already-sanitized local provider log path.
      const reason =
        "Broker lookup failed; authoritative order state remains unknown";
      await persistResolution({
        intent,
        toState: "RECONCILIATION_REQUIRED",
        reasonCode: "BROKER_LOOKUP_FAILED",
        reason,
      });
      issues.push({
        intentId: intent.id,
        clientOrderId: intent.clientOrderId,
        state: "RECONCILIATION_REQUIRED",
        reasonCode: "BROKER_LOOKUP_FAILED",
        reason,
      });
      continue;
    }

    const classified = classifyBrokerOrder(evidence);
    if (classified.state === "FAILED") {
      await persistResolution({
        intent,
        toState: "FAILED",
        reasonCode: classified.reasonCode,
        reason: "Broker authoritatively reports no filled quantity",
        evidence,
      });
      continue;
    }

    if (classified.state === "FILLED" && intent.tradeId !== null) {
      await persistResolution({
        intent,
        toState: "RECORDED",
        reasonCode: classified.reasonCode,
        reason:
          "Broker fill and linked database trade are confirmed; protection still requires verification",
        evidence,
      });
      continue;
    }

    const recoveryPlan = planExposureRecovery({
      evidence,
      marketType: intent.marketType,
      localTradeId: intent.tradeId,
    });
    if (recoveryPlan.action === "ESCALATE") {
      const reason =
        "Authoritative exposure cannot be reduced automatically because required broker evidence is incomplete";
      await persistResolution({
        intent,
        toState: "ESCALATED",
        reasonCode: recoveryPlan.reasonCode,
        reason,
        evidence,
      });
      issues.push({
        intentId: intent.id,
        clientOrderId: intent.clientOrderId,
        state: "ESCALATED",
        reasonCode: recoveryPlan.reasonCode,
        reason,
      });
      continue;
    }
    if (
      recoveryPlan.action === "REDUCE" ||
      recoveryPlan.action === "CANCEL_REMAINDER_THEN_REDUCE"
    ) {
      const recoveryClientOrderId =
        intent.recoveryClientOrderId ??
        makeRecoveryClientOrderId(intent.userId, intent.clientOrderId);
      const recoveryState: ExecutionState =
        recoveryPlan.action === "CANCEL_REMAINDER_THEN_REDUCE"
          ? "PARTIALLY_FILLED"
          : "RECONCILIATION_REQUIRED";
      await persistResolution({
        intent,
        toState: recoveryState,
        reasonCode: recoveryPlan.reasonCode,
        reason:
          "Broker-proven exposure has no local trade; a stable compensating reduction is required",
        evidence,
      });
      await db.transaction(async (tx) => {
        if (
          intent.recoveryClientOrderId !== recoveryClientOrderId ||
          intent.recoveryState !== "SUBMITTED"
        ) {
          await tx.insert(executionEventsTable).values({
            intentId: intent.id,
            fromState: recoveryState,
            toState: recoveryState,
            reason:
              "Stable compensating reduction command prepared before provider execution",
            payload: {
              reasonCode: "RECOVERY_COMMAND_PREPARED",
              recoveryClientOrderId,
              action: recoveryPlan.action,
              quantity: recoveryPlan.quantity,
            },
          });
        }
        await tx
          .update(executionIntentsTable)
          .set({
            recoveryClientOrderId,
            recoveryState: "SUBMITTED",
            recoveryAttemptedAt: new Date(),
          })
          .where(eq(executionIntentsTable.id, intent.id));
      });
      const recoveryIntent: ExecutionIntent = {
        ...intent,
        state: recoveryState,
        resolutionCode: recoveryPlan.reasonCode,
        recoveryClientOrderId,
        recoveryState: "SUBMITTED",
      };
      if (!input.recoverExposure) {
        const reason =
          "Authoritative exposure recovery executor is unavailable; entry authority remains blocked";
        issues.push({
          intentId: intent.id,
          clientOrderId: intent.clientOrderId,
          state: recoveryState,
          reasonCode: "RECOVERY_EXECUTOR_UNAVAILABLE",
          reason,
        });
        continue;
      }
      let recovery: ExposureRecoveryResult;
      try {
        recovery = await input.recoverExposure({
          intent: recoveryIntent,
          evidence,
          plan: recoveryPlan,
          recoveryClientOrderId,
        });
      } catch {
        recovery = {
          outcome: "RETRY",
          reasonCode: "RECOVERY_PROVIDER_FAILURE",
          reason:
            "Exposure reduction did not return authoritative confirmation; reconciliation must retry",
        };
      }
      if (recovery.outcome === "FLATTENED") {
        await persistResolution({
          intent: recoveryIntent,
          toState: "FLATTENED",
          reasonCode: "AUTHORITATIVE_EXPOSURE_REDUCED",
          reason:
            "Broker-proven exposure without a local trade was reduced by the stable recovery command",
          evidence,
        });
        await db.transaction(async (tx) => {
          await tx
            .update(executionIntentsTable)
            .set({
              recoveryState: "CONFIRMED",
              recoveryBrokerOrderId: recovery.brokerOrderId,
            })
            .where(eq(executionIntentsTable.id, intent.id));
          await tx.insert(executionEventsTable).values({
            intentId: intent.id,
            fromState: "FLATTENED",
            toState: "FLATTENED",
            reason:
              "Provider evidence confirmed the compensating exposure reduction",
            payload: {
              reasonCode: "RECOVERY_PROVIDER_CONFIRMED",
              recoveryClientOrderId,
              recoveryBrokerOrderId: recovery.brokerOrderId,
              filledQuantity: finiteString(recovery.filledQuantity),
              evidenceSource: recovery.evidenceSource,
            },
          });
          await tx
            .insert(liveSafetyEventsTable)
            .values({
              eventKey: `recovered:${intent.id}:${recoveryClientOrderId}`,
              targetUserId: intent.userId,
              section: intent.section,
              eventType: "RECOVERED_EXPOSURE_FLATTENED",
              actorType: "system",
              reasonCode: "AUTHORITATIVE_EXPOSURE_REDUCED",
              reason:
                "Broker-proven exposure without complete local trade state was reduced and provider-confirmed",
              payload: {
                intentId: intent.id,
                ownershipGeneration: intent.ownershipGeneration,
                recoveryClientOrderId,
                recoveryBrokerOrderId: recovery.brokerOrderId,
                filledQuantity: finiteString(recovery.filledQuantity),
                evidenceSource: recovery.evidenceSource,
              },
            })
            .onConflictDoNothing({ target: liveSafetyEventsTable.eventKey });
        });
        continue;
      }
      const escalated = recovery.outcome === "ESCALATE";
      await persistResolution({
        intent: recoveryIntent,
        toState: escalated ? "ESCALATED" : "RECONCILIATION_REQUIRED",
        reasonCode: recovery.reasonCode,
        reason: recovery.reason,
        evidence,
      });
      await db.transaction(async (tx) => {
        await tx
          .update(executionIntentsTable)
          .set({ recoveryState: escalated ? "FAILED" : "UNKNOWN" })
          .where(eq(executionIntentsTable.id, intent.id));
        await tx.insert(liveSafetyEventsTable).values({
          targetUserId: intent.userId,
          section: intent.section,
          eventType: escalated
            ? "EXPOSURE_RECOVERY_ESCALATED"
            : "EXPOSURE_RECOVERY_RETRY_REQUIRED",
          actorType: "system",
          reasonCode: recovery.reasonCode,
          reason: recovery.reason,
          payload: {
            intentId: intent.id,
            ownershipGeneration: intent.ownershipGeneration,
            recoveryClientOrderId,
          },
        });
      });
      issues.push({
        intentId: intent.id,
        clientOrderId: intent.clientOrderId,
        state: escalated ? "ESCALATED" : "RECONCILIATION_REQUIRED",
        reasonCode: recovery.reasonCode,
        reason: recovery.reason,
      });
      continue;
    }

    const toState: ExecutionState =
      classified.state === "PARTIALLY_FILLED"
        ? "PARTIALLY_FILLED"
        : "RECONCILIATION_REQUIRED";
    const reason =
      classified.state === "FILLED"
        ? "Broker fill is confirmed but no linked database trade exists"
        : classified.state === "PARTIALLY_FILLED"
          ? "Broker reports a partial fill; exposure and remaining order state require reconciliation"
          : "Broker order state remains pending or unknown";
    await persistResolution({
      intent,
      toState,
      reasonCode: classified.reasonCode,
      reason,
      evidence,
    });
    issues.push({
      intentId: intent.id,
      clientOrderId: intent.clientOrderId,
      state: toState,
      reasonCode: classified.reasonCode,
      reason,
    });
  }
  return { inspected: intents.length, issues };
}

/** Mark only trade-linked intents whose protection was verified in this pass. */
export async function markReconciledIntentsProtected(input: {
  userId: number;
  section: Section;
  tradeIds: readonly number[];
}): Promise<void> {
  if (input.tradeIds.length === 0) return;
  const intents = await db
    .select()
    .from(executionIntentsTable)
    .where(
      and(
        eq(executionIntentsTable.userId, input.userId),
        eq(executionIntentsTable.section, input.section),
        inArray(executionIntentsTable.tradeId, [...input.tradeIds]),
        inArray(executionIntentsTable.state, [
          "RECORDED",
          "RECONCILIATION_REQUIRED",
        ]),
      ),
    );
  for (const intent of intents) {
    await persistResolution({
      intent,
      toState: "PROTECTED",
      reasonCode: "PROTECTION_RECONCILED",
      reason:
        "Broker position, database trade, and exchange-side protection were verified",
    });
  }
}
