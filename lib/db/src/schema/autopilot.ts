import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const BRAIN_VERSION_STATES = [
  "DRAFT",
  "RESEARCH",
  "SHADOW",
  "COPILOT",
  "DEMO_APPROVED",
  "LIVE_RESTRICTED",
  "SUSPENDED",
  "RETIRED",
] as const;
export type BrainVersionState = (typeof BRAIN_VERSION_STATES)[number];

export const AUTOPILOT_STATES = [
  "AUTOPILOT_ENABLED",
  "AUTOPILOT_PAUSED",
  "AUTOPILOT_BLOCKED",
] as const;
export type AutopilotState = (typeof AUTOPILOT_STATES)[number];

/**
 * Per-tenant registry projection. A lifecycle transition changes only `state`;
 * the implementation identity and fingerprint remain immutable.
 */
export const brainVersionsTable = pgTable("brain_versions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull(),
  version: text("version").notNull(),
  implementation: text("implementation").notNull(),
  state: text("state").notNull().default("DRAFT"),
  fingerprint: text("fingerprint").notNull(),
  sourceCommit: text("source_commit").notNull(),
  evidenceReferences: jsonb("evidence_references").notNull().default(sql`'[]'::jsonb`),
  createdByUserId: integer("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("brain_versions_user_section_version_unique").on(t.userId, t.section, t.version),
  unique("brain_versions_user_section_fingerprint_unique").on(t.userId, t.section, t.fingerprint),
  index("brain_versions_user_state_idx").on(t.userId, t.section, t.state),
  check("brain_versions_state_check", sql`${t.state} IN ('DRAFT','RESEARCH','SHADOW','COPILOT','DEMO_APPROVED','LIVE_RESTRICTED','SUSPENDED','RETIRED')`),
]);

/** Immutable mandate content. Changes create a new version and fingerprint. */
export const demoMandatesTable = pgTable("demo_autopilot_mandates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull(),
  version: integer("version").notNull(),
  botConfigId: integer("bot_config_id").notNull(),
  configFingerprint: text("config_fingerprint").notNull(),
  brainVersionId: integer("brain_version_id").notNull(),
  brainVersion: text("brain_version").notNull(),
  executionAuthority: text("execution_authority").notNull(),
  marketType: text("market_type").notNull(),
  instruments: jsonb("instruments").notNull(),
  strategyVersions: jsonb("strategy_versions").notNull(),
  maximumPositionSizeUsdt: numeric("maximum_position_size_usdt", { precision: 18, scale: 8 }).notNull(),
  maximumLeverage: integer("maximum_leverage").notNull(),
  maximumPortfolioRiskPercent: numeric("maximum_portfolio_risk_percent", { precision: 8, scale: 4 }).notNull(),
  maximumSymbolExposurePercent: numeric("maximum_symbol_exposure_percent", { precision: 8, scale: 4 }).notNull(),
  maximumNetExposurePercent: numeric("maximum_net_exposure_percent", { precision: 8, scale: 4 }).notNull(),
  maximumCorrelatedExposurePercent: numeric("maximum_correlated_exposure_percent", { precision: 8, scale: 4 }).notNull(),
  dailyLossLimitUsdt: numeric("daily_loss_limit_usdt", { precision: 18, scale: 8 }).notNull(),
  maximumDrawdownPercent: numeric("maximum_drawdown_percent", { precision: 8, scale: 4 }).notNull(),
  maximumConcurrentPositions: integer("maximum_concurrent_positions").notNull(),
  maximumMarketDataAgeSeconds: integer("maximum_market_data_age_seconds").notNull(),
  allowedTradingHoursUtc: jsonb("allowed_trading_hours_utc").notNull(),
  permittedPhase7Actions: jsonb("permitted_phase7_actions").notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  fingerprint: text("fingerprint").notNull(),
  createdByUserId: integer("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("demo_autopilot_mandates_user_section_version_unique").on(t.userId, t.section, t.version),
  unique("demo_autopilot_mandates_user_section_fingerprint_unique").on(t.userId, t.section, t.fingerprint),
  index("demo_autopilot_mandates_user_time_idx").on(t.userId, t.section, t.expiresAt),
  check("demo_autopilot_mandates_authority_check", sql`${t.executionAuthority} IN ('simulated_demo','binance_spot_testnet','binance_futures_demo','oanda_practice')`),
  check("demo_autopilot_mandates_market_check", sql`${t.marketType} IN ('spot','futures','forex')`),
  check("demo_autopilot_mandates_time_check", sql`${t.expiresAt} > ${t.validFrom}`),
  check("demo_autopilot_mandates_positive_limits_check", sql`${t.maximumPositionSizeUsdt} > 0 AND ${t.maximumLeverage} >= 1 AND ${t.maximumPortfolioRiskPercent} > 0 AND ${t.maximumSymbolExposurePercent} > 0 AND ${t.maximumNetExposurePercent} > 0 AND ${t.maximumCorrelatedExposurePercent} > 0 AND ${t.dailyLossLimitUsdt} > 0 AND ${t.maximumDrawdownPercent} > 0 AND ${t.maximumConcurrentPositions} >= 1 AND ${t.maximumMarketDataAgeSeconds} >= 1`),
]);

/** Mutable lifecycle projection kept separate from immutable mandate terms. */
export const autopilotMandateStatesTable = pgTable("autopilot_mandate_states", {
  id: serial("id").primaryKey(),
  mandateId: integer("mandate_id").notNull(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull(),
  state: text("state").notNull().default("INACTIVE"),
  reasonCode: text("reason_code").notNull().default("MANDATE_CREATED"),
  reason: text("reason").notNull().default("Mandate has not been activated"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("autopilot_mandate_states_mandate_unique").on(t.mandateId),
  index("autopilot_mandate_states_user_idx").on(t.userId, t.section, t.state),
  check("autopilot_mandate_states_state_check", sql`${t.state} IN ('INACTIVE','ACTIVE','SUSPENDED','REVOKED','EXPIRED')`),
]);

/** One current control projection per account configuration. */
export const autopilotControlsTable = pgTable("autopilot_controls", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull(),
  mandateId: integer("mandate_id"),
  state: text("state").notNull().default("AUTOPILOT_BLOCKED"),
  reasonCode: text("reason_code").notNull().default("MANDATE_MISSING"),
  reason: text("reason").notNull().default("No Demo Autopilot mandate is active"),
  globalSuspended: boolean("global_suspended").notNull().default(false),
  configSuspended: boolean("config_suspended").notNull().default(false),
  equityDay: text("equity_day"),
  dayStartEquityUsdt: numeric("day_start_equity_usdt", { precision: 18, scale: 8 }),
  highWaterEquityUsdt: numeric("high_water_equity_usdt", { precision: 18, scale: 8 }),
  lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("autopilot_controls_user_section_unique").on(t.userId, t.section),
  index("autopilot_controls_state_idx").on(t.state, t.updatedAt),
  check("autopilot_controls_state_check", sql`${t.state} IN ('AUTOPILOT_ENABLED','AUTOPILOT_PAUSED','AUTOPILOT_BLOCKED')`),
]);

/** Durable single claim for one autonomous decision under one mandate. */
export const autopilotDecisionClaimsTable = pgTable("autopilot_decision_claims", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull(),
  // Refusals that happen before a mandate can be resolved are still durable
  // claims, so this binding is intentionally nullable. Executable claims
  // always carry a mandate id and are checked again by the service layer.
  mandateId: integer("mandate_id"),
  mandateFingerprint: text("mandate_fingerprint").notNull(),
  brainVersion: text("brain_version").notNull(),
  decisionFingerprint: text("decision_fingerprint").notNull(),
  riskFingerprint: text("risk_fingerprint").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("CLAIMED"),
  executionIntentId: integer("execution_intent_id"),
  tradeId: integer("trade_id"),
  outcomeReason: text("outcome_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("autopilot_claims_decision_unique").on(t.userId, t.section, t.mandateFingerprint, t.decisionFingerprint),
  unique("autopilot_claims_idempotency_unique").on(t.idempotencyKey),
  index("autopilot_claims_user_status_idx").on(t.userId, t.section, t.status, t.createdAt),
  index("autopilot_claims_mandate_status_idx").on(t.userId, t.section, t.mandateId, t.status),
  check("autopilot_claims_status_check", sql`${t.status} IN ('CLAIMED','EXECUTED','REFUSED','FAILED')`),
]);

/** Append-only audit history for authority, decisions, and control changes. */
export const autopilotEventsTable = pgTable("autopilot_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull(),
  eventType: text("event_type").notNull(),
  actorType: text("actor_type").notNull(),
  actorUserId: integer("actor_user_id"),
  brainVersionId: integer("brain_version_id"),
  mandateId: integer("mandate_id"),
  decisionClaimId: integer("decision_claim_id"),
  fromState: text("from_state"),
  toState: text("to_state"),
  reasonCode: text("reason_code").notNull(),
  reason: text("reason").notNull(),
  fingerprint: text("fingerprint"),
  payload: jsonb("payload"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("autopilot_events_user_time_idx").on(t.userId, t.section, t.occurredAt),
  index("autopilot_events_mandate_idx").on(t.mandateId, t.occurredAt),
  index("autopilot_events_claim_idx").on(t.decisionClaimId, t.occurredAt),
]);

export const insertBrainVersionSchema = createInsertSchema(brainVersionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertDemoMandateSchema = createInsertSchema(demoMandatesTable).omit({ id: true, createdAt: true });
export const insertAutopilotMandateStateSchema = createInsertSchema(autopilotMandateStatesTable).omit({ id: true, updatedAt: true });
export const insertAutopilotControlSchema = createInsertSchema(autopilotControlsTable).omit({ id: true, updatedAt: true });
export const insertAutopilotDecisionClaimSchema = createInsertSchema(autopilotDecisionClaimsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAutopilotEventSchema = createInsertSchema(autopilotEventsTable).omit({ id: true, occurredAt: true });

export type BrainVersionRecord = typeof brainVersionsTable.$inferSelect;
export type DemoMandateRecord = typeof demoMandatesTable.$inferSelect;
export type AutopilotMandateStateRecord = typeof autopilotMandateStatesTable.$inferSelect;
export type AutopilotControlRecord = typeof autopilotControlsTable.$inferSelect;
export type AutopilotDecisionClaimRecord = typeof autopilotDecisionClaimsTable.$inferSelect;
export type AutopilotEventRecord = typeof autopilotEventsTable.$inferSelect;
export type InsertBrainVersion = z.infer<typeof insertBrainVersionSchema>;
export type InsertDemoMandate = z.infer<typeof insertDemoMandateSchema>;
export type InsertAutopilotMandateState = z.infer<typeof insertAutopilotMandateStateSchema>;
export type InsertAutopilotControl = z.infer<typeof insertAutopilotControlSchema>;
export type InsertAutopilotDecisionClaim = z.infer<typeof insertAutopilotDecisionClaimSchema>;
export type InsertAutopilotEvent = z.infer<typeof insertAutopilotEventSchema>;
