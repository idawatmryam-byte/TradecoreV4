import { serial, text, integer, timestamp, index, jsonb, unique, numeric, boolean, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { captureSchema } from "./capture";
import { tradesTable } from "./trades";

/**
 * Immutable unified-brain decisions. Identity is tenant-scoped because two
 * users can legitimately receive the same deterministic public-market result.
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
  unique("capture_brain_decisions_tenant_decision_unique").on(table.userId, table.section, table.decisionId),
  unique("capture_brain_decisions_tenant_fingerprint_unique").on(table.userId, table.section, table.decisionFingerprint),
  index("capture_brain_decisions_user_time_idx").on(table.userId, table.section, table.dataTimestamp),
  index("capture_brain_decisions_symbol_time_idx").on(table.symbol, table.dataTimestamp),
  index("capture_brain_decisions_market_state_idx").on(table.marketStateFingerprint),
]);

/** Evidence references remain deduplicated and append-only. */
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

/**
 * Every eligible specialist opinion, including abstentions. Public-market
 * fingerprints may repeat across accounts, so deterministic IDs are scoped by
 * tenant rather than globally unique.
 */
export const strategyOpinionsTable = captureSchema.table("strategy_opinions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull().default("crypto"),
  opinionId: text("opinion_id").notNull(),
  specialistId: text("specialist_id").notNull(),
  specialistVersion: text("specialist_version").notNull(),
  role: text("role").notNull(),
  correlationGroup: text("correlation_group").notNull(),
  correlationDiscount: numeric("correlation_discount", { precision: 8, scale: 6 }).notNull(),
  effectiveStrength: numeric("effective_strength", { precision: 8, scale: 6 }).notNull(),
  symbol: text("symbol").notNull(),
  marketStateFingerprint: text("market_state_fingerprint").notNull(),
  stance: text("stance").notNull(),
  dataTimestamp: timestamp("data_timestamp", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  opinion: jsonb("opinion").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("capture_strategy_opinions_tenant_opinion_unique").on(table.userId, table.section, table.opinionId),
  index("capture_strategy_opinions_user_time_idx").on(table.userId, table.section, table.dataTimestamp),
  index("capture_strategy_opinions_specialist_time_idx").on(table.specialistId, table.dataTimestamp),
  index("capture_strategy_opinions_market_state_idx").on(table.marketStateFingerprint),
]);

/**
 * One append-only Shadow run per deterministic input. It records the control
 * comparison, optional provider accounting, and the immutable replay bundle.
 */
export const shadowCouncilRunsTable = captureSchema.table("shadow_council_runs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull().default("crypto"),
  runId: text("run_id").notNull(),
  brainDecisionId: integer("brain_decision_id").notNull().references(() => brainDecisionsTable.id),
  councilVersion: text("council_version").notNull(),
  inputFingerprint: text("input_fingerprint").notNull(),
  runFingerprint: text("run_fingerprint").notNull(),
  reasoningStatus: text("reasoning_status").notNull(),
  providerId: text("provider_id"),
  modelVersion: text("model_version"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: numeric("cost_usd", { precision: 18, scale: 8 }),
  deterministicAssessment: jsonb("deterministic_assessment").notNull(),
  brainV0Comparison: jsonb("brain_v0_comparison").notNull(),
  reasoning: jsonb("reasoning").notNull(),
  replayBundle: jsonb("replay_bundle").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("capture_shadow_council_tenant_run_unique").on(table.userId, table.section, table.runId),
  unique("capture_shadow_council_tenant_input_unique").on(table.userId, table.section, table.inputFingerprint),
  index("capture_shadow_council_user_time_idx").on(table.userId, table.section, table.generatedAt),
  index("capture_shadow_council_decision_idx").on(table.brainDecisionId),
  index("capture_shadow_council_run_fingerprint_idx").on(table.runFingerprint),
]);

/** One immutable, versioned thesis for each Phase 7 observed or managed position. */
export const positionThesesTable = captureSchema.table("position_theses", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull(),
  tradeId: integer("trade_id").notNull().references(() => tradesTable.id),
  thesisId: text("thesis_id").notNull(),
  schemaVersion: text("schema_version").notNull(),
  policyVersion: text("policy_version").notNull(),
  thesisFingerprint: text("thesis_fingerprint").notNull(),
  thesis: jsonb("thesis").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("capture_position_theses_trade_unique").on(table.tradeId),
  unique("capture_position_theses_tenant_thesis_unique").on(table.userId, table.section, table.thesisId),
  unique("capture_position_theses_tenant_fingerprint_unique").on(table.userId, table.section, table.thesisFingerprint),
  index("capture_position_theses_user_time_idx").on(table.userId, table.section, table.createdAt),
]);

/**
 * Append-only Phase 7 action ledger. A PROPOSED row is written before any
 * mutation. APPLIED/FAILED/SHADOW rows then record the result without
 * rewriting history. The stage uniqueness constraint makes retries
 * idempotent and ambiguous pre-action crashes fail closed.
 */
export const positionManagementEventsTable = captureSchema.table("position_management_events", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull(),
  tradeId: integer("trade_id").notNull().references(() => tradesTable.id),
  thesisId: text("thesis_id").notNull(),
  actionFingerprint: text("action_fingerprint").notNull(),
  stage: text("stage").notNull(), // PROPOSED | SHADOW | APPLIED | FAILED | REFUSED
  thesisState: text("thesis_state").notNull(),
  actionType: text("action_type").notNull(),
  policyVersion: text("policy_version").notNull(),
  marketStateFingerprint: text("market_state_fingerprint"),
  validationPassed: boolean("validation_passed").notNull(),
  evaluation: jsonb("evaluation").notNull(),
  action: jsonb("action").notNull(),
  validation: jsonb("validation").notNull(),
  result: jsonb("result"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("capture_position_management_event_id_unique").on(table.eventId),
  unique("capture_position_management_action_stage_unique").on(table.tradeId, table.actionFingerprint, table.stage),
  index("capture_position_management_trade_time_idx").on(table.tradeId, table.createdAt),
  index("capture_position_management_user_time_idx").on(table.userId, table.section, table.createdAt),
  index("capture_position_management_market_state_idx").on(table.marketStateFingerprint),
  check("capture_position_management_stage_check", sql`${table.stage} IN ('PROPOSED', 'SHADOW', 'APPLIED', 'FAILED', 'REFUSED')`),
  check("capture_position_management_state_check", sql`${table.thesisState} IN ('VALID', 'WEAKENING', 'INVALIDATED', 'TARGET_DEGRADED', 'DATA_UNCERTAIN')`),
  check("capture_position_management_action_check", sql`${table.actionType} IN ('HOLD', 'REDUCE', 'TIGHTEN_STOP', 'APPLY_TRAILING', 'EXIT', 'FREEZE')`),
]);

export const insertStrategyOpinionSchema = createInsertSchema(strategyOpinionsTable).omit({ id: true, createdAt: true });
export const insertBrainDecisionSchema = createInsertSchema(brainDecisionsTable).omit({ id: true, createdAt: true });
export const insertBrainEvidenceReferenceSchema = createInsertSchema(brainEvidenceReferencesTable).omit({ id: true, createdAt: true });
export const insertShadowCouncilRunSchema = createInsertSchema(shadowCouncilRunsTable).omit({ id: true, createdAt: true });
export const insertPositionThesisSchema = createInsertSchema(positionThesesTable).omit({ id: true, createdAt: true });
export const insertPositionManagementEventSchema = createInsertSchema(positionManagementEventsTable).omit({ id: true, createdAt: true });

export type InsertStrategyOpinion = z.infer<typeof insertStrategyOpinionSchema>;
export type StrategyOpinionRecord = typeof strategyOpinionsTable.$inferSelect;
export type InsertBrainDecision = z.infer<typeof insertBrainDecisionSchema>;
export type BrainDecisionRecord = typeof brainDecisionsTable.$inferSelect;
export type InsertBrainEvidenceReference = z.infer<typeof insertBrainEvidenceReferenceSchema>;
export type BrainEvidenceReferenceRecord = typeof brainEvidenceReferencesTable.$inferSelect;
export type InsertShadowCouncilRun = z.infer<typeof insertShadowCouncilRunSchema>;
export type ShadowCouncilRunRecord = typeof shadowCouncilRunsTable.$inferSelect;
export type InsertPositionThesis = z.infer<typeof insertPositionThesisSchema>;
export type PositionThesisRecord = typeof positionThesesTable.$inferSelect;
export type InsertPositionManagementEvent = z.infer<typeof insertPositionManagementEventSchema>;
export type PositionManagementEventRecord = typeof positionManagementEventsTable.$inferSelect;

