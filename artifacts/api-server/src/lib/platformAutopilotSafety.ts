import { randomUUID } from "node:crypto";
import {
  db,
  liveKillSwitchesTable,
  liveSafetyEventsTable,
  platformAuditEventsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { autopilotDeploymentHardStop } from "./autopilot/config";

const PLATFORM_OWNER_ID = 0;
const PLATFORM_SECTION = "*";
const PLATFORM_SCOPE = "AUTOPILOT";
const PLATFORM_SCOPE_KEY = "*";
const RESUME_REQUEST_TTL_MS = 15 * 60_000;

type SafetyRow = typeof liveKillSwitchesTable.$inferSelect;

export interface PlatformAutopilotSafetyState {
  effectiveSuspended: boolean;
  source:
    | "DEPLOYMENT_HARD_STOP"
    | "PERSISTED_PLATFORM_CONTROL"
    | "UNINITIALIZED_FAIL_CLOSED"
    | "CONTROL_STATE_UNAVAILABLE";
  reason: string;
  deploymentHardStop: {
    active: boolean;
    configured: boolean;
    reason: string | null;
  };
  persisted: {
    initialized: boolean;
    suspended: boolean;
    updatedAt: string | null;
  };
  pendingResume: {
    requestId: string;
    requestedByUserId: number;
    requestedAt: string;
    expiresAt: string;
    reason: string;
  } | null;
}

function identityCondition() {
  return and(
    eq(liveKillSwitchesTable.ownerUserId, PLATFORM_OWNER_ID),
    eq(liveKillSwitchesTable.section, PLATFORM_SECTION),
    eq(liveKillSwitchesTable.scope, PLATFORM_SCOPE),
    eq(liveKillSwitchesTable.scopeKey, PLATFORM_SCOPE_KEY),
  );
}

function pendingResume(
  row: SafetyRow | null,
): PlatformAutopilotSafetyState["pendingResume"] {
  if (
    !row?.resumeRequestId ||
    row.resumeRequestedByUserId === null ||
    !row.resumeRequestedAt ||
    !row.resumeRequestExpiresAt ||
    !row.resumeRequestReason
  ) {
    return null;
  }
  return {
    requestId: row.resumeRequestId,
    requestedByUserId: row.resumeRequestedByUserId,
    requestedAt: row.resumeRequestedAt.toISOString(),
    expiresAt: row.resumeRequestExpiresAt.toISOString(),
    reason: row.resumeRequestReason,
  };
}

function stateFromRow(row: SafetyRow | null): PlatformAutopilotSafetyState {
  const deploymentHardStop = autopilotDeploymentHardStop();
  if (deploymentHardStop.active) {
    return {
      effectiveSuspended: true,
      source: "DEPLOYMENT_HARD_STOP",
      reason:
        deploymentHardStop.reason ?? "Deployment emergency hard stop is active",
      deploymentHardStop,
      persisted: {
        initialized: row !== null,
        suspended: row?.active ?? true,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      },
      pendingResume: pendingResume(row),
    };
  }
  if (!row) {
    return {
      effectiveSuspended: true,
      source: "UNINITIALIZED_FAIL_CLOSED",
      reason: "No reviewed platform AutoPilot resume has been approved",
      deploymentHardStop,
      persisted: { initialized: false, suspended: true, updatedAt: null },
      pendingResume: null,
    };
  }
  return {
    effectiveSuspended: row.active,
    source: "PERSISTED_PLATFORM_CONTROL",
    reason: row.reason,
    deploymentHardStop,
    persisted: {
      initialized: true,
      suspended: row.active,
      updatedAt: row.updatedAt.toISOString(),
    },
    pendingResume: pendingResume(row),
  };
}

export async function getPlatformAutopilotSafetyState(): Promise<PlatformAutopilotSafetyState> {
  try {
    const [row] = await db
      .select()
      .from(liveKillSwitchesTable)
      .where(identityCondition())
      .limit(1);
    return stateFromRow(row ?? null);
  } catch {
    const deploymentHardStop = autopilotDeploymentHardStop();
    return {
      effectiveSuspended: true,
      source: deploymentHardStop.active
        ? "DEPLOYMENT_HARD_STOP"
        : "CONTROL_STATE_UNAVAILABLE",
      reason:
        deploymentHardStop.reason ??
        "Platform AutoPilot safety state is unavailable; suspension remains active",
      deploymentHardStop,
      persisted: { initialized: false, suspended: true, updatedAt: null },
      pendingResume: null,
    };
  }
}

async function lockedSafetyRow(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<SafetyRow> {
  await tx
    .insert(liveKillSwitchesTable)
    .values({
      ownerUserId: PLATFORM_OWNER_ID,
      section: PLATFORM_SECTION,
      scope: PLATFORM_SCOPE,
      scopeKey: PLATFORM_SCOPE_KEY,
      active: true,
      reason:
        "Platform AutoPilot starts suspended until two operators approve a resume",
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(liveKillSwitchesTable)
    .where(identityCondition())
    .limit(1)
    .for("update");
  if (!row) throw new Error("Platform AutoPilot safety control is unavailable");
  return row;
}

function auditValues(input: {
  actorUserId: number;
  permission: string;
  action: string;
  requestId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}) {
  return {
    actorUserId: input.actorUserId,
    permission: input.permission,
    action: input.action,
    targetType: "platform_autopilot_safety",
    targetId: "global",
    requestId: input.requestId,
    result: "SUCCEEDED" as const,
    reason: input.reason,
    metadata: input.metadata ?? {},
  };
}

export async function requestPlatformAutopilotResume(input: {
  actorUserId: number;
  reason: string;
  clientRequestId?: string;
  auditRequestId: string;
}): Promise<PlatformAutopilotSafetyState> {
  const hardStop = autopilotDeploymentHardStop();
  if (hardStop.active) {
    throw new Error(
      `${hardStop.reason}; remove the deployment hard stop before requesting an Admin resume`,
    );
  }
  const resumeRequestId = input.clientRequestId ?? randomUUID();
  await db.transaction(async (tx) => {
    const row = await lockedSafetyRow(tx);
    if (!row.active) throw new Error("Platform AutoPilot is already resumed");
    const existing = pendingResume(row);
    if (existing && new Date(existing.expiresAt).getTime() > Date.now()) {
      if (
        existing.requestId === resumeRequestId &&
        existing.requestedByUserId === input.actorUserId &&
        existing.reason === input.reason
      ) {
        return;
      }
      throw new Error(
        "Another platform AutoPilot resume request is awaiting approval",
      );
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + RESUME_REQUEST_TTL_MS);
    await tx
      .update(liveKillSwitchesTable)
      .set({
        active: true,
        reason:
          "Platform AutoPilot resume is awaiting a second qualified operator",
        resumeRequestId,
        resumeRequestedByUserId: input.actorUserId,
        resumeRequestedAt: now,
        resumeRequestExpiresAt: expiresAt,
        resumeRequestReason: input.reason,
      })
      .where(eq(liveKillSwitchesTable.id, row.id));
    await tx.insert(platformAuditEventsTable).values(
      auditValues({
        actorUserId: input.actorUserId,
        permission: "admin.risk.resume.request",
        action: "REQUEST_PLATFORM_AUTOPILOT_RESUME",
        requestId: input.auditRequestId,
        reason: input.reason,
        metadata: { resumeRequestId, expiresAt: expiresAt.toISOString() },
      }),
    );
    await tx
      .insert(liveSafetyEventsTable)
      .values({
        eventKey: `platform-autopilot-resume-request:${resumeRequestId}`,
        targetUserId: PLATFORM_OWNER_ID,
        section: PLATFORM_SECTION,
        eventType: "PLATFORM_AUTOPILOT_RESUME_REQUESTED",
        actorType: "operator",
        actorUserId: input.actorUserId,
        reasonCode: "SECOND_OPERATOR_REQUIRED",
        reason: input.reason,
        payload: { resumeRequestId, expiresAt: expiresAt.toISOString() },
      })
      .onConflictDoNothing();
  });
  return getPlatformAutopilotSafetyState();
}

export async function approvePlatformAutopilotResume(input: {
  actorUserId: number;
  resumeRequestId: string;
  reason: string;
  auditRequestId: string;
}): Promise<PlatformAutopilotSafetyState> {
  const hardStop = autopilotDeploymentHardStop();
  if (hardStop.active) {
    throw new Error(
      `${hardStop.reason}; Admin approval cannot override the deployment hard stop`,
    );
  }
  await db.transaction(async (tx) => {
    const row = await lockedSafetyRow(tx);
    const request = pendingResume(row);
    if (!row.active) throw new Error("Platform AutoPilot is already resumed");
    if (!request || request.requestId !== input.resumeRequestId) {
      throw new Error(
        "The platform AutoPilot resume request is missing or changed",
      );
    }
    if (new Date(request.expiresAt).getTime() <= Date.now()) {
      throw new Error("The platform AutoPilot resume request expired");
    }
    if (request.requestedByUserId === input.actorUserId) {
      throw new Error(
        "A different qualified operator must approve this resume request",
      );
    }
    const now = new Date();
    await tx
      .update(liveKillSwitchesTable)
      .set({
        active: false,
        reason: input.reason,
        deactivatedAt: now,
        resumeRequestId: null,
        resumeRequestedByUserId: null,
        resumeRequestedAt: null,
        resumeRequestExpiresAt: null,
        resumeRequestReason: null,
      })
      .where(eq(liveKillSwitchesTable.id, row.id));
    await tx.insert(platformAuditEventsTable).values(
      auditValues({
        actorUserId: input.actorUserId,
        permission: "admin.risk.resume.approve",
        action: "APPROVE_PLATFORM_AUTOPILOT_RESUME",
        requestId: input.auditRequestId,
        reason: input.reason,
        metadata: {
          resumeRequestId: request.requestId,
          requestedByUserId: request.requestedByUserId,
        },
      }),
    );
    await tx
      .insert(liveSafetyEventsTable)
      .values({
        eventKey: `platform-autopilot-resume-approved:${request.requestId}`,
        targetUserId: PLATFORM_OWNER_ID,
        section: PLATFORM_SECTION,
        eventType: "PLATFORM_AUTOPILOT_RESUMED",
        actorType: "operator",
        actorUserId: input.actorUserId,
        reasonCode: "DUAL_OPERATOR_APPROVED",
        reason: input.reason,
        payload: {
          resumeRequestId: request.requestId,
          requestedByUserId: request.requestedByUserId,
          approvedByUserId: input.actorUserId,
        },
      })
      .onConflictDoNothing();
  });
  return getPlatformAutopilotSafetyState();
}

export async function suspendPlatformAutopilot(input: {
  actorUserId: number;
  reason: string;
  auditRequestId: string;
}): Promise<PlatformAutopilotSafetyState> {
  await db.transaction(async (tx) => {
    const row = await lockedSafetyRow(tx);
    const now = new Date();
    await tx
      .update(liveKillSwitchesTable)
      .set({
        active: true,
        reason: input.reason,
        activatedByUserId: input.actorUserId,
        activatedAt: now,
        deactivatedAt: null,
        resumeRequestId: null,
        resumeRequestedByUserId: null,
        resumeRequestedAt: null,
        resumeRequestExpiresAt: null,
        resumeRequestReason: null,
      })
      .where(eq(liveKillSwitchesTable.id, row.id));
    const eventId = randomUUID();
    await tx.insert(platformAuditEventsTable).values(
      auditValues({
        actorUserId: input.actorUserId,
        permission: "admin.risk.suspend",
        action: "SUSPEND_PLATFORM_AUTOPILOT",
        requestId: input.auditRequestId,
        reason: input.reason,
      }),
    );
    await tx
      .insert(liveSafetyEventsTable)
      .values({
        eventKey: `platform-autopilot-suspended:${eventId}`,
        targetUserId: PLATFORM_OWNER_ID,
        section: PLATFORM_SECTION,
        eventType: "PLATFORM_AUTOPILOT_SUSPENDED",
        actorType: "operator",
        actorUserId: input.actorUserId,
        reasonCode: "OPERATOR_SUSPENSION",
        reason: input.reason,
      })
      .onConflictDoNothing();
  });
  return getPlatformAutopilotSafetyState();
}
