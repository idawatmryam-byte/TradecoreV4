import {
  autopilotDecisionClaimsTable,
  autopilotEventsTable,
  db,
  executionIntentsTable,
  positionManagementEventsTable,
  tradesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { BotEngine, type Phase10ValidationScanResult } from "../botEngine";
import type { Section } from "../engineRegistry";
import {
  getAutopilotSnapshot,
  listPhase10ValidationEvents,
  recordPhase10ValidationEvent,
  setAutopilotState,
} from "./store";
import {
  assertPhase10ValidationAuthorization,
  phase10ManagementProjection,
  type Phase10ValidationAuthorization,
} from "./validation";

export interface Phase10ValidationLifecycleInput {
  authorization: Phase10ValidationAuthorization;
  userId: number;
  section: Section;
  mandateId: number;
  symbol: string;
  strategyId: string;
}

function eventPayload(event: { payload: unknown }): Record<string, unknown> {
  return event.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

async function audit(
  input: Phase10ValidationLifecycleInput,
  event: {
    eventType: string;
    reasonCode: string;
    reason: string;
    decisionClaimId?: number;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await recordPhase10ValidationEvent({
    userId: input.userId,
    section: input.section,
    eventType: event.eventType,
    operatorUserId: input.authorization.operatorUserId,
    runId: input.authorization.runId,
    mandateId: input.mandateId,
    ...(event.decisionClaimId != null && {
      decisionClaimId: event.decisionClaimId,
    }),
    reasonCode: event.reasonCode,
    reason: event.reason,
    ...(event.payload && { payload: event.payload }),
  });
}

async function validationTradeId(
  input: Phase10ValidationLifecycleInput,
): Promise<number> {
  const events = await listPhase10ValidationEvents(
    input.userId,
    input.section,
    input.authorization.runId,
  );
  const entry = [...events]
    .reverse()
    .find((event) => event.eventType === "PHASE10_VALIDATION_ENTRY_SUCCEEDED");
  const tradeId = Number(entry ? eventPayload(entry).tradeId : Number.NaN);
  if (!Number.isInteger(tradeId) || tradeId <= 0) {
    throw new Error(
      "The validation entry audit does not contain a durable trade id",
    );
  }
  return tradeId;
}

async function validateEntryEvidence(
  input: Phase10ValidationLifecycleInput,
  result: Extract<Phase10ValidationScanResult, { stage: "entry" }>,
) {
  if (
    !result.entered ||
    !result.duplicateRefused ||
    !result.claimId ||
    !result.tradeId ||
    !result.executionIntentId ||
    !result.decisionFingerprint
  ) {
    throw new Error(
      `Deterministic entry did not complete the exact autonomous path: ${result.reason}`,
    );
  }
  const [claims, intents, trades, events] = await Promise.all([
    db
      .select()
      .from(autopilotDecisionClaimsTable)
      .where(
        and(
          eq(autopilotDecisionClaimsTable.userId, input.userId),
          eq(autopilotDecisionClaimsTable.section, input.section),
          eq(
            autopilotDecisionClaimsTable.decisionFingerprint,
            result.decisionFingerprint,
          ),
        ),
      ),
    db
      .select()
      .from(executionIntentsTable)
      .where(eq(executionIntentsTable.autopilotClaimId, result.claimId)),
    db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.autopilotClaimId, result.claimId)),
    db
      .select()
      .from(autopilotEventsTable)
      .where(
        and(
          eq(autopilotEventsTable.userId, input.userId),
          eq(autopilotEventsTable.section, input.section),
          eq(autopilotEventsTable.reasonCode, "DUPLICATE_AUTONOMOUS_DECISION"),
        ),
      ),
  ]);
  if (claims.length !== 1 || claims[0]?.status !== "EXECUTED") {
    throw new Error(
      "The deterministic decision does not have exactly one consumed EXECUTED claim",
    );
  }
  if (
    intents.length !== 1 ||
    intents[0]?.id !== result.executionIntentId ||
    intents[0]?.state !== "PROTECTED"
  ) {
    throw new Error(
      "The deterministic decision does not have exactly one durable protected execution intent",
    );
  }
  if (
    trades.length !== 1 ||
    trades[0]?.id !== result.tradeId ||
    trades[0]?.executionAuthority !== "simulated_demo"
  ) {
    throw new Error(
      "The deterministic decision does not have exactly one simulated_demo trade",
    );
  }
  if (
    !events.some((event) => event.fingerprint === result.decisionFingerprint)
  ) {
    throw new Error(
      "The duplicate deterministic decision refusal was not durably audited",
    );
  }
  return { claim: claims[0]!, intent: intents[0]!, trade: trades[0]! };
}

export async function runPhase10ValidationBeforeRestart(
  input: Phase10ValidationLifecycleInput,
) {
  assertPhase10ValidationAuthorization(
    input.authorization,
    input.authorization.runId,
    input.userId,
  );
  if (input.section !== "crypto")
    throw new Error(
      "The deterministic validation lifecycle is simulated Demo crypto only",
    );
  await audit(input, {
    eventType: "PHASE10_VALIDATION_STAGE_STARTED",
    reasonCode: "VALIDATION_BEFORE_RESTART_STARTED",
    reason:
      "Operator started the isolated deterministic simulated Demo validation before restart",
    payload: {
      stage: "before-restart",
      symbol: input.symbol,
      strategyId: input.strategyId,
    },
  });
  try {
    const engine = new BotEngine(input.userId, input.section);
    const entry = await engine.runPhase10ValidationScan({
      authorization: input.authorization,
      stage: "entry",
      mandateId: input.mandateId,
      symbol: input.symbol,
      strategyId: input.strategyId,
    });
    if (entry.stage !== "entry")
      throw new Error("Validation entry returned an unexpected stage");
    const evidence = await validateEntryEvidence(input, entry);
    await audit(input, {
      eventType: "PHASE10_VALIDATION_RECONCILIATION_HEALTHY",
      reasonCode: "SIMULATED_DEMO_RECONCILIATION_HEALTHY",
      reason:
        "The isolated validation scan found no ambiguous or mismatched open-trade authority",
      decisionClaimId: evidence.claim.id,
      payload: { stage: "entry", authority: "simulated_demo" },
    });
    await audit(input, {
      eventType: "PHASE10_VALIDATION_ENTRY_SUCCEEDED",
      reasonCode: "VALIDATION_AUTONOMOUS_ENTRY_SUCCEEDED",
      reason:
        "One deterministic decision traversed Brain V0, risk, mandate, claim, DemoExecutor, intent, and simulated trade persistence",
      decisionClaimId: evidence.claim.id,
      payload: {
        tradeId: evidence.trade.id,
        executionIntentId: evidence.intent.id,
        decisionFingerprint: evidence.claim.decisionFingerprint,
        duplicateRefused: true,
      },
    });

    const managementEngine = new BotEngine(input.userId, input.section);
    const management = await managementEngine.runPhase10ValidationScan({
      authorization: input.authorization,
      stage: "manage",
      mandateId: input.mandateId,
      symbol: input.symbol,
      strategyId: input.strategyId,
      tradeId: evidence.trade.id,
    });
    if (management.stage !== "manage" || management.status !== "open") {
      throw new Error(
        "The validation trade did not remain open after its controlled Phase 7 management tick",
      );
    }
    const managementEvents = await db
      .select()
      .from(positionManagementEventsTable)
      .where(
        and(
          eq(positionManagementEventsTable.userId, input.userId),
          eq(positionManagementEventsTable.section, input.section),
          eq(positionManagementEventsTable.tradeId, evidence.trade.id),
        ),
      );
    if (managementEvents.length === 0) {
      throw new Error(
        "Phase 7 did not persist a management event for the deterministic Demo position",
      );
    }
    const projection = management.managementProjection.projection;
    if (
      Number(projection.mfeUsdt ?? 0) === 0 &&
      Number(projection.maeUsdt ?? 0) === 0
    ) {
      throw new Error(
        "The managed Demo position did not persist its mutable management projection",
      );
    }
    await audit(input, {
      eventType: "PHASE10_VALIDATION_MANAGEMENT_PERSISTED",
      reasonCode: "VALIDATION_PHASE7_MANAGEMENT_PERSISTED",
      reason:
        "Phase 7 evaluated the simulated Demo position and its complete mutable projection was persisted",
      decisionClaimId: evidence.claim.id,
      payload: {
        tradeId: evidence.trade.id,
        managementEventCount: managementEvents.length,
        managementProjectionFingerprint:
          management.managementProjection.fingerprint,
        managementProjection: projection,
      },
    });
    return {
      runId: input.authorization.runId,
      mandateId: input.mandateId,
      claimId: evidence.claim.id,
      intentId: evidence.intent.id,
      tradeId: evidence.trade.id,
      decisionFingerprint: evidence.claim.decisionFingerprint,
      duplicateRefused: true,
      managementProjectionFingerprint:
        management.managementProjection.fingerprint,
      next: "restart/reload the API process, then run the after-restart validation stage with the same run id",
    };
  } catch (error) {
    await audit(input, {
      eventType: "PHASE10_VALIDATION_REFUSED",
      reasonCode: "VALIDATION_BEFORE_RESTART_REFUSED",
      reason: error instanceof Error ? error.message : String(error),
      payload: { stage: "before-restart" },
    });
    throw error;
  }
}

export async function runPhase10ValidationAfterRestart(
  input: Phase10ValidationLifecycleInput,
) {
  assertPhase10ValidationAuthorization(
    input.authorization,
    input.authorization.runId,
    input.userId,
  );
  await audit(input, {
    eventType: "PHASE10_VALIDATION_STAGE_STARTED",
    reasonCode: "VALIDATION_AFTER_RESTART_STARTED",
    reason:
      "Operator started the post-restart validation and simulated Demo close stage",
    payload: { stage: "after-restart" },
  });
  try {
    const tradeId = await validationTradeId(input);
    const [trade, events] = await Promise.all([
      db
        .select()
        .from(tradesTable)
        .where(
          and(
            eq(tradesTable.id, tradeId),
            eq(tradesTable.userId, input.userId),
            eq(tradesTable.section, input.section),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]),
      listPhase10ValidationEvents(
        input.userId,
        input.section,
        input.authorization.runId,
      ),
    ]);
    if (!trade || trade.status !== "open" || !trade.autopilotClaimId) {
      throw new Error(
        "The validation trade/claim did not survive restart as one open simulated Demo position",
      );
    }
    const claims = await db
      .select()
      .from(autopilotDecisionClaimsTable)
      .where(eq(autopilotDecisionClaimsTable.id, trade.autopilotClaimId));
    const duplicateTrades = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.autopilotClaimId, trade.autopilotClaimId));
    if (
      claims.length !== 1 ||
      claims[0]?.status !== "EXECUTED" ||
      duplicateTrades.length !== 1
    ) {
      throw new Error(
        "Restart proof failed: claim is not consumed or a duplicate simulated trade exists",
      );
    }
    const persistedManagement = [...events]
      .reverse()
      .find(
        (event) =>
          event.eventType === "PHASE10_VALIDATION_MANAGEMENT_PERSISTED",
      );
    const expectedProjectionFingerprint = String(
      persistedManagement
        ? (eventPayload(persistedManagement).managementProjectionFingerprint ??
            "")
        : "",
    );
    const reloadedProjection = phase10ManagementProjection(trade);
    if (
      !expectedProjectionFingerprint ||
      reloadedProjection.fingerprint !== expectedProjectionFingerprint
    ) {
      throw new Error(
        "Restart proof failed: the complete Phase 7 management projection did not reload identically",
      );
    }

    const reloadEngine = new BotEngine(input.userId, input.section);
    const reloadManagement = await reloadEngine.runPhase10ValidationScan({
      authorization: input.authorization,
      stage: "manage",
      mandateId: input.mandateId,
      symbol: input.symbol,
      strategyId: input.strategyId,
      tradeId,
    });
    if (
      reloadManagement.stage !== "manage" ||
      reloadManagement.status !== "open"
    ) {
      throw new Error(
        "The reloaded engine could not reconcile and manage the persisted simulated Demo position",
      );
    }
    await audit(input, {
      eventType: "PHASE10_VALIDATION_RELOAD_VERIFIED",
      reasonCode: "VALIDATION_RESTART_RECOVERY_VERIFIED",
      reason:
        "A fresh engine instance reloaded the consumed claim and Phase 7 projection without creating a duplicate trade",
      decisionClaimId: trade.autopilotClaimId,
      payload: {
        tradeId,
        claimStatus: claims[0]!.status,
        duplicateTradeCount: duplicateTrades.length,
        managementProjectionFingerprint: expectedProjectionFingerprint,
      },
    });

    const closeEngine = new BotEngine(input.userId, input.section);
    const closed = await closeEngine.runPhase10ValidationScan({
      authorization: input.authorization,
      stage: "close",
      mandateId: input.mandateId,
      symbol: input.symbol,
      strategyId: input.strategyId,
      tradeId,
    });
    if (closed.stage !== "close" || closed.status === "open") {
      throw new Error(
        "The validation trade did not close through the existing simulated Demo fill/accounting path",
      );
    }
    await audit(input, {
      eventType: "PHASE10_VALIDATION_CLOSE_SUCCEEDED",
      reasonCode: "VALIDATION_SIMULATED_DEMO_CLOSE_SUCCEEDED",
      reason:
        "The validation position reconciled and closed through the approved simulated Demo mechanism",
      decisionClaimId: trade.autopilotClaimId,
      payload: { tradeId, status: closed.status },
    });
    await setAutopilotState({
      userId: input.userId,
      section: input.section,
      state: "AUTOPILOT_PAUSED",
      reasonCode: "PHASE10_VALIDATION_COMPLETED",
      reason:
        "Operator completed the controlled Phase 10 simulated Demo validation lifecycle",
      actor: {
        actorType: "operator",
        actorUserId: input.authorization.operatorUserId,
      },
      mandateId: input.mandateId,
      configSuspended: true,
    });
    await audit(input, {
      eventType: "PHASE10_VALIDATION_COMPLETED",
      reasonCode: "VALIDATION_INTERNAL_PATH_COMPLETED",
      reason:
        "The deterministic Phase 10 internal path completed; normal autonomous entries remain paused",
      decisionClaimId: trade.autopilotClaimId,
      payload: {
        tradeId,
        finalTradeStatus: closed.status,
        autopilotPaused: true,
      },
    });
    return {
      runId: input.authorization.runId,
      tradeId,
      claimStatus: claims[0]!.status,
      duplicateTradeCount: duplicateTrades.length,
      managementProjectionReloaded: true,
      finalTradeStatus: closed.status,
      autopilotPaused: true,
      next: "restore AUTOPILOT_GLOBAL_SUSPENDED=true, restart with updated environment, then run confirm-suspended",
    };
  } catch (error) {
    await audit(input, {
      eventType: "PHASE10_VALIDATION_REFUSED",
      reasonCode: "VALIDATION_AFTER_RESTART_REFUSED",
      reason: error instanceof Error ? error.message : String(error),
      payload: { stage: "after-restart" },
    });
    throw error;
  }
}

export async function confirmPhase10ValidationGlobalSuspension(
  input: Phase10ValidationLifecycleInput,
) {
  assertPhase10ValidationAuthorization(
    input.authorization,
    input.authorization.runId,
    input.userId,
  );
  if (input.authorization.requiresGlobalSuspension !== "active") {
    throw new Error(
      "The final confirmation capability was not issued under restored global suspension",
    );
  }
  const snapshot = await getAutopilotSnapshot(input.userId, input.section);
  if (
    snapshot.control.state === "AUTOPILOT_ENABLED" ||
    !snapshot.control.configSuspended
  ) {
    throw new Error(
      "Validation completion requires the configuration to remain paused or blocked",
    );
  }
  await audit(input, {
    eventType: "PHASE10_VALIDATION_GLOBAL_SUSPENSION_RESTORED",
    reasonCode: "VALIDATION_GLOBAL_SUSPENSION_RESTORED",
    reason:
      "Operator confirmed AUTOPILOT_GLOBAL_SUSPENDED=true after the controlled validation lifecycle",
    payload: {
      globalSuspended: true,
      controlState: snapshot.control.state,
      configSuspended: snapshot.control.configSuspended,
    },
  });
  return {
    runId: input.authorization.runId,
    globalSuspended: true,
    controlState: snapshot.control.state,
    configSuspended: snapshot.control.configSuspended,
    externalProviderMutation: false,
  };
}
