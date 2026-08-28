export const PLATFORM_ROLES = [
  "PLATFORM_ADMIN",
  "OPERATIONS_RISK",
  "SUPPORT",
  "AUDITOR",
] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_PERMISSIONS = [
  "admin.overview.read",
  "admin.health.read",
  "admin.ai.read",
  "admin.execution.read",
  "admin.risk.read",
  "admin.risk.suspend",
  "admin.risk.resume.request",
  "admin.risk.resume.approve",
  "admin.users.read",
  "admin.audit.read",
  "admin.configuration.read",
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  PLATFORM_ADMIN: PLATFORM_PERMISSIONS,
  OPERATIONS_RISK: [
    "admin.overview.read",
    "admin.health.read",
    "admin.ai.read",
    "admin.execution.read",
    "admin.risk.read",
    "admin.risk.suspend",
    "admin.risk.resume.request",
    "admin.risk.resume.approve",
    "admin.audit.read",
  ],
  SUPPORT: ["admin.overview.read", "admin.users.read"],
  AUDITOR: [
    "admin.overview.read",
    "admin.health.read",
    "admin.ai.read",
    "admin.execution.read",
    "admin.risk.read",
    "admin.audit.read",
    "admin.configuration.read",
  ],
};

export function permissionsForRoles(
  roles: readonly PlatformRole[],
): PlatformPermission[] {
  return [...new Set(roles.flatMap((role) => ROLE_PERMISSIONS[role]))];
}

export function redactPlatformAuditMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactPlatformAuditMetadata).slice(0, 100);
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return value.slice(0, 500);
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, child]) => [
        key,
        /(password|secret|token|credential|cookie|authorization|api.?key)/i.test(key)
          ? "[REDACTED_SECRET]"
          : redactPlatformAuditMetadata(child),
      ]),
  );
}
