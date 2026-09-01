import { db } from "@workspace/db";
import {
  autopilotControlsTable,
  autopilotDecisionClaimsTable,
  autopilotEventsTable,
  autopilotMandateStatesTable,
  brainVersionsTable,
  demoMandatesTable,
  type AutopilotControlRecord,
  type AutopilotDecisionClaimRecord,
  type AutopilotMandateStateRecord,
  type BrainVersionRecord,
  type DemoMandateRecord,
} from "@workspace/db";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { BRAIN_V0_CONTROL_COMMIT, BRAIN_V0_VERSION } from "../intelligence/baseline";
import { sha256Fingerprint } from "../intelligence/canonical";
import {
  AutopilotStateSchema,
  BrainVersionStateSchema,
  DemoAutopilotMandateCoreSchema,
  DemoAutopilotMandateSchema,
  mandateFingerprint,
  type AutopilotState,
  type BrainVersionState,
  type DemoAutopilotMandate,
  type DemoAutopilotMandateCore,
} from "./contracts";
export { globalAutopilotSuspended } from "./config";

export type AutopilotTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type AutopilotWriter = typeof db | AutopilotTransaction;

export interface AutopilotSnapshot {
  control: AutopilotControlRecord;
  mandate: DemoAutopilotMandate | null;
  brainVersion: BrainVersionRecord | null;
  mandateState: AutopilotMandateStateRecord | null;
}

export interface AuditActor {
  actorType: "user" | "engine" | "system" | "operator";
  actorUserId?: number;
}

function mapMandate(row: DemoMandateRecord): DemoAutopilotMandate {
  return DemoAutopilotMandateSchema.parse({
    id: row.id,
    schemaVersion: "phase10-demo-autopilot-v1",
    userId: row.userId,
    section: row.section,
    version: row.version,
    botConfigId: row.botConfigId,
    configFingerprint: row.configFingerprint,
    brainVersionId: row.brainVersionId,
    brainVersion: row.brainVersion,
    executionAuthority: row.executionAuthority,
    marketType: row.marketType,
    instruments: row.instruments,
    strategyVersions: row.strategyVersions,
    maximumPositionSizeUsdt: Number(row.maximumPositionSizeUsdt),
    maximumLeverage: row.maximumLeverage,
    maximumPortfolioRiskPercent: Number(row.maximumPortfolioRiskPercent),
    maximumSymbolExposurePercent: Number(row.maximumSymbolExposurePercent),
    maximumNetExposurePercent: Number(row.maximumNetExposurePercent),
    maximumCorrelatedExposurePercent: Number(row.maximumCorrelatedExposurePercent),
    dailyLossLimitUsdt: Number(row.dailyLossLimitUsdt),
    maximumDrawdownPercent: Number(row.maximumDrawdownPercent),
    maximumConcurrentPositions: row.maximumConcurrentPositions,
    maximumMarketDataAgeSeconds: row.maximumMarketDataAgeSeconds,
    allowedTradingHoursUtc: row.allowedTradingHoursUtc,
    permittedPhase7Actions: row.permittedPhase7Actions,
    validFrom: row.validFrom.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    fingerprint: row.fingerprint,
    createdAt: row.createdAt.toISOString(),
  });
}

async function appendEvent(input: {
  userId: number;
  section: string;
  eventType: string;
  actor: AuditActor;
  reasonCode: string;
  reason: string;
  brainVersionId?: number;
  mandateId?: number;
  decisionClaimId?: number;
  fromState?: string | null;
  toState?: string | null;
  fingerprint?: string;
  payload?: Record<string, unknown>;
}, tx: AutopilotWriter = db): Promise<void> {
  await tx.insert(autopilotEventsTable).values({
    userId: input.userId,
    section: input.section,
    eventType: input.eventType,
    actorType: input.actor.actorType,
    ...(input.actor.actorUserId != null && { actorUserId: input.actor.actorUserId }),
    ...(input.brainVersionId != null && { brainVersionId: input.brainVersionId }),
    ...(input.mandateId != null && { mandateId: input.mandateId }),
    ...(input.decisionClaimId != null && { decisionClaimId: input.decisionClaimId }),
    ...(input.fromState !== undefined && { fromState: input.fromState }),
    ...(input.toState !== undefined && { toState: input.toState }),
    reasonCode: input.reasonCode,
    reason: input.reason,
    ...(input.fingerprint && { fingerprint: input.fingerprint }),
    ...(input.payload && { payload: input.payload }),
  });
}

export async function ensureBrainV0Version(userId: number, section: "crypto" | "forex"): Promise<BrainVersionRecord> {
  const fingerprint = sha256Fingerprint({
    version: BRAIN_V0_VERSION,
    implementation: "brain-v0-control",
    sourceCommit: BRAIN_V0_CONTROL_COMMIT,
  });
  const created = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(brainVersionsTable).values({
      userId,
      section,
      version: BRAIN_V0_VERSION,
      implementation: "brain-v0-control",
      state: "COPILOT",
      fingerprint,
      sourceCommit: BRAIN_V0_CONTROL_COMMIT,
      evidenceReferences: ["BRAIN_V0_BASELINE", "PHASE_9_COPILOT_CONTROL"],
      createdByUserId: userId,
    }).onConflictDoNothing().returning();
    if (!inserted) return null;
    await appendEvent({
      userId, section, eventType: "BRAIN_VERSION_REGISTERED",
      actor: { actorType: "system" }, brainVersionId: inserted.id,
      toState: inserted.state, reasonCode: "CONTROL_BASELINE_REGISTERED",
      reason: "Existing Brain V0 control was registered at its current Co-Pilot stage; no autonomous authority was granted",
      fingerprint,
    }, tx);
    return inserted;
  });
  if (created) {
    return created;
  }
  const [existing] = await db.select().from(brainVersionsTable).where(and(
    eq(brainVersionsTable.userId, userId),
    eq(brainVersionsTable.section, section),
    eq(brainVersionsTable.version, BRAIN_V0_VERSION),
  )).limit(1);
  if (!existing) throw new Error("Brain V0 registry row could not be loaded");
  return existing;
}

const ALLOWED_TRANSITIONS: Readonly<Record<BrainVersionState, readonly BrainVersionState[]>> = {
  DRAFT: ["RESEARCH", "RETIRED"],
  RESEARCH: ["SHADOW", "SUSPENDED", "RETIRED"],
  SHADOW: ["COPILOT", "SUSPENDED", "RETIRED"],
  COPILOT: ["DEMO_APPROVED", "SUSPENDED", "RETIRED"],
  DEMO_APPROVED: ["LIVE_RESTRICTED", "SHADOW", "SUSPENDED", "RETIRED"],
  LIVE_RESTRICTED: ["SUSPENDED", "RETIRED"],
  SUSPENDED: ["COPILOT", "RETIRED"],
  RETIRED: [],
};

export async function registerBrainVersion(input: {
  userId: number;
  section: "crypto" | "forex";
  version: string;
  implementation: string;
  sourceCommit: string;
  evidenceReferences: string[];
  actorUserId: number;
}): Promise<BrainVersionRecord> {
  const fingerprint = sha256Fingerprint({
    version: input.version,
    implementation: input.implementation,
    sourceCommit: input.sourceCommit,
    evidenceReferences: [...input.evidenceReferences].sort(),
  });
  return db.transaction(async (tx) => {
    const [created] = await tx.insert(brainVersionsTable).values({
      userId: input.userId,
      section: input.section,
      version: input.version,
      implementation: input.implementation,
      state: "DRAFT",
      fingerprint,
      sourceCommit: input.sourceCommit,
      evidenceReferences: input.evidenceReferences,
      createdByUserId: input.actorUserId,
    }).returning();
    if (!created) throw new Error("Brain version was not registered");
    await appendEvent({
      userId: input.userId, section: input.section, eventType: "BRAIN_VERSION_REGISTERED",
      actor: { actorType: "user", actorUserId: input.actorUserId }, brainVersionId: created.id,
      toState: "DRAFT", reasonCode: "BRAIN_VERSION_REGISTERED",
      reason: "Candidate brain version registered without execution authority",
      fingerprint,
    }, tx);
    return created;
  });
}

export async function transitionBrainVersion(input: {
  userId: number;
  section: "crypto" | "forex";
  versionId: number;
  toState: BrainVersionState;
  reason: string;
  actorUserId: number;
}): Promise<BrainVersionRecord> {
  const toState = BrainVersionStateSchema.parse(input.toState);
  if (toState === "LIVE_RESTRICTED") {
    throw new Error("Phase 10 cannot grant or transition into Live authority");
  }
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(brainVersionsTable).where(and(
      eq(brainVersionsTable.id, input.versionId),
      eq(brainVersionsTable.userId, input.userId),
      eq(brainVersionsTable.section, input.section),
    )).limit(1).for("update");
    if (!current) throw new Error("Brain version not found");
    const fromState = BrainVersionStateSchema.parse(current.state);
    if (toState === "DEMO_APPROVED" && current.implementation !== "brain-v0-control") {
      throw new Error("This brain implementation is not wired to the controlled execution path and cannot be DEMO_APPROVED");
    }
    if (!ALLOWED_TRANSITIONS[fromState].includes(toState)) {
      throw new Error(`Brain version transition ${fromState} -> ${toState} is not allowed`);
    }
    const [updated] = await tx.update(brainVersionsTable).set({ state: toState }).where(eq(brainVersionsTable.id, current.id)).returning();
    if (!updated) throw new Error("Brain version transition was not persisted");
    await appendEvent({
      userId: input.userId, section: input.section, eventType: "BRAIN_VERSION_TRANSITIONED",
      actor: { actorType: "user", actorUserId: input.actorUserId }, brainVersionId: current.id,
      fromState, toState, reasonCode: `BRAIN_VERSION_${toState}`, reason: input.reason,
      fingerprint: current.fingerprint,
    }, tx);
    return updated;
  });
}

/**
 * Phase 12-only exact-version transition. The caller owns the transaction so
 * the brain transition cannot commit independently of mandate authorization.
 */
export async function authorizeRestrictedLiveBrainVersionInTransaction(
  tx: AutopilotTransaction,
  input: {
    userId: number;
    section: "crypto" | "forex";
    versionId: number;
    expectedVersion: string;
    expectedFingerprint: string;
    reason: string;
    actorUserId: number;
  },
): Promise<BrainVersionRecord> {
  const [current] = await tx.select().from(brainVersionsTable).where(and(
      eq(brainVersionsTable.id, input.versionId),
      eq(brainVersionsTable.userId, input.userId),
      eq(brainVersionsTable.section, input.section),
      eq(brainVersionsTable.version, input.expectedVersion),
      eq(brainVersionsTable.fingerprint, input.expectedFingerprint),
  )).limit(1).for("update");
  if (!current) throw new Error("Exact brain version was not found");
  if (current.state === "LIVE_RESTRICTED") return current;
  if (current.state !== "DEMO_APPROVED") {
    throw new Error("Restricted Live requires the exact DEMO_APPROVED brain version");
  }
  const [updated] = await tx.update(brainVersionsTable)
    .set({ state: "LIVE_RESTRICTED" })
    .where(eq(brainVersionsTable.id, current.id))
    .returning();
  if (!updated) throw new Error("Brain Live restriction was not persisted");
  await appendEvent({
      userId: input.userId,
      section: input.section,
      eventType: "BRAIN_VERSION_TRANSITIONED",
      actor: { actorType: "user", actorUserId: input.actorUserId },
      brainVersionId: current.id,
      fromState: "DEMO_APPROVED",
      toState: "LIVE_RESTRICTED",
      reasonCode: "BRAIN_VERSION_LIVE_RESTRICTED",
      reason: input.reason,
      fingerprint: current.fingerprint,
  }, tx);
  return updated;
}

export async function createMandate(coreInput: DemoAutopilotMandateCore, actorUserId: number): Promise<DemoAutopilotMandate> {
  const core = DemoAutopilotMandateCoreSchema.parse(coreInput);
  const fingerprint = mandateFingerprint(core);
  return db.transaction(async (tx) => {
    const [brain] = await tx.select().from(brainVersionsTable).where(and(
      eq(brainVersionsTable.id, core.brainVersionId),
      eq(brainVersionsTable.userId, core.userId),
      eq(brainVersionsTable.section, core.section),
      eq(brainVersionsTable.version, core.brainVersion),
    )).limit(1).for("update");
    if (!brain || brain.state !== "DEMO_APPROVED") {
      throw new Error("Only an exact DEMO_APPROVED brain version can receive a Demo Autopilot mandate");
    }
    const [inserted] = await tx.insert(demoMandatesTable).values({
      userId: core.userId,
      section: core.section,
      version: core.version,
      botConfigId: core.botConfigId,
      configFingerprint: core.configFingerprint,
      brainVersionId: core.brainVersionId,
      brainVersion: core.brainVersion,
      executionAuthority: core.executionAuthority,
      marketType: core.marketType,
      instruments: core.instruments,
      strategyVersions: core.strategyVersions,
      maximumPositionSizeUsdt: String(core.maximumPositionSizeUsdt),
      maximumLeverage: core.maximumLeverage,
      maximumPortfolioRiskPercent: String(core.maximumPortfolioRiskPercent),
      maximumSymbolExposurePercent: String(core.maximumSymbolExposurePercent),
      maximumNetExposurePercent: String(core.maximumNetExposurePercent),
      maximumCorrelatedExposurePercent: String(core.maximumCorrelatedExposurePercent),
      dailyLossLimitUsdt: String(core.dailyLossLimitUsdt),
      maximumDrawdownPercent: String(core.maximumDrawdownPercent),
      maximumConcurrentPositions: core.maximumConcurrentPositions,
      maximumMarketDataAgeSeconds: core.maximumMarketDataAgeSeconds,
      allowedTradingHoursUtc: core.allowedTradingHoursUtc,
      permittedPhase7Actions: core.permittedPhase7Actions,
      validFrom: new Date(core.validFrom),
      expiresAt: new Date(core.expiresAt),
      fingerprint,
      createdByUserId: actorUserId,
    }).returning();
    if (!inserted) throw new Error("Demo Autopilot mandate was not persisted");
    await tx.insert(autopilotMandateStatesTable).values({
      mandateId: inserted.id,
      userId: core.userId,
      section: core.section,
      state: "INACTIVE",
      reasonCode: "MANDATE_CREATED",
      reason: "Mandate has not been activated",
    });
    await appendEvent({
      userId: core.userId, section: core.section, eventType: "MANDATE_CREATED",
      actor: { actorType: "user", actorUserId }, brainVersionId: core.brainVersionId,
      mandateId: inserted.id, toState: "INACTIVE", reasonCode: "MANDATE_CREATED",
      reason: "Immutable Demo Autopilot mandate created; activation remains a separate human action",
      fingerprint,
    }, tx);
    return mapMandate(inserted);
  });
}

async function ensureControl(userId: number, section: "crypto" | "forex"): Promise<AutopilotControlRecord> {
  const [created] = await db.insert(autopilotControlsTable).values({ userId, section }).onConflictDoNothing().returning();
  if (created) return created;
  const [existing] = await db.select().from(autopilotControlsTable).where(and(
    eq(autopilotControlsTable.userId, userId), eq(autopilotControlsTable.section, section),
  )).limit(1);
  if (!existing) throw new Error("Autopilot control row could not be loaded");
  return existing;
}

/**
 * Persist the global-suspension activation refusal and the reduced control
 * state in one transaction. The requested mandate is never activated and no
 * autonomous decision claim is created.
 */
export async function refuseAutopilotActivationWhileGloballySuspended(input: {
  userId: number;
  section: "crypto" | "forex";
  requestedMandateId: number;
  actorUserId: number;
}): Promise<void> {
  await ensureControl(input.userId, input.section);
  const reasonCode = "GLOBAL_SUSPENSION_ACTIVE";
  const reason = "Broker sandbox AutoPilot suspension is active; activation is refused";
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(autopilotControlsTable).where(and(
      eq(autopilotControlsTable.userId, input.userId),
      eq(autopilotControlsTable.section, input.section),
    )).limit(1).for("update");
    if (!current) throw new Error("Autopilot control row not found while recording activation refusal");
    const [requestedMandate] = await tx.select({ id: demoMandatesTable.id }).from(demoMandatesTable).where(and(
      eq(demoMandatesTable.id, input.requestedMandateId),
      eq(demoMandatesTable.userId, input.userId),
      eq(demoMandatesTable.section, input.section),
    )).limit(1);

    await tx.update(autopilotControlsTable).set({
      state: "AUTOPILOT_BLOCKED",
      reasonCode,
      reason,
      globalSuspended: true,
      configSuspended: true,
      lastEvaluatedAt: new Date(),
    }).where(eq(autopilotControlsTable.id, current.id));

    if (current.mandateId) {
      const [lifecycle] = await tx.select().from(autopilotMandateStatesTable)
        .where(eq(autopilotMandateStatesTable.mandateId, current.mandateId))
        .limit(1)
        .for("update");
      if (lifecycle && lifecycle.state !== "REVOKED" && lifecycle.state !== "EXPIRED" && lifecycle.state !== "SUSPENDED") {
        await tx.update(autopilotMandateStatesTable).set({
          state: "SUSPENDED",
          reasonCode,
          reason,
        }).where(eq(autopilotMandateStatesTable.id, lifecycle.id));
        await appendEvent({
          userId: input.userId,
          section: input.section,
          eventType: "MANDATE_SUSPENDED",
          actor: { actorType: "user", actorUserId: input.actorUserId },
          mandateId: current.mandateId,
          fromState: lifecycle.state,
          toState: "SUSPENDED",
          reasonCode,
          reason,
        }, tx);
      }
    }

    await appendEvent({
      userId: input.userId,
      section: input.section,
      eventType: "AUTOPILOT_ACTIVATION_REFUSED",
      actor: { actorType: "user", actorUserId: input.actorUserId },
      ...(requestedMandate && { mandateId: requestedMandate.id }),
      fromState: current.state,
      toState: "AUTOPILOT_BLOCKED",
      reasonCode,
      reason,
      fingerprint: sha256Fingerprint({
        userId: input.userId,
        section: input.section,
        requestedMandateId: input.requestedMandateId,
        reasonCode,
      }),
      payload: {
        requestedMandateId: input.requestedMandateId,
        requestedMandateExists: Boolean(requestedMandate),
        claimCreated: false,
        intentCreated: false,
        tradeCreated: false,
      },
    }, tx);
  });
}

export async function setAutopilotState(input: {
  userId: number;
  section: "crypto" | "forex";
  state: AutopilotState;
  reasonCode: string;
  reason: string;
  actor: AuditActor;
  mandateId?: number | null;
  configSuspended?: boolean;
  globalSuspended?: boolean;
}): Promise<AutopilotControlRecord> {
  const state = AutopilotStateSchema.parse(input.state);
  await ensureControl(input.userId, input.section);
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(autopilotControlsTable).where(and(
      eq(autopilotControlsTable.userId, input.userId),
      eq(autopilotControlsTable.section, input.section),
    )).limit(1).for("update");
    if (!current) throw new Error("Autopilot control row not found");
    const mandateId = input.mandateId === undefined ? current.mandateId : input.mandateId;
    if (state === "AUTOPILOT_ENABLED") {
      if (!mandateId) throw new Error("Autopilot cannot be enabled without a mandate");
      const [mandate] = await tx.select().from(demoMandatesTable).where(and(
        eq(demoMandatesTable.id, mandateId),
        eq(demoMandatesTable.userId, input.userId),
        eq(demoMandatesTable.section, input.section),
      )).limit(1);
      if (!mandate || mandate.expiresAt.getTime() <= Date.now()) throw new Error("Autopilot mandate is missing or expired");
      const [mandateState] = await tx.select().from(autopilotMandateStatesTable).where(eq(autopilotMandateStatesTable.mandateId, mandateId)).limit(1).for("update");
      if (!mandateState || mandateState.state === "REVOKED" || mandateState.state === "EXPIRED") {
        throw new Error("Autopilot mandate is revoked or expired");
      }
      const [brain] = await tx.select().from(brainVersionsTable).where(eq(brainVersionsTable.id, mandate.brainVersionId)).limit(1);
      if (!brain || brain.state !== "DEMO_APPROVED") throw new Error("Mandate brain version is not DEMO_APPROVED");
    }
    const noChange = current.state === state && current.reasonCode === input.reasonCode && current.reason === input.reason
      && current.mandateId === mandateId
      && (input.configSuspended === undefined || current.configSuspended === input.configSuspended)
      && (input.globalSuspended === undefined || current.globalSuspended === input.globalSuspended);
    if (noChange) return current;
    const [updated] = await tx.update(autopilotControlsTable).set({
      state,
      reasonCode: input.reasonCode,
      reason: input.reason,
      mandateId,
      ...(input.configSuspended !== undefined && { configSuspended: input.configSuspended }),
      ...(input.globalSuspended !== undefined && { globalSuspended: input.globalSuspended }),
      lastEvaluatedAt: new Date(),
    }).where(eq(autopilotControlsTable.id, current.id)).returning();
    if (!updated) throw new Error("Autopilot control transition was not persisted");
    if (mandateId) {
      const [mandateState] = await tx.select().from(autopilotMandateStatesTable).where(eq(autopilotMandateStatesTable.mandateId, mandateId)).limit(1).for("update");
      if (mandateState && mandateState.state !== "REVOKED") {
        const nextMandateState = state === "AUTOPILOT_ENABLED"
          ? "ACTIVE"
          : input.reasonCode === "MANDATE_EXPIRED"
            ? "EXPIRED"
            : "SUSPENDED";
        if (nextMandateState === "ACTIVE") {
          await tx.update(autopilotMandateStatesTable).set({
            state: "SUSPENDED",
            reasonCode: "SUPERSEDED_BY_ACTIVE_MANDATE",
            reason: "Another immutable mandate was activated for this configuration",
          }).where(and(
            eq(autopilotMandateStatesTable.userId, input.userId),
            eq(autopilotMandateStatesTable.section, input.section),
            eq(autopilotMandateStatesTable.state, "ACTIVE"),
          ));
        }
        await tx.update(autopilotMandateStatesTable).set({
          state: nextMandateState,
          reasonCode: input.reasonCode,
          reason: input.reason,
        }).where(eq(autopilotMandateStatesTable.id, mandateState.id));
        await appendEvent({
          userId: input.userId, section: input.section,
          eventType: `MANDATE_${nextMandateState}`,
          actor: input.actor, mandateId,
          fromState: mandateState.state, toState: nextMandateState,
          reasonCode: input.reasonCode, reason: input.reason,
        }, tx);
      }
    }
    await appendEvent({
      userId: input.userId, section: input.section,
      eventType: state === "AUTOPILOT_ENABLED" ? "AUTOPILOT_RESUMED" : state === "AUTOPILOT_PAUSED" ? "AUTOPILOT_PAUSED" : "AUTOPILOT_BLOCKED",
      actor: input.actor, mandateId: mandateId ?? undefined,
      fromState: current.state, toState: state, reasonCode: input.reasonCode,
      reason: input.reason,
    }, tx);
    return updated;
  });
}

export async function getAutopilotSnapshot(userId: number, section: "crypto" | "forex"): Promise<AutopilotSnapshot> {
  const control = await ensureControl(userId, section);
  let mandate: DemoAutopilotMandate | null = null;
  let brainVersion: BrainVersionRecord | null = null;
  let mandateState: AutopilotMandateStateRecord | null = null;
  if (control.mandateId) {
    const [mandateRow] = await db.select().from(demoMandatesTable).where(and(
      eq(demoMandatesTable.id, control.mandateId), eq(demoMandatesTable.userId, userId), eq(demoMandatesTable.section, section),
    )).limit(1);
    if (mandateRow) {
      mandate = mapMandate(mandateRow);
      const [state] = await db.select().from(autopilotMandateStatesTable).where(eq(autopilotMandateStatesTable.mandateId, mandateRow.id)).limit(1);
      mandateState = state ?? null;
      const [brain] = await db.select().from(brainVersionsTable).where(eq(brainVersionsTable.id, mandateRow.brainVersionId)).limit(1);
      brainVersion = brain ?? null;
    }
  }
  return { control, mandate, brainVersion, mandateState };
}

export async function revokeMandate(input: {
  userId: number;
  section: "crypto" | "forex";
  mandateId: number;
  actorUserId: number;
  reason: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [lifecycle] = await tx.select().from(autopilotMandateStatesTable).where(and(
      eq(autopilotMandateStatesTable.mandateId, input.mandateId),
      eq(autopilotMandateStatesTable.userId, input.userId),
      eq(autopilotMandateStatesTable.section, input.section),
    )).limit(1).for("update");
    if (!lifecycle) throw new Error("Mandate not found");
    if (lifecycle.state === "REVOKED") return;
    await tx.update(autopilotMandateStatesTable).set({
      state: "REVOKED", reasonCode: "MANDATE_REVOKED", reason: input.reason,
    }).where(eq(autopilotMandateStatesTable.id, lifecycle.id));
    await tx.update(autopilotControlsTable).set({
      state: "AUTOPILOT_BLOCKED",
      reasonCode: "MANDATE_REVOKED",
      reason: input.reason,
      configSuspended: true,
    }).where(and(
      eq(autopilotControlsTable.userId, input.userId),
      eq(autopilotControlsTable.section, input.section),
      eq(autopilotControlsTable.mandateId, input.mandateId),
    ));
    await appendEvent({
      userId: input.userId, section: input.section, eventType: "MANDATE_REVOKED",
      actor: { actorType: "user", actorUserId: input.actorUserId }, mandateId: input.mandateId,
      fromState: lifecycle.state, toState: "REVOKED", reasonCode: "MANDATE_REVOKED", reason: input.reason,
    }, tx);
  });
}

export async function listBrainVersions(userId: number, section: "crypto" | "forex"): Promise<BrainVersionRecord[]> {
  await ensureBrainV0Version(userId, section);
  return db.select().from(brainVersionsTable).where(and(eq(brainVersionsTable.userId, userId), eq(brainVersionsTable.section, section))).orderBy(desc(brainVersionsTable.createdAt));
}

export async function nextMandateVersion(userId: number, section: "crypto" | "forex"): Promise<number> {
  const [row] = await db.select({ value: max(demoMandatesTable.version) }).from(demoMandatesTable).where(and(eq(demoMandatesTable.userId, userId), eq(demoMandatesTable.section, section)));
  return Number(row?.value ?? 0) + 1;
}

export async function listMandates(userId: number, section: "crypto" | "forex"): Promise<DemoAutopilotMandate[]> {
  const rows = await db.select().from(demoMandatesTable).where(and(eq(demoMandatesTable.userId, userId), eq(demoMandatesTable.section, section))).orderBy(desc(demoMandatesTable.createdAt));
  return rows.map(mapMandate);
}

export async function listAutopilotEvents(userId: number, section: "crypto" | "forex", limit = 100) {
  return db.select().from(autopilotEventsTable).where(and(eq(autopilotEventsTable.userId, userId), eq(autopilotEventsTable.section, section))).orderBy(desc(autopilotEventsTable.occurredAt)).limit(Math.max(1, Math.min(limit, 500)));
}

const PHASE10_VALIDATION_EVENT_TYPES = new Set([
  "PHASE10_VALIDATION_STAGE_STARTED",
  "PHASE10_VALIDATION_RECONCILIATION_HEALTHY",
  "PHASE10_VALIDATION_ENTRY_SUCCEEDED",
  "PHASE10_VALIDATION_MANAGEMENT_PERSISTED",
  "PHASE10_VALIDATION_RELOAD_VERIFIED",
  "PHASE10_VALIDATION_CLOSE_SUCCEEDED",
  "PHASE10_VALIDATION_COMPLETED",
  "PHASE10_VALIDATION_GLOBAL_SUSPENSION_RESTORED",
  "PHASE10_VALIDATION_REFUSED",
] as const);

export async function recordPhase10ValidationEvent(input: {
  userId: number;
  section: "crypto" | "forex";
  eventType: string;
  operatorUserId: number;
  runId: string;
  reasonCode: string;
  reason: string;
  mandateId?: number;
  decisionClaimId?: number;
  fromState?: string | null;
  toState?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  if (!PHASE10_VALIDATION_EVENT_TYPES.has(input.eventType as never)) {
    throw new Error(`Unsupported Phase 10 validation audit event ${input.eventType}`);
  }
  await db.transaction(async (tx) => {
    await appendEvent({
      userId: input.userId,
      section: input.section,
      eventType: input.eventType,
      actor: { actorType: "operator", actorUserId: input.operatorUserId },
      ...(input.mandateId != null && { mandateId: input.mandateId }),
      ...(input.decisionClaimId != null && { decisionClaimId: input.decisionClaimId }),
      ...(input.fromState !== undefined && { fromState: input.fromState }),
      ...(input.toState !== undefined && { toState: input.toState }),
      reasonCode: input.reasonCode,
      reason: input.reason,
      fingerprint: sha256Fingerprint({
        runId: input.runId,
        eventType: input.eventType,
        reasonCode: input.reasonCode,
        mandateId: input.mandateId ?? null,
        decisionClaimId: input.decisionClaimId ?? null,
        payload: input.payload ?? null,
      }),
      payload: { runId: input.runId, ...(input.payload ?? {}) },
    }, tx);
  });
}

export async function listPhase10ValidationEvents(
  userId: number,
  section: "crypto" | "forex",
  runId: string,
) {
  return db.select().from(autopilotEventsTable).where(and(
    eq(autopilotEventsTable.userId, userId),
    eq(autopilotEventsTable.section, section),
    sql`${autopilotEventsTable.payload}->>'runId' = ${runId}`,
  )).orderBy(autopilotEventsTable.occurredAt, autopilotEventsTable.id);
}

export async function claimAutonomousDecision(input: {
  userId: number;
  section: "crypto" | "forex";
  mandateId: number;
  mandateFingerprint: string;
  brainVersion: string;
  decisionFingerprint: string;
  riskFingerprint: string;
  idempotencyKey: string;
}): Promise<AutopilotDecisionClaimRecord | null> {
  return db.transaction(async (tx) => {
    const [claim] = await tx.insert(autopilotDecisionClaimsTable).values(input).onConflictDoNothing().returning();
    if (!claim) {
      await appendEvent({
        userId: input.userId, section: input.section, eventType: "AUTONOMOUS_DECISION_REFUSED",
        actor: { actorType: "engine" }, mandateId: input.mandateId,
        reasonCode: "DUPLICATE_AUTONOMOUS_DECISION",
        reason: "This exact mandate and deterministic decision were already claimed; no duplicate order was submitted",
        fingerprint: input.decisionFingerprint,
        payload: { idempotencyKey: input.idempotencyKey },
      }, tx);
      return null;
    }
    await appendEvent({
      userId: input.userId, section: input.section, eventType: "AUTONOMOUS_DECISION_CLAIMED",
      actor: { actorType: "engine" }, mandateId: input.mandateId, decisionClaimId: claim.id,
      toState: "CLAIMED", reasonCode: "AUTONOMOUS_DECISION_CLAIMED",
      reason: "Deterministic autonomous decision claimed exactly once before execution",
      fingerprint: input.decisionFingerprint,
      payload: { riskFingerprint: input.riskFingerprint },
    }, tx);
    return claim;
  });
}

export async function completeAutonomousDecision(input: {
  claimId: number;
  userId: number;
  section: "crypto" | "forex";
  status: "EXECUTED" | "REFUSED" | "FAILED";
  reasonCode: string;
  reason: string;
  tradeId?: number;
  executionIntentId?: number;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [claim] = await tx.select().from(autopilotDecisionClaimsTable).where(and(
      eq(autopilotDecisionClaimsTable.id, input.claimId),
      eq(autopilotDecisionClaimsTable.userId, input.userId),
      eq(autopilotDecisionClaimsTable.section, input.section),
    )).limit(1).for("update");
    if (!claim || claim.status !== "CLAIMED") return;
    await tx.update(autopilotDecisionClaimsTable).set({
      status: input.status,
      outcomeReason: input.reason,
      ...(input.tradeId != null && { tradeId: input.tradeId }),
      ...(input.executionIntentId != null && { executionIntentId: input.executionIntentId }),
    }).where(eq(autopilotDecisionClaimsTable.id, claim.id));
    await appendEvent({
      userId: input.userId, section: input.section,
      eventType: input.status === "EXECUTED" ? "AUTONOMOUS_EXECUTION_SUCCEEDED" : input.status === "REFUSED" ? "AUTONOMOUS_EXECUTION_REFUSED" : "AUTONOMOUS_EXECUTION_FAILED",
      actor: { actorType: "engine" }, ...(claim.mandateId != null && { mandateId: claim.mandateId }), decisionClaimId: claim.id,
      fromState: "CLAIMED", toState: input.status, reasonCode: input.reasonCode,
      reason: input.reason, fingerprint: claim.decisionFingerprint,
      payload: { ...(input.tradeId != null && { tradeId: input.tradeId }), ...(input.executionIntentId != null && { executionIntentId: input.executionIntentId }) },
    }, tx);
  });
}

export async function recordAutonomousRefusal(input: {
  userId: number;
  section: "crypto" | "forex";
  mandateId?: number;
  mandateFingerprint?: string;
  decisionFingerprint: string;
  reasonCode: string;
  reason: string;
  checks: unknown;
}): Promise<void> {
  const idempotencyKey = `refusal:${sha256Fingerprint({ userId: input.userId, section: input.section, decisionFingerprint: input.decisionFingerprint, reasonCode: input.reasonCode })}`;
  await db.transaction(async (tx) => {
    const [claim] = await tx.insert(autopilotDecisionClaimsTable).values({
      userId: input.userId,
      section: input.section,
      ...(input.mandateId != null && { mandateId: input.mandateId }),
      mandateFingerprint: input.mandateFingerprint ?? "mandate:missing",
      brainVersion: "unknown",
      decisionFingerprint: input.decisionFingerprint,
      riskFingerprint: sha256Fingerprint(input.checks),
      idempotencyKey,
      status: "REFUSED",
      outcomeReason: input.reason,
    }).onConflictDoNothing().returning();
    if (!claim) return;
    await appendEvent({
      userId: input.userId, section: input.section, eventType: "AUTONOMOUS_DECISION_REFUSED",
      actor: { actorType: "engine" }, mandateId: input.mandateId, decisionClaimId: claim.id,
      toState: "REFUSED", reasonCode: input.reasonCode, reason: input.reason,
      fingerprint: input.decisionFingerprint, payload: { checks: input.checks },
    }, tx);
  });
}

export async function updateEquityWatermark(input: {
  userId: number;
  section: "crypto" | "forex";
  now: Date;
  equityUsdt: number | null;
}): Promise<{ drawdownPercent: number | null }> {
  if (input.equityUsdt === null || !Number.isFinite(input.equityUsdt) || input.equityUsdt <= 0) return { drawdownPercent: null };
  await ensureControl(input.userId, input.section);
  const day = input.now.toISOString().slice(0, 10);
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(autopilotControlsTable).where(and(
      eq(autopilotControlsTable.userId, input.userId), eq(autopilotControlsTable.section, input.section),
    )).limit(1).for("update");
    if (!current) return { drawdownPercent: null };
    const reset = current.equityDay !== day || current.dayStartEquityUsdt === null || current.highWaterEquityUsdt === null;
    const highWater = reset ? input.equityUsdt! : Math.max(Number(current.highWaterEquityUsdt), input.equityUsdt!);
    const drawdownPercent = highWater > 0 ? Math.max(0, ((highWater - input.equityUsdt!) / highWater) * 100) : null;
    await tx.update(autopilotControlsTable).set({
      equityDay: day,
      dayStartEquityUsdt: reset ? String(input.equityUsdt) : current.dayStartEquityUsdt,
      highWaterEquityUsdt: String(highWater),
      lastEvaluatedAt: input.now,
    }).where(eq(autopilotControlsTable.id, current.id));
    return { drawdownPercent };
  });
}
