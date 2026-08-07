import { serial, text, integer, timestamp, index, jsonb, unique, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { captureSchema } from "./capture";

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

export const insertStrategyOpinionSchema = createInsertSchema(strategyOpinionsTable).omit({ id: true, createdAt: true });
export const insertBrainDecisionSchema = createInsertSchema(brainDecisionsTable).omit({ id: true, createdAt: true });
export const insertBrainEvidenceReferenceSchema = createInsertSchema(brainEvidenceReferencesTable).omit({ id: true, createdAt: true });
export const insertShadowCouncilRunSchema = createInsertSchema(shadowCouncilRunsTable).omit({ id: true, createdAt: true });

export type InsertStrategyOpinion = z.infer<typeof insertStrategyOpinionSchema>;
export type StrategyOpinionRecord = typeof strategyOpinionsTable.$inferSelect;
export type InsertBrainDecision = z.infer<typeof insertBrainDecisionSchema>;
export type BrainDecisionRecord = typeof brainDecisionsTable.$inferSelect;
export type InsertBrainEvidenceReference = z.infer<typeof insertBrainEvidenceReferenceSchema>;
export type BrainEvidenceReferenceRecord = typeof brainEvidenceReferencesTable.$inferSelect;
export type InsertShadowCouncilRun = z.infer<typeof insertShadowCouncilRunSchema>;
export type ShadowCouncilRunRecord = typeof shadowCouncilRunsTable.$inferSelect;

