import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { captureSchema } from "./capture";

/**
 * Immutable point-in-time evidence snapshots. The capture schema is append-only
 * in production, so a later recomputation cannot rewrite what a user reviewed.
 */
export const evidenceSnapshotsTable = captureSchema.table("evidence_snapshots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull().default("crypto"),
  snapshotVersion: text("snapshot_version").notNull(),
  fingerprint: text("fingerprint").notNull(),
  executionTarget: text("execution_target").notNull(),
  dataCutoff: timestamp("data_cutoff", { withTimezone: true }).notNull(),
  totalOutcomes: integer("total_outcomes").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("capture_evidence_snapshots_version_uq").on(
    table.userId, table.section, table.snapshotVersion,
  ),
  index("capture_evidence_snapshots_cutoff_idx").on(table.userId, table.section, table.dataCutoff),
]);

/**
 * Mutable lifecycle projection for one validated rule version. Statistical
 * validation creates a Shadow row; only an explicit user action may set ACTIVE.
 */
export const evidenceRuleSetsTable = pgTable("evidence_rule_sets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull().default("crypto"),
  ruleVersion: text("rule_version").notNull(),
  validationId: integer("validation_id").notNull(),
  status: text("status").notNull().default("shadow"),
  executionTarget: text("execution_target").notNull(),
  permits: text("permits").notNull().default("withhold"),
  state: jsonb("state").notNull(),
  validation: jsonb("validation").notNull(),
  driftStatus: text("drift_status").notNull().default("insufficient_data"),
  dataCutoff: timestamp("data_cutoff", { withTimezone: true }).notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("evidence_rule_sets_version_uq").on(table.userId, table.section, table.ruleVersion),
  index("evidence_rule_sets_status_idx").on(table.userId, table.section, table.status),
]);

/** Append-only audit event for every lifecycle transition and refused action. */
export const evidenceRuleEventsTable = captureSchema.table("evidence_rule_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull().default("crypto"),
  ruleVersion: text("rule_version").notNull(),
  event: text("event").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  actor: text("actor").notNull().default("user"),
  reason: text("reason").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("capture_evidence_rule_events_version_idx").on(table.userId, table.section, table.ruleVersion),
  index("capture_evidence_rule_events_time_idx").on(table.userId, table.createdAt),
]);

export const insertEvidenceSnapshotSchema = createInsertSchema(evidenceSnapshotsTable).omit({ id: true, createdAt: true });
export const insertEvidenceRuleSetSchema = createInsertSchema(evidenceRuleSetsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertEvidenceRuleEventSchema = createInsertSchema(evidenceRuleEventsTable).omit({ id: true, createdAt: true });
export type EvidenceSnapshotRow = typeof evidenceSnapshotsTable.$inferSelect;
export type EvidenceRuleSetRow = typeof evidenceRuleSetsTable.$inferSelect;
export type EvidenceRuleEventRow = typeof evidenceRuleEventsTable.$inferSelect;
export type InsertEvidenceSnapshot = z.infer<typeof insertEvidenceSnapshotSchema>;
export type InsertEvidenceRuleSet = z.infer<typeof insertEvidenceRuleSetSchema>;
export type InsertEvidenceRuleEvent = z.infer<typeof insertEvidenceRuleEventSchema>;
