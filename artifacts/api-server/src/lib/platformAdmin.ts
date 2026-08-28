import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  db,
  platformAccessVersionsTable,
  platformAuditEventsTable,
  platformRoleAssignmentsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { validateEnv } from "./env";
import { verifyPassword } from "./passwordHash";
import { verifyFinancialRequestOrigin } from "../middleware/financialRequest";
import { logger } from "./logger";
import {
  permissionsForRoles,
  PLATFORM_ROLES,
  redactPlatformAuditMetadata,
  type PlatformPermission,
  type PlatformRole,
} from "./platformAdminPolicy";

export {
  permissionsForRoles,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  redactPlatformAuditMetadata,
} from "./platformAdminPolicy";
export type { PlatformPermission, PlatformRole } from "./platformAdminPolicy";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      platformRoles?: PlatformRole[];
      platformPermissions?: PlatformPermission[];
      adminStepUpExpiresAt?: string;
    }
  }
}

export async function activePlatformRoles(userId: number): Promise<PlatformRole[]> {
  const rows = await db
    .select({ role: platformRoleAssignmentsTable.role })
    .from(platformRoleAssignmentsTable)
    .where(
      and(
        eq(platformRoleAssignmentsTable.userId, userId),
        eq(platformRoleAssignmentsTable.status, "ACTIVE"),
      ),
    );
  return rows
    .map((row) => row.role)
    .filter((role): role is PlatformRole =>
      PLATFORM_ROLES.includes(role as PlatformRole),
    );
}

export const ADMIN_STEP_UP_COOKIE_NAME = "tc_admin_stepup";
const ADMIN_STEP_UP_DURATION_MS = 15 * 60_000;

interface AdminStepUpIdentity {
  userId: number;
  sessionVersion: number;
  accessVersion: number;
  expiresAt: number;
}

function signature(payload: string): string {
  const { sessionSecret } = validateEnv();
  return createHmac("sha256", sessionSecret)
    .update(`cactus-admin-step-up-v1:${payload}`)
    .digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function createAdminStepUpToken(identity: AdminStepUpIdentity): string {
  const nonce = randomBytes(16).toString("hex");
  const payload = [
    identity.userId,
    identity.expiresAt,
    identity.sessionVersion,
    identity.accessVersion,
    nonce,
  ].join(".");
  return `${payload}.${signature(payload)}`;
}

function setAdminStepUpCookie(res: Response, identity: AdminStepUpIdentity): string {
  const token = createAdminStepUpToken(identity);
  const { nodeEnv } = validateEnv();
  res.cookie(ADMIN_STEP_UP_COOKIE_NAME, token, {
    httpOnly: true,
    secure: nodeEnv === "production",
    sameSite: "strict",
    path: "/api/admin",
    maxAge: ADMIN_STEP_UP_DURATION_MS,
  });
  return new Date(identity.expiresAt).toISOString();
}

function parseAdminStepUpToken(token: unknown): AdminStepUpIdentity | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 6) return null;
  const [userIdText, expiryText, sessionText, accessText, nonce, provided] =
    parts as [string, string, string, string, string, string];
  if (!/^[a-f0-9]{32}$/.test(nonce)) return null;
  const userId = Number(userIdText);
  const expiresAt = Number(expiryText);
  const sessionVersion = Number(sessionText);
  const accessVersion = Number(accessText);
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    !Number.isSafeInteger(sessionVersion) ||
    sessionVersion < 0 ||
    !Number.isSafeInteger(accessVersion) ||
    accessVersion < 1
  ) {
    return null;
  }
  const payload = parts.slice(0, 5).join(".");
  if (!safeEqual(provided, signature(payload))) return null;
  return { userId, expiresAt, sessionVersion, accessVersion };
}

async function currentAccessVersion(userId: number): Promise<number | null> {
  const [row] = await db
    .select({ version: platformAccessVersionsTable.version })
    .from(platformAccessVersionsTable)
    .where(eq(platformAccessVersionsTable.userId, userId))
    .limit(1);
  return row?.version ?? null;
}

export async function verifyAdminStepUp(
  req: Request,
): Promise<
  | {
      ok: true;
      roles: PlatformRole[];
      permissions: PlatformPermission[];
      expiresAt: string;
    }
  | { ok: false; reason: string }
> {
  const userId = req.userId;
  if (!userId) return { ok: false, reason: "Authentication is required" };
  const identity = parseAdminStepUpToken(
    req.cookies?.[ADMIN_STEP_UP_COOKIE_NAME],
  );
  if (!identity || identity.userId !== userId) {
    return { ok: false, reason: "Recent Admin Console step-up is required" };
  }
  const [user, roles, accessVersion] = await Promise.all([
    db
      .select({ sessionVersion: usersTable.sessionVersion })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    activePlatformRoles(userId),
    currentAccessVersion(userId),
  ]);
  if (
    !user ||
    roles.length === 0 ||
    accessVersion === null ||
    user.sessionVersion !== identity.sessionVersion ||
    accessVersion !== identity.accessVersion
  ) {
    return {
      ok: false,
      reason: "Admin access changed; authenticate again",
    };
  }
  return {
    ok: true,
    roles,
    permissions: permissionsForRoles(roles),
    expiresAt: new Date(identity.expiresAt).toISOString(),
  };
}

export async function issueAdminStepUp(input: {
  req: Request;
  res: Response;
  password: unknown;
}): Promise<
  | { ok: true; expiresAt: string; roles: PlatformRole[] }
  | { ok: false; reason: string }
> {
  const { req, res } = input;
  if (!req.userId || req.authMethod !== "cookie") {
    return {
      ok: false,
      reason: "Admin Console step-up requires an authenticated same-origin browser session",
    };
  }
  const origin = verifyFinancialRequestOrigin(req);
  if (!origin.ok) return origin;
  if (typeof input.password !== "string" || input.password.length === 0) {
    return { ok: false, reason: "Current password is required" };
  }
  const [user, roles, accessVersion] = await Promise.all([
    db
      .select({
        passwordHash: usersTable.passwordHash,
        sessionVersion: usersTable.sessionVersion,
      })
      .from(usersTable)
      .where(eq(usersTable.id, req.userId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    activePlatformRoles(req.userId),
    currentAccessVersion(req.userId),
  ]);
  if (!user || roles.length === 0 || accessVersion === null) {
    return { ok: false, reason: "Platform access is not assigned" };
  }
  if (!user.passwordHash) {
    return {
      ok: false,
      reason:
        "This account cannot satisfy Admin Console step-up; set an account password first",
    };
  }
  if (!(await verifyPassword(input.password, user.passwordHash))) {
    return { ok: false, reason: "Admin Console step-up failed" };
  }
  const expiresAt = Date.now() + ADMIN_STEP_UP_DURATION_MS;
  const expiresAtIso = setAdminStepUpCookie(res, {
    userId: req.userId,
    sessionVersion: user.sessionVersion,
    accessVersion,
    expiresAt,
  });
  return { ok: true, expiresAt: expiresAtIso, roles };
}

/**
 * A successful password login is already recent password authentication. This
 * helper lets an assigned platform operator continue straight to /admin
 * without entering the same password twice. It never assigns a role and it
 * still pins the short-lived cookie to both session and platform-access
 * versions, so password or role changes revoke it immediately.
 */
export async function issueAdminStepUpAfterPasswordLogin(input: {
  res: Response;
  userId: number;
  sessionVersion: number;
}): Promise<
  | { ok: true; expiresAt: string; roles: PlatformRole[] }
  | { ok: false; reason: string }
> {
  const [roles, accessVersion] = await Promise.all([
    activePlatformRoles(input.userId),
    currentAccessVersion(input.userId),
  ]);
  if (roles.length === 0) return { ok: false, reason: "Platform access is not assigned" };
  if (accessVersion === null) {
    return { ok: false, reason: "Platform access version is unavailable" };
  }
  const expiresAt = Date.now() + ADMIN_STEP_UP_DURATION_MS;
  const expiresAtIso = setAdminStepUpCookie(input.res, {
    userId: input.userId,
    sessionVersion: input.sessionVersion,
    accessVersion,
    expiresAt,
  });
  return { ok: true, expiresAt: expiresAtIso, roles };
}

export function clearAdminStepUp(res: Response): void {
  res.clearCookie(ADMIN_STEP_UP_COOKIE_NAME, { path: "/api/admin" });
}

export async function requireAdminStepUp(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const result = await verifyAdminStepUp(req);
  if (!result.ok) {
    clearAdminStepUp(res);
    res.status(403).json({
      error: result.reason,
      code: "ADMIN_STEP_UP_REQUIRED",
    });
    return;
  }
  req.platformRoles = result.roles;
  req.platformPermissions = result.permissions;
  req.adminStepUpExpiresAt = result.expiresAt;
  next();
}

export function requirePlatformPermission(permission: PlatformPermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.platformPermissions?.includes(permission)) {
      res.status(403).json({
        error: "Platform permission denied",
        code: "PLATFORM_PERMISSION_DENIED",
      });
      return;
    }
    next();
  };
}

export async function recordPlatformAudit(input: {
  actorUserId: number | null;
  permission: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  requestId: string;
  result: "SUCCEEDED" | "REFUSED" | "FAILED";
  reason?: string | null;
  beforeFingerprint?: string | null;
  afterFingerprint?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(platformAuditEventsTable).values({
    actorUserId: input.actorUserId,
    permission: input.permission.slice(0, 160),
    action: input.action.slice(0, 160),
    targetType: input.targetType.slice(0, 120),
    targetId: input.targetId?.slice(0, 200) ?? null,
    requestId: input.requestId.slice(0, 200),
    result: input.result,
    reason: input.reason?.slice(0, 500) ?? null,
    beforeFingerprint: input.beforeFingerprint ?? null,
    afterFingerprint: input.afterFingerprint ?? null,
    metadata: (redactPlatformAuditMetadata(input.metadata ?? {}) ?? {}) as Record<
      string,
      unknown
    >,
  });
}

export function requestId(req: Request): string {
  const id = req.id;
  return id === undefined || id === null
    ? `admin-${Date.now()}-${randomBytes(8).toString("hex")}`
    : String(id);
}

export function auditFailureBestEffort(
  input: Parameters<typeof recordPlatformAudit>[0],
): void {
  void recordPlatformAudit(input).catch((error) => {
    logger.error(
      { error, action: input.action, requestId: input.requestId },
      "PLATFORM_AUDIT_WRITE_FAILED",
    );
  });
}
