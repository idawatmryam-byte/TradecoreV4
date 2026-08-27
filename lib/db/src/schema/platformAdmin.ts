import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/** Platform roles never imply tenant financial authority. */
export const platformRoleAssignmentsTable = pgTable(
  "platform_role_assignments",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    /** Null only for an audited out-of-band bootstrap. */
    grantedByUserId: integer("granted_by_user_id"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("platform_role_assignments_user_role_unique").on(
      table.userId,
      table.role,
    ),
    check(
      "platform_role_assignments_role_check",
      sql`${table.role} IN ('PLATFORM_ADMIN','OPERATIONS_RISK','SUPPORT','AUDITOR')`,
    ),
    check(
      "platform_role_assignments_status_check",
      sql`${table.status} IN ('ACTIVE','REVOKED')`,
    ),
    check(
      "platform_role_assignments_reason_length_check",
      sql`char_length(${table.reason}) BETWEEN 8 AND 500`,
    ),
  ],
);

/** Incremented on every role change; active admin step-up cookies carry it. */
export const platformAccessVersionsTable = pgTable(
  "platform_access_versions",
  {
    userId: integer("user_id").primaryKey(),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "platform_access_versions_positive_check",
      sql`${table.version} >= 1`,
    ),
  ],
);

/**
 * Append-only operator evidence. Secret values and request bodies do not
 * belong here; before/after values are redacted fingerprints only.
 */
export const platformAuditEventsTable = pgTable(
  "platform_audit_events",
  {
    id: serial("id").primaryKey(),
    actorUserId: integer("actor_user_id"),
    permission: text("permission").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    requestId: text("request_id").notNull(),
    result: text("result").notNull(),
    reason: text("reason"),
    beforeFingerprint: text("before_fingerprint"),
    afterFingerprint: text("after_fingerprint"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "platform_audit_events_result_check",
      sql`${table.result} IN ('SUCCEEDED','REFUSED','FAILED')`,
    ),
  ],
);

export type PlatformRoleAssignment =
  typeof platformRoleAssignmentsTable.$inferSelect;
export type PlatformAuditEvent = typeof platformAuditEventsTable.$inferSelect;
