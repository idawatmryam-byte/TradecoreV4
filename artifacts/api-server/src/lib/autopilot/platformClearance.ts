import { randomUUID } from "node:crypto";
import {
  db,
  platformAuditEventsTable,
  platformAutopilotClearanceEventsTable,
  type PlatformAutopilotClearanceEvent,
} from "@workspace/db";
import { desc, sql } from "drizzle-orm";
import { globalAutopilotSuspended } from "./config";
import {
  resolvePlatformAutopilotGate,
  type PlatformAutopilotClearance,
  type PlatformAutopilotGate,
} from "./platformClearancePolicy";

export {
  resolvePlatformAutopilotGate,
  type PlatformAutopilotClearance,
  type PlatformAutopilotGate,
} from "./platformClearancePolicy";

const MIN_CLEARANCE_MINUTES = 15;
const MAX_CLEARANCE_MINUTES = 24 * 60;
const EVENT_READ_LIMIT = 500;

function boundedRequestId(value: string): string {
  const requestId = value.trim().slice(0, 200);
  if (!requestId) throw new Error("A non-empty request id is required");
  return requestId;
}

type ClearanceWriter =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

function clearanceRequired(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.NODE_ENV === "production";
}

export function derivePlatformAutopilotClearances(
  rows: PlatformAutopilotClearanceEvent[],
  now: Date,
): PlatformAutopilotClearance[] {
  const grouped = new Map<string, PlatformAutopilotClearanceEvent[]>();
  for (const row of rows) {
    const events = grouped.get(row.clearanceId) ?? [];
    events.push(row);
    grouped.set(row.clearanceId, events);
  }

  return [...grouped.entries()]
    .flatMap(([clearanceId, events]) => {
      const requested = events.find((event) => event.eventType === "REQUESTED");
      if (!requested || requested.durationMinutes === null) return [];
      const approved =
        events.find((event) => event.eventType === "APPROVED") ?? null;
      const revoked =
        events.find((event) => event.eventType === "REVOKED") ?? null;
      const expiresAt = approved
        ? new Date(
            approved.createdAt.getTime() + requested.durationMinutes * 60_000,
          )
        : null;
      const state = revoked
        ? "REVOKED"
        : !approved
          ? "PENDING"
          : expiresAt!.getTime() <= now.getTime()
            ? "EXPIRED"
            : "ACTIVE";
      return [
        {
          clearanceId,
          state,
          requestedByUserId: requested.actorUserId,
          approvedByUserId: approved?.actorUserId ?? null,
          revokedByUserId: revoked?.actorUserId ?? null,
          reason: requested.reason,
          durationMinutes: requested.durationMinutes,
          requestedAt: requested.createdAt.toISOString(),
          approvedAt: approved?.createdAt.toISOString() ?? null,
          expiresAt: expiresAt?.toISOString() ?? null,
          revokedAt: revoked?.createdAt.toISOString() ?? null,
        } satisfies PlatformAutopilotClearance,
      ];
    })
    .sort(
      (left, right) =>
        Date.parse(right.requestedAt) - Date.parse(left.requestedAt),
    );
}

async function readClearances(
  writer: ClearanceWriter = db,
  now = new Date(),
): Promise<PlatformAutopilotClearance[]> {
  const rows = await writer
    .select()
    .from(platformAutopilotClearanceEventsTable)
    .orderBy(desc(platformAutopilotClearanceEventsTable.id))
    .limit(EVENT_READ_LIMIT);
  return derivePlatformAutopilotClearances(rows, now);
}

export async function getPlatformAutopilotGate(
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<PlatformAutopilotGate> {
  const deploymentSuspended = globalAutopilotSuspended(environment);
  const required = clearanceRequired(environment);
  if (!required) {
    return resolvePlatformAutopilotGate({
      deploymentSuspended,
      clearanceRequired: false,
      clearanceAvailable: true,
      clearance: null,
    });
  }

  try {
    const clearances = await readClearances(db, now);
    const clearance =
      clearances.find((item) => item.state === "ACTIVE") ??
      clearances.find((item) => item.state === "PENDING") ??
      clearances[0] ??
      null;
    return resolvePlatformAutopilotGate({
      deploymentSuspended,
      clearanceRequired: true,
      clearanceAvailable: true,
      clearance,
    });
  } catch {
    return resolvePlatformAutopilotGate({
      deploymentSuspended,
      clearanceRequired: true,
      clearanceAvailable: false,
      clearance: null,
    });
  }
}

async function lockClearanceWorkflow(writer: ClearanceWriter): Promise<void> {
  await writer.execute(sql`select pg_advisory_xact_lock(1949571, 10)`);
}

async function appendPlatformAudit(input: {
  writer: ClearanceWriter;
  actorUserId: number;
  permission: string;
  action: string;
  clearanceId: string;
  requestId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await input.writer.insert(platformAuditEventsTable).values({
    actorUserId: input.actorUserId,
    permission: input.permission,
    action: input.action,
    targetType: "platform_autopilot_clearance",
    targetId: input.clearanceId,
    requestId: input.requestId,
    result: "SUCCEEDED",
    reason: input.reason,
    metadata: input.metadata ?? {},
  });
}

export async function requestPlatformAutopilotClearance(input: {
  actorUserId: number;
  reason: string;
  durationMinutes: number;
  requestId: string;
}): Promise<PlatformAutopilotClearance> {
  const requestId = boundedRequestId(input.requestId);
  if (
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < MIN_CLEARANCE_MINUTES ||
    input.durationMinutes > MAX_CLEARANCE_MINUTES
  ) {
    throw new Error(
      "Clearance duration must be between 15 minutes and 24 hours",
    );
  }
  return db.transaction(async (tx) => {
    await lockClearanceWorkflow(tx);
    const current = (await readClearances(tx)).find(
      (item) => item.state === "ACTIVE" || item.state === "PENDING",
    );
    if (current) {
      throw new Error(
        `Platform AutoPilot clearance ${current.clearanceId} is already ${current.state.toLowerCase()}`,
      );
    }
    const clearanceId = randomUUID();
    const [created] = await tx
      .insert(platformAutopilotClearanceEventsTable)
      .values({
        clearanceId,
        eventType: "REQUESTED",
        actorUserId: input.actorUserId,
        reason: input.reason,
        durationMinutes: input.durationMinutes,
        requestId,
      })
      .returning();
    await appendPlatformAudit({
      writer: tx,
      actorUserId: input.actorUserId,
      permission: "admin.autopilot.clearance.request",
      action: "REQUEST_PLATFORM_AUTOPILOT_CLEARANCE",
      clearanceId,
      requestId,
      reason: input.reason,
      metadata: { durationMinutes: input.durationMinutes },
    });
    return derivePlatformAutopilotClearances([created!], new Date())[0]!;
  });
}

export async function approvePlatformAutopilotClearance(input: {
  clearanceId: string;
  actorUserId: number;
  reason: string;
  requestId: string;
}): Promise<PlatformAutopilotClearance> {
  const requestId = boundedRequestId(input.requestId);
  return db.transaction(async (tx) => {
    await lockClearanceWorkflow(tx);
    const current = (await readClearances(tx)).find(
      (item) => item.clearanceId === input.clearanceId,
    );
    if (!current || current.state !== "PENDING") {
      throw new Error("Pending platform AutoPilot clearance not found");
    }
    if (current.requestedByUserId === input.actorUserId) {
      throw new Error(
        "A different platform administrator must approve this clearance",
      );
    }
    await tx.insert(platformAutopilotClearanceEventsTable).values({
      clearanceId: input.clearanceId,
      eventType: "APPROVED",
      actorUserId: input.actorUserId,
      reason: input.reason,
      durationMinutes: null,
      requestId,
    });
    await appendPlatformAudit({
      writer: tx,
      actorUserId: input.actorUserId,
      permission: "admin.autopilot.clearance.approve",
      action: "APPROVE_PLATFORM_AUTOPILOT_CLEARANCE",
      clearanceId: input.clearanceId,
      requestId,
      reason: input.reason,
      metadata: { requestedByUserId: current.requestedByUserId },
    });
    return (await readClearances(tx)).find(
      (item) => item.clearanceId === input.clearanceId,
    )!;
  });
}

export async function revokePlatformAutopilotClearance(input: {
  clearanceId: string;
  actorUserId: number;
  reason: string;
  requestId: string;
}): Promise<PlatformAutopilotClearance> {
  const requestId = boundedRequestId(input.requestId);
  return db.transaction(async (tx) => {
    await lockClearanceWorkflow(tx);
    const current = (await readClearances(tx)).find(
      (item) => item.clearanceId === input.clearanceId,
    );
    if (
      !current ||
      (current.state !== "PENDING" && current.state !== "ACTIVE")
    ) {
      throw new Error(
        "Active or pending platform AutoPilot clearance not found",
      );
    }
    await tx.insert(platformAutopilotClearanceEventsTable).values({
      clearanceId: input.clearanceId,
      eventType: "REVOKED",
      actorUserId: input.actorUserId,
      reason: input.reason,
      durationMinutes: null,
      requestId,
    });
    await appendPlatformAudit({
      writer: tx,
      actorUserId: input.actorUserId,
      permission: "admin.autopilot.clearance.revoke",
      action: "REVOKE_PLATFORM_AUTOPILOT_CLEARANCE",
      clearanceId: input.clearanceId,
      requestId,
      reason: input.reason,
      metadata: { previousState: current.state },
    });
    return (await readClearances(tx)).find(
      (item) => item.clearanceId === input.clearanceId,
    )!;
  });
}
