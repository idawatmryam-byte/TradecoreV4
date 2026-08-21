import { randomUUID } from "crypto";
import {
  db,
  executionEventsTable,
  executionIntentsTable,
  liveExecutionStatesTable,
  liveGlobalEquityStateTable,
  liveKillSwitchesTable,
  liveSafetyEventsTable,
} from "@workspace/db";
import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";
import type { Section } from "../engineRegistry";
import type { ExecutionAuthority } from "./authority";
import {
  evaluateLiveEntrySafety,
  evaluateDrawdown,
  evaluateSafeResume,
  killSwitchApplies,
  LIVE_KILL_SWITCH_SCOPES,
  LIVE_OPERATING_MODES,
  type ApplicableKillSwitch,
  type LiveCommandIdentity,
  type LiveEntrySafetyVerdict,
  type LiveKillSwitchScope,
  type LiveOperatingMode,
} from "./liveSafety";

export interface LiveSafetyContext {
  userId: number;
  section: Section;
  executionAuthority: ExecutionAuthority;
  marketType: string;
  symbol: string;
  strategyId: string;
  autopilot: boolean;
  command: LiveCommandIdentity | null;
}

function isOperatingMode(value: string): value is LiveOperatingMode {
  return (LIVE_OPERATING_MODES as readonly string[]).includes(value);
}

function isKillSwitchScope(value: string): value is LiveKillSwitchScope {
  return (LIVE_KILL_SWITCH_SCOPES as readonly string[]).includes(value);
}

function parseMinor(value: string | null): bigint | null {
  if (value === null || !/^-?\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export async function ensureLiveExecutionState(
  userId: number,
  section: Section,
): Promise<typeof liveExecutionStatesTable.$inferSelect> {
  await db
    .insert(liveExecutionStatesTable)
    .values({ userId, section })
    .onConflictDoNothing({
      target: [
        liveExecutionStatesTable.userId,
        liveExecutionStatesTable.section,
      ],
    });
  const [state] = await db
    .select()
    .from(liveExecutionStatesTable)
    .where(
      and(
        eq(liveExecutionStatesTable.userId, userId),
        eq(liveExecutionStatesTable.section, section),
      ),
    )
    .limit(1);
  if (!state) throw new Error("Live safety state could not be established");
  return state;
}

export async function ingestAuthoritativeAccountEquity(input: {
  userId: number;
  section: Section;
  currentEquityMinor: bigint;
  sourceIdentity: string;
  observedAt: Date;
  freshUntil: Date;
}): Promise<{ applied: boolean; accountState: string; globalState: string }> {
  if (
    input.currentEquityMinor <= 0n ||
    input.currentEquityMinor >= 10n ** 30n
  ) {
    throw new Error(
      "Authoritative account equity must be positive and fit the persisted exact-numeric boundary",
    );
  }
  if (
    !/^[A-Z0-9:_-]{3,100}$/.test(input.sourceIdentity) ||
    !Number.isFinite(input.observedAt.getTime()) ||
    !Number.isFinite(input.freshUntil.getTime()) ||
    input.freshUntil <= input.observedAt
  ) {
    throw new Error("Authoritative equity provenance or freshness is invalid");
  }
  await ensureLiveExecutionState(input.userId, input.section);
  return db.transaction(async (tx) => {
    await tx
      .insert(liveGlobalEquityStateTable)
      .values({ id: "platform" })
      .onConflictDoNothing({ target: liveGlobalEquityStateTable.id });
    const [global] = await tx
      .select()
      .from(liveGlobalEquityStateTable)
      .where(eq(liveGlobalEquityStateTable.id, "platform"))
      .for("update")
      .limit(1);
    const [current] = await tx
      .select()
      .from(liveExecutionStatesTable)
      .where(
        and(
          eq(liveExecutionStatesTable.userId, input.userId),
          eq(liveExecutionStatesTable.section, input.section),
        ),
      )
      .for("update")
      .limit(1);
    if (!global || !current) {
      throw new Error("Equity safety projection could not be locked");
    }
    if (
      current.equityObservedAt &&
      input.observedAt <= current.equityObservedAt
    ) {
      return {
        applied: false,
        accountState: current.accountDrawdownState,
        globalState: global.drawdownState,
      };
    }
    const previousPeak = parseMinor(current.peakEquityMinor);
    const peak =
      previousPeak === null || input.currentEquityMinor > previousPeak
        ? input.currentEquityMinor
        : previousPeak;
    const account = evaluateDrawdown({
      peakEquityMinor: peak,
      currentEquityMinor: input.currentEquityMinor,
      limitBps: current.accountDrawdownLimitBps,
    });
    await tx
      .update(liveExecutionStatesTable)
      .set({
        currentEquityMinor: input.currentEquityMinor.toString(),
        peakEquityMinor: peak.toString(),
        equitySource: input.sourceIdentity,
        equityObservedAt: input.observedAt,
        equityFreshUntil: input.freshUntil,
        accountDrawdownState: account.state,
        ...(account.state === "BREACHED" &&
          current.operatingModeSource !== "OPERATOR" && {
            operatingMode: "EXIT_ONLY",
            operatingModeSource: "SYSTEM",
            entryBlockReason:
              "Authoritative account drawdown is at or beyond its configured limit",
            lastIncidentAt: new Date(),
          }),
      })
      .where(eq(liveExecutionStatesTable.id, current.id));
    if (
      current.accountDrawdownState !== account.state ||
      previousPeak !== peak ||
      current.equitySource !== input.sourceIdentity
    ) {
      await tx.insert(liveSafetyEventsTable).values({
        targetUserId: input.userId,
        section: input.section,
        eventType: "ACCOUNT_EQUITY_AUTHORITY_UPDATED",
        actorType: "system",
        reasonCode: `ACCOUNT_DRAWDOWN_${account.state}`,
        reason:
          "Authoritative broker equity updated the account drawdown projection",
        payload: {
          sourceIdentity: input.sourceIdentity,
          currentEquityMinor: input.currentEquityMinor.toString(),
          peakEquityMinor: peak.toString(),
          observedAt: input.observedAt.toISOString(),
          freshUntil: input.freshUntil.toISOString(),
        },
      });
    }

    const accountRows = await tx.select().from(liveExecutionStatesTable);
    // A read-only health request can create an unclaimed projection. Such a
    // row is not an authoritative account source and must not poison the
    // platform aggregate. Every claimed Live owner, however, must contribute
    // a fresh provider snapshot or the global state remains UNKNOWN.
    const activeRows = accountRows.filter(
      (row) => row.ownerClaimedAt !== null && row.ownerInstanceId !== null,
    );
    const now = input.observedAt.getTime();
    const complete =
      activeRows.length > 0 &&
      activeRows.every(
        (row) =>
          row.equitySource !== null &&
          row.equityFreshUntil !== null &&
          row.equityFreshUntil.getTime() > now &&
          parseMinor(row.currentEquityMinor) !== null,
      );
    const currentGlobal = complete
      ? activeRows.reduce(
          (sum, row) => sum + parseMinor(row.currentEquityMinor)!,
          0n,
        )
      : null;
    const previousGlobalPeak = parseMinor(global.peakEquityMinor);
    const globalPeak =
      currentGlobal === null
        ? previousGlobalPeak
        : previousGlobalPeak === null || currentGlobal > previousGlobalPeak
          ? currentGlobal
          : previousGlobalPeak;
    const globalVerdict = evaluateDrawdown({
      peakEquityMinor: globalPeak,
      currentEquityMinor: currentGlobal,
      limitBps: global.drawdownLimitBps,
    });
    const globalFreshUntil = complete
      ? new Date(
          Math.min(...activeRows.map((row) => row.equityFreshUntil!.getTime())),
        )
      : null;
    await tx
      .update(liveGlobalEquityStateTable)
      .set({
        currentEquityMinor: currentGlobal?.toString() ?? null,
        peakEquityMinor: globalPeak?.toString() ?? null,
        sourceCount: complete ? activeRows.length : 0,
        observedAt: complete ? input.observedAt : null,
        freshUntil: globalFreshUntil,
        drawdownState: globalVerdict.state,
      })
      .where(eq(liveGlobalEquityStateTable.id, "platform"));
    await tx
      .update(liveExecutionStatesTable)
      .set({ globalDrawdownState: globalVerdict.state })
      .where(sql`true`);
    if (global.drawdownState !== globalVerdict.state) {
      await tx.insert(liveSafetyEventsTable).values({
        targetUserId: 0,
        section: "*",
        eventType: "GLOBAL_DRAWDOWN_STATE_CHANGED",
        actorType: "system",
        reasonCode: `GLOBAL_DRAWDOWN_${globalVerdict.state}`,
        reason:
          "The aggregate of all fresh authoritative account-equity snapshots changed global drawdown state",
        payload: {
          sourceCount: complete ? activeRows.length : 0,
          currentEquityMinor: currentGlobal?.toString() ?? null,
          peakEquityMinor: globalPeak?.toString() ?? null,
          freshUntil: globalFreshUntil?.toISOString() ?? null,
        },
      });
    }
    return {
      applied: true,
      accountState: account.state,
      globalState: globalVerdict.state,
    };
  });
}

export async function markAuthoritativeAccountEquityUnknown(input: {
  userId: number;
  section: Section;
  reasonCode: string;
  reason: string;
}): Promise<void> {
  await ensureLiveExecutionState(input.userId, input.section);
  await db.transaction(async (tx) => {
    await tx
      .update(liveExecutionStatesTable)
      .set({
        accountDrawdownState: "UNKNOWN",
        equityFreshUntil: new Date(0),
        globalDrawdownState: "UNKNOWN",
        lastIncidentAt: new Date(),
      })
      .where(
        and(
          eq(liveExecutionStatesTable.userId, input.userId),
          eq(liveExecutionStatesTable.section, input.section),
        ),
      );
    await tx
      .update(liveExecutionStatesTable)
      .set({
        operatingMode: "EXIT_ONLY",
        entryBlockReason: input.reason,
      })
      .where(
        and(
          eq(liveExecutionStatesTable.userId, input.userId),
          eq(liveExecutionStatesTable.section, input.section),
          eq(liveExecutionStatesTable.operatingModeSource, "SYSTEM"),
        ),
      );
    await tx
      .insert(liveGlobalEquityStateTable)
      .values({ id: "platform", drawdownState: "UNKNOWN" })
      .onConflictDoUpdate({
        target: liveGlobalEquityStateTable.id,
        set: {
          drawdownState: "UNKNOWN",
          currentEquityMinor: null,
          sourceCount: 0,
          observedAt: null,
          freshUntil: null,
        },
      });
    await tx
      .update(liveExecutionStatesTable)
      .set({ globalDrawdownState: "UNKNOWN" })
      .where(sql`true`);
    await tx.insert(liveSafetyEventsTable).values({
      targetUserId: input.userId,
      section: input.section,
      eventType: "ACCOUNT_EQUITY_AUTHORITY_UNKNOWN",
      actorType: "system",
      reasonCode: input.reasonCode,
      reason: input.reason,
    });
  });
}

/**
 * Atomically advances the execution generation. Commands issued by a prior
 * process generation become stale at the final Live boundary.
 */
export async function claimLiveExecutionOwnership(
  userId: number,
  section: Section,
): Promise<{ generation: number; instanceId: string }> {
  const instanceId = randomUUID();
  await ensureLiveExecutionState(userId, section);
  const [claimed] = await db
    .update(liveExecutionStatesTable)
    .set({
      ownershipGeneration: sql`${liveExecutionStatesTable.ownershipGeneration} + 1`,
      ownerInstanceId: instanceId,
      ownerClaimedAt: new Date(),
      operatingMode: sql`CASE
        WHEN ${liveExecutionStatesTable.operatingModeSource} = 'OPERATOR'
          THEN ${liveExecutionStatesTable.operatingMode}
        ELSE 'NO_NEW_ENTRY'
      END`,
      operatingModeSource: sql`CASE
        WHEN ${liveExecutionStatesTable.operatingModeSource} = 'OPERATOR'
          THEN 'OPERATOR'
        ELSE 'SYSTEM'
      END`,
      reconciliationState: "UNKNOWN",
      protectionState: "UNKNOWN",
      entryBlockReason: sql`CASE
        WHEN ${liveExecutionStatesTable.operatingModeSource} = 'OPERATOR'
          THEN ${liveExecutionStatesTable.entryBlockReason}
        ELSE 'A new execution owner must reconcile before entries resume'
      END`,
    })
    .where(
      and(
        eq(liveExecutionStatesTable.userId, userId),
        eq(liveExecutionStatesTable.section, section),
      ),
    )
    .returning({ generation: liveExecutionStatesTable.ownershipGeneration });
  if (!claimed || claimed.generation < 1) {
    throw new Error("Live execution ownership generation could not be claimed");
  }
  await appendLiveSafetyEvent({
    targetUserId: userId,
    section,
    eventType: "OWNERSHIP_CLAIMED",
    actorType: "system",
    reasonCode: "PROCESS_GENERATION_ADVANCED",
    reason:
      "Live execution owner generation advanced; prior commands are stale",
    payload: { generation: claimed.generation, instanceId },
  });
  return { generation: claimed.generation, instanceId };
}

export async function updateLiveReconciliationProjection(input: {
  userId: number;
  section: Section;
  healthy: boolean;
  reason: string;
}): Promise<void> {
  const current = await ensureLiveExecutionState(input.userId, input.section);
  const [globalRows, activeSwitches] = await Promise.all([
    db
      .select()
      .from(liveGlobalEquityStateTable)
      .where(eq(liveGlobalEquityStateTable.id, "platform"))
      .limit(1),
    db
      .select({ id: liveKillSwitchesTable.id })
      .from(liveKillSwitchesTable)
      .where(
        and(
          eq(liveKillSwitchesTable.active, true),
          or(
            eq(liveKillSwitchesTable.ownerUserId, 0),
            eq(liveKillSwitchesTable.ownerUserId, input.userId),
          ),
          or(
            eq(liveKillSwitchesTable.section, "*"),
            eq(liveKillSwitchesTable.section, input.section),
          ),
        ),
      )
      .limit(1),
  ]);
  const now = Date.now();
  const global = globalRows[0] ?? null;
  const accountFresh =
    current.equityFreshUntil !== null &&
    current.equityFreshUntil.getTime() > now;
  const globalFresh =
    global?.freshUntil !== null &&
    global?.freshUntil !== undefined &&
    global.freshUntil.getTime() > now;
  const operatorMode =
    current.operatingModeSource === "OPERATOR" &&
    current.operatingMode !== "NORMAL";
  const resume = evaluateSafeResume({
    reconciliationHealthy: input.healthy,
    protectionHealthy: input.healthy,
    accountDrawdownState:
      current.accountDrawdownState === "HEALTHY" ||
      current.accountDrawdownState === "BREACHED"
        ? current.accountDrawdownState
        : "UNKNOWN",
    globalDrawdownState:
      global?.drawdownState === "HEALTHY" ||
      global?.drawdownState === "BREACHED"
        ? global.drawdownState
        : "UNKNOWN",
    accountEquityFresh: accountFresh,
    globalEquityFresh: globalFresh,
    ownershipGeneration: current.ownershipGeneration,
    ownerClaimed: current.ownerClaimedAt !== null,
    activeKillSwitches: activeSwitches.length,
    operatorModeActive: operatorMode,
    providerHealthy: input.healthy,
  });
  const safeResume = resume.allowed;
  const blockedReason = resume.allowed ? input.reason : resume.reason;
  await db
    .update(liveExecutionStatesTable)
    .set({
      ...(!operatorMode && {
        operatingMode: safeResume ? "NORMAL" : "EXIT_ONLY",
        operatingModeSource: "SYSTEM",
      }),
      reconciliationState: input.healthy ? "HEALTHY" : "INCOMPLETE",
      protectionState: input.healthy ? "HEALTHY" : "UNKNOWN",
      entryBlockReason: operatorMode
        ? current.entryBlockReason
        : safeResume
          ? null
          : blockedReason,
      ...(input.healthy && { lastReconciledAt: new Date() }),
      ...(!input.healthy && { lastIncidentAt: new Date() }),
    })
    .where(
      and(
        eq(liveExecutionStatesTable.userId, input.userId),
        eq(liveExecutionStatesTable.section, input.section),
      ),
    );
  await appendLiveSafetyEvent({
    targetUserId: input.userId,
    section: input.section,
    eventType: input.healthy
      ? "RECONCILIATION_HEALTHY"
      : "RECONCILIATION_BLOCKED",
    actorType: "system",
    reasonCode: input.healthy
      ? "RECONCILIATION_COMPLETED"
      : "RECONCILIATION_INCOMPLETE",
    reason: input.reason,
  });
}

export async function setOperatorLiveMode(input: {
  userId: number;
  section: Section;
  mode: "NO_NEW_ENTRY" | "EXIT_ONLY";
  reason: string;
}): Promise<void> {
  await ensureLiveExecutionState(input.userId, input.section);
  await db.transaction(async (tx) => {
    await tx
      .update(liveExecutionStatesTable)
      .set({
        operatingMode: input.mode,
        operatingModeSource: "OPERATOR",
        entryBlockReason: input.reason,
        lastIncidentAt: new Date(),
      })
      .where(
        and(
          eq(liveExecutionStatesTable.userId, input.userId),
          eq(liveExecutionStatesTable.section, input.section),
        ),
      );
    await tx.insert(liveSafetyEventsTable).values({
      targetUserId: input.userId,
      section: input.section,
      eventType: "OPERATING_MODE_CHANGED",
      actorType: "user",
      actorUserId: input.userId,
      reasonCode:
        input.mode === "EXIT_ONLY"
          ? "OPERATOR_EXIT_ONLY"
          : "OPERATOR_STOP_NEW_TRADES",
      reason: input.reason,
      payload: { mode: input.mode, preservesExitCapability: true },
    });
  });
}

export async function setSystemLiveMode(input: {
  userId: number;
  section: Section;
  mode: "EXIT_ONLY" | "MAINTENANCE" | "PROTECTION_DEGRADED";
  reasonCode: string;
  reason: string;
}): Promise<void> {
  const current = await ensureLiveExecutionState(input.userId, input.section);
  if (
    current.operatingModeSource === "OPERATOR" &&
    current.operatingMode !== "NORMAL"
  ) {
    if (input.mode === "PROTECTION_DEGRADED") {
      await db
        .update(liveExecutionStatesTable)
        .set({ protectionState: "DEGRADED", lastIncidentAt: new Date() })
        .where(eq(liveExecutionStatesTable.id, current.id));
    }
    await appendLiveSafetyEvent({
      targetUserId: input.userId,
      section: input.section,
      eventType: "SYSTEM_MODE_REQUEST_BLOCKED_BY_OPERATOR_MODE",
      actorType: "system",
      reasonCode: input.reasonCode,
      reason: input.reason,
      payload: {
        requestedMode: input.mode,
        retainedMode: current.operatingMode,
      },
    });
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(liveExecutionStatesTable)
      .set({
        operatingMode: input.mode,
        operatingModeSource: "SYSTEM",
        ...(input.mode === "PROTECTION_DEGRADED" && {
          protectionState: "DEGRADED",
        }),
        entryBlockReason: input.reason,
        lastIncidentAt: new Date(),
      })
      .where(eq(liveExecutionStatesTable.id, current.id));
    await tx.insert(liveSafetyEventsTable).values({
      targetUserId: input.userId,
      section: input.section,
      eventType: "OPERATING_MODE_CHANGED",
      actorType: "system",
      reasonCode: input.reasonCode,
      reason: input.reason,
      payload: { mode: input.mode, preservesExitCapability: true },
    });
  });
}

export class ReconciliationActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Evidence-backed operator actions never erase uncertainty. RETRY reopens the
 * automated broker lookup/recovery path; ACKNOWLEDGE_BLOCKED records human
 * awareness while the intent and Live entry boundary remain escalated.
 */
export async function applyOperatorReconciliationAction(input: {
  userId: number;
  section: Section;
  intentId: number;
  ownershipGeneration: number;
  action: "RETRY_RECOVERY" | "ACKNOWLEDGE_BLOCKED";
  idempotencyKey: string;
  reason: string;
}): Promise<{ applied: boolean; state: string }> {
  return db.transaction(async (tx) => {
    const [safetyState] = await tx
      .select()
      .from(liveExecutionStatesTable)
      .where(
        and(
          eq(liveExecutionStatesTable.userId, input.userId),
          eq(liveExecutionStatesTable.section, input.section),
        ),
      )
      .for("update")
      .limit(1);
    if (!safetyState) {
      throw new ReconciliationActionError(
        "LIVE_STATE_NOT_FOUND",
        "Live execution state is unavailable",
      );
    }
    if (safetyState.ownershipGeneration !== input.ownershipGeneration) {
      throw new ReconciliationActionError(
        "STALE_EXECUTION_OWNER",
        "The execution owner changed; refresh evidence before acting",
      );
    }
    const [intent] = await tx
      .select()
      .from(executionIntentsTable)
      .where(
        and(
          eq(executionIntentsTable.id, input.intentId),
          eq(executionIntentsTable.userId, input.userId),
          eq(executionIntentsTable.section, input.section),
        ),
      )
      .for("update")
      .limit(1);
    if (!intent) {
      throw new ReconciliationActionError(
        "INTENT_NOT_FOUND",
        "The reconciliation intent is not available in this user scope",
      );
    }
    if (
      intent.state !== "ESCALATED" &&
      intent.state !== "RECONCILIATION_REQUIRED" &&
      intent.state !== "PARTIALLY_FILLED"
    ) {
      throw new ReconciliationActionError(
        "INTENT_ACTION_NOT_ALLOWED",
        "Only unresolved or escalated intents accept an operator action",
      );
    }
    const [duplicate] = await tx
      .select({ id: executionEventsTable.id })
      .from(executionEventsTable)
      .where(
        and(
          eq(executionEventsTable.intentId, intent.id),
          sql`${executionEventsTable.payload}->>'operatorActionKey' = ${input.idempotencyKey}`,
        ),
      )
      .limit(1);
    if (duplicate) return { applied: false, state: intent.state };

    const retry = input.action === "RETRY_RECOVERY";
    if (
      retry &&
      (!intent.filledQuantity ||
        !intent.averageFillPrice ||
        Number(intent.filledQuantity) <= 0 ||
        Number(intent.averageFillPrice) <= 0)
    ) {
      throw new ReconciliationActionError(
        "AUTHORITATIVE_FILL_EVIDENCE_REQUIRED",
        "Recovery cannot be retried without positive broker fill quantity and average price evidence",
      );
    }
    const toState = retry ? "RECONCILIATION_REQUIRED" : "ESCALATED";
    await tx.insert(executionEventsTable).values({
      intentId: intent.id,
      fromState: intent.state,
      toState,
      reason: input.reason,
      payload: {
        reasonCode: retry
          ? "OPERATOR_RECOVERY_RETRY_REQUESTED"
          : "OPERATOR_ACKNOWLEDGED_BLOCKED",
        operatorAction: input.action,
        operatorActionKey: input.idempotencyKey,
        ownershipGeneration: input.ownershipGeneration,
      },
    });
    await tx
      .update(executionIntentsTable)
      .set({
        state: toState,
        resolutionCode: retry
          ? "OPERATOR_RECOVERY_RETRY_REQUESTED"
          : "OPERATOR_ACKNOWLEDGED_BLOCKED",
        ...(retry && { recoveryState: "UNKNOWN" }),
      })
      .where(eq(executionIntentsTable.id, intent.id));
    await tx
      .update(liveExecutionStatesTable)
      .set({
        ...(safetyState.operatingModeSource !== "OPERATOR" && {
          operatingMode: retry ? "EXIT_ONLY" : "PROTECTION_DEGRADED",
          operatingModeSource: "SYSTEM",
        }),
        reconciliationState: retry ? "INCOMPLETE" : "ESCALATED",
        protectionState: "DEGRADED",
        entryBlockReason: retry
          ? "Operator requested evidence-backed recovery retry; reconciliation remains incomplete"
          : "Operator acknowledged irrecoverable uncertainty; Live entries remain blocked",
        lastIncidentAt: new Date(),
      })
      .where(eq(liveExecutionStatesTable.id, safetyState.id));
    await tx.insert(liveSafetyEventsTable).values({
      targetUserId: input.userId,
      section: input.section,
      eventType: retry
        ? "RECONCILIATION_RETRY_REQUESTED"
        : "RECONCILIATION_ACKNOWLEDGED_BLOCKED",
      actorType: "user",
      actorUserId: input.userId,
      reasonCode: retry
        ? "OPERATOR_RECOVERY_RETRY_REQUESTED"
        : "OPERATOR_ACKNOWLEDGED_BLOCKED",
      reason: input.reason,
      payload: {
        intentId: intent.id,
        operatorActionKey: input.idempotencyKey,
        ownershipGeneration: input.ownershipGeneration,
      },
    });
    return { applied: true, state: toState };
  });
}

export async function getLiveExecutionHealth(
  userId: number,
  section: Section,
): Promise<{
  state: typeof liveExecutionStatesTable.$inferSelect;
  globalState: typeof liveGlobalEquityStateTable.$inferSelect | null;
  switches: Array<typeof liveKillSwitchesTable.$inferSelect>;
  unresolvedIntents: Array<typeof executionIntentsTable.$inferSelect>;
  incidents: Array<typeof liveSafetyEventsTable.$inferSelect>;
}> {
  const state = await ensureLiveExecutionState(userId, section);
  const [globalRows, switches, unresolvedIntents, incidents] =
    await Promise.all([
      db
        .select()
        .from(liveGlobalEquityStateTable)
        .where(eq(liveGlobalEquityStateTable.id, "platform"))
        .limit(1),
      db
        .select()
        .from(liveKillSwitchesTable)
        .where(
          and(
            eq(liveKillSwitchesTable.active, true),
            or(
              and(
                eq(liveKillSwitchesTable.ownerUserId, 0),
                or(
                  eq(liveKillSwitchesTable.section, "*"),
                  eq(liveKillSwitchesTable.section, section),
                ),
              ),
              and(
                eq(liveKillSwitchesTable.ownerUserId, userId),
                or(
                  eq(liveKillSwitchesTable.section, "*"),
                  eq(liveKillSwitchesTable.section, section),
                ),
              ),
            ),
          ),
        ),
      db
        .select()
        .from(executionIntentsTable)
        .where(
          and(
            eq(executionIntentsTable.userId, userId),
            eq(executionIntentsTable.section, section),
            notInArray(executionIntentsTable.state, [
              "PROTECTED",
              "FLATTENED",
              "FAILED",
              "ABANDONED",
            ]),
          ),
        )
        .orderBy(desc(executionIntentsTable.createdAt))
        .limit(100),
      db
        .select()
        .from(liveSafetyEventsTable)
        .where(
          and(
            or(
              eq(liveSafetyEventsTable.targetUserId, userId),
              eq(liveSafetyEventsTable.targetUserId, 0),
            ),
            or(
              eq(liveSafetyEventsTable.section, section),
              eq(liveSafetyEventsTable.section, "*"),
            ),
          ),
        )
        .orderBy(desc(liveSafetyEventsTable.occurredAt))
        .limit(100),
    ]);
  return {
    state,
    globalState: globalRows[0] ?? null,
    switches,
    unresolvedIntents,
    incidents,
  };
}

export async function evaluatePersistedLiveSafety(
  context: LiveSafetyContext,
): Promise<LiveEntrySafetyVerdict> {
  const [state, globalRows, switchRows] = await Promise.all([
    ensureLiveExecutionState(context.userId, context.section),
    db
      .select()
      .from(liveGlobalEquityStateTable)
      .where(eq(liveGlobalEquityStateTable.id, "platform"))
      .limit(1),
    db
      .select()
      .from(liveKillSwitchesTable)
      .where(
        and(
          eq(liveKillSwitchesTable.active, true),
          or(
            and(
              eq(liveKillSwitchesTable.ownerUserId, 0),
              or(
                eq(liveKillSwitchesTable.section, "*"),
                eq(liveKillSwitchesTable.section, context.section),
              ),
            ),
            and(
              eq(liveKillSwitchesTable.ownerUserId, context.userId),
              or(
                eq(liveKillSwitchesTable.section, "*"),
                eq(liveKillSwitchesTable.section, context.section),
              ),
            ),
          ),
        ),
      ),
  ]);

  const switches: ApplicableKillSwitch[] = switchRows
    .filter(
      (row) =>
        isKillSwitchScope(row.scope) &&
        killSwitchApplies(
          { scope: row.scope, scopeKey: row.scopeKey },
          {
            userId: context.userId,
            section: context.section,
            executionAuthority: context.executionAuthority,
            marketType: context.marketType,
            symbol: context.symbol,
            strategyId: context.strategyId,
            brainVersion: context.command?.brainVersion ?? null,
            autopilot: context.autopilot,
          },
        ),
    )
    .map((row) => ({
      scope: row.scope as LiveKillSwitchScope,
      scopeKey: row.scopeKey,
      reason: row.reason,
    }));
  const operatingMode = isOperatingMode(state.operatingMode)
    ? state.operatingMode
    : "NO_NEW_ENTRY";
  const reconciliationState =
    state.reconciliationState === "HEALTHY" ||
    state.reconciliationState === "INCOMPLETE" ||
    state.reconciliationState === "ESCALATED"
      ? state.reconciliationState
      : "UNKNOWN";
  const protectionState =
    state.protectionState === "HEALTHY" || state.protectionState === "DEGRADED"
      ? state.protectionState
      : "UNKNOWN";
  const global = globalRows[0] ?? null;
  const globalFresh =
    global?.freshUntil !== null &&
    global?.freshUntil !== undefined &&
    global.freshUntil.getTime() > Date.now();
  const globalDrawdownState =
    globalFresh &&
    (global?.drawdownState === "HEALTHY" ||
      global?.drawdownState === "BREACHED")
      ? global.drawdownState
      : "UNKNOWN";
  const accountFresh =
    state.equityFreshUntil !== null &&
    state.equityFreshUntil.getTime() > Date.now();

  return evaluateLiveEntrySafety({
    operatingMode,
    reconciliationState,
    protectionState,
    globalDrawdownState,
    expectedOwnershipGeneration: state.ownershipGeneration,
    command: context.command,
    switches,
    accountDrawdown: {
      peakEquityMinor: accountFresh ? parseMinor(state.peakEquityMinor) : null,
      currentEquityMinor: accountFresh
        ? parseMinor(state.currentEquityMinor)
        : null,
      limitBps: state.accountDrawdownLimitBps,
    },
  });
}

export async function appendLiveSafetyEvent(
  event: typeof liveSafetyEventsTable.$inferInsert,
): Promise<void> {
  const insert = db.insert(liveSafetyEventsTable).values(event);
  if (event.eventKey) {
    await insert.onConflictDoNothing({
      target: liveSafetyEventsTable.eventKey,
    });
    return;
  }
  await insert;
}
