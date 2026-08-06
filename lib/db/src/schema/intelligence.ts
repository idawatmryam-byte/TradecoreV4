import { serial, text, integer, timestamp, index, jsonb, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { captureSchema } from "./capture";

/**
 * Immutable unified-brain decisions. This is intentionally separate from the
 * mutable strategy_decisions UI feed: capture grants permit INSERT + SELECT
 * only, preserving every decision and version for replay.
 */
export const brainDecisionsTable = captureSchema.table("brain_decisions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull().default("crypto"),
  decisionId: text("decision_id").notNull(),
  schemaVersion: text("schema_version").notNull(),
  brainVersion: text("brain_version").notNull(),
  action: text("action").notNull(),
  symbol: text("symbol").notNull(),
  marketStateFingerprint: text("market_state_fingerprint").notNull(),
  decisionFingerprint: text("decision_fingerprint").notNull(),
  dataTimestamp: timestamp("data_timestamp", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  decision: jsonb("decision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("capture_brain_decisions_decision_id_unique").on(table.decisionId),
  unique("capture_brain_decisions_fingerprint_unique").on(table.decisionFingerprint),
  index("capture_brain_decisions_user_time_idx").on(table.userId, table.dataTimestamp),
  index("capture_brain_decisions_symbol_time_idx").on(table.symbol, table.dataTimestamp),
  index("capture_brain_decisions_market_state_idx").on(table.marketStateFingerprint),
]);

/**
 * Evidence stays reference-based so large market snapshots are not duplicated.
 * The evidence fingerprint can resolve to feature_snapshots, promoted memory,
 * or an external immutable research artifact.
 */
export const brainEvidenceReferencesTable = captureSchema.table("brain_evidence_references", {
  id: serial("id").primaryKey(),
  brainDecisionId: integer("brain_decision_id").notNull().references(() => brainDecisionsTable.id),
  evidenceId: text("evidence_id").notNull(),
  kind: text("kind").notNull(),
  source: text("source").notNull(),
  reference: text("reference").notNull(),
  evidenceFingerprint: text("evidence_fingerprint"),
  dataTimestamp: timestamp("data_timestamp", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("capture_brain_evidence_decision_evidence_unique").on(table.brainDecisionId, table.evidenceId),
  index("capture_brain_evidence_fingerprint_idx").on(table.evidenceFingerprint),
  index("capture_brain_evidence_decision_idx").on(table.brainDecisionId),
]);

export const insertBrainDecisionSchema = createInsertSchema(brainDecisionsTable).omit({ id: true, createdAt: true });
export const insertBrainEvidenceReferenceSchema = createInsertSchema(brainEvidenceReferencesTable).omit({ id: true, createdAt: true });
export type InsertBrainDecision = z.infer<typeof insertBrainDecisionSchema>;
export type BrainDecisionRecord = typeof brainDecisionsTable.$inferSelect;
export type InsertBrainEvidenceReference = z.infer<typeof insertBrainEvidenceReferenceSchema>;
export type BrainEvidenceReferenceRecord = typeof brainEvidenceReferencesTable.$inferSelect;
