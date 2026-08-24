import { sql } from "drizzle-orm";
import {
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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const TRADING_MANDATE_STATES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
  "EXPIRED",
  "REPLACED",
  "RETIRED",
] as const;

export type TradingMandateState = (typeof TRADING_MANDATE_STATES)[number];

/** Immutable Phase 12 authority terms. No runtime role may update or delete. */
export const tradingMandatesTable = pgTable(
  "trading_mandates",
  {
    id: serial("id").primaryKey(),
    mandateKey: text("mandate_key").notNull(),
    revision: integer("revision").notNull(),
    replacesMandateId: integer("replaces_mandate_id"),
    userId: integer("user_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    section: text("section").notNull(),
    brainVersionId: integer("brain_version_id").notNull(),
    brainVersion: text("brain_version").notNull(),
    brainFingerprint: text("brain_fingerprint").notNull(),
    accountIds: jsonb("account_ids").notNull(),
    exchanges: jsonb("exchanges").notNull(),
    markets: jsonb("markets").notNull(),
    symbols: jsonb("symbols").notNull(),
    strategies: jsonb("strategies").notNull(),
    models: jsonb("models").notNull(),
    settlementCurrency: text("settlement_currency").notNull(),
    monetaryScale: integer("monetary_scale").notNull().default(8),
    maximumPerTradeRisk: numeric("maximum_per_trade_risk", {
      precision: 38,
      scale: 0,
    }).notNull(),
    maximumPositionNotional: numeric("maximum_position_notional", {
      precision: 38,
      scale: 0,
    }).notNull(),
    maximumAggregateExposure: numeric("maximum_aggregate_exposure", {
      precision: 38,
      scale: 0,
    }).notNull(),
    maximumLeverageBps: integer("maximum_leverage_bps").notNull(),
    maximumConcurrentPositions: integer(
      "maximum_concurrent_positions",
    ).notNull(),
    maximumConcurrentOrders: integer("maximum_concurrent_orders").notNull(),
    dailyLossLimit: numeric("daily_loss_limit", {
      precision: 38,
      scale: 0,
    }).notNull(),
    weeklyLossLimit: numeric("weekly_loss_limit", {
      precision: 38,
      scale: 0,
    }).notNull(),
    monthlyLossLimit: numeric("monthly_loss_limit", {
      precision: 38,
      scale: 0,
    }).notNull(),
    maximumDrawdownBps: integer("maximum_drawdown_bps").notNull(),
    tradingHours: jsonb("trading_hours").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    canaryAllocation: numeric("canary_allocation", {
      precision: 38,
      scale: 0,
    }).notNull(),
    automaticSuspension: jsonb("automatic_suspension").notNull(),
    fallbackPolicy: text("fallback_policy").notNull(),
    fingerprint: text("fingerprint").notNull(),
    changeReason: text("change_reason").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    createdByUserId: integer("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("trading_mandates_key_revision_unique").on(
      t.userId,
      t.section,
      t.mandateKey,
      t.revision,
    ),
    unique("trading_mandates_fingerprint_unique").on(
      t.userId,
      t.section,
      t.fingerprint,
    ),
    unique("trading_mandates_request_unique").on(t.userId, t.clientRequestId),
    index("trading_mandates_scope_time_idx").on(
      t.userId,
      t.section,
      t.expiresAt,
    ),
    check(
      "trading_mandates_section_check",
      sql`${t.section} IN ('crypto','forex')`,
    ),
    check(
      "trading_mandates_currency_check",
      sql`${t.settlementCurrency} IN ('USD','USDT')`,
    ),
    check("trading_mandates_scale_check", sql`${t.monetaryScale} = 8`),
    check(
      "trading_mandates_time_check",
      sql`${t.expiresAt} > ${t.effectiveAt} AND ${t.expiresAt} <= ${t.effectiveAt} + INTERVAL '30 days'`,
    ),
    check(
      "trading_mandates_positive_limits_check",
      sql`${t.revision} >= 1 AND ${t.maximumPerTradeRisk} > 0 AND ${t.maximumPositionNotional} > 0 AND ${t.maximumAggregateExposure} > 0 AND ${t.maximumLeverageBps} BETWEEN 10000 AND 1250000 AND ${t.maximumConcurrentPositions} >= 1 AND ${t.maximumConcurrentOrders} >= 1 AND ${t.dailyLossLimit} > 0 AND ${t.weeklyLossLimit} > 0 AND ${t.monthlyLossLimit} > 0 AND ${t.maximumDrawdownBps} BETWEEN 1 AND 10000 AND ${t.canaryAllocation} > 0 AND ${t.canaryAllocation} <= ${t.maximumAggregateExposure}`,
    ),
    check(
      "trading_mandates_fallback_check",
      sql`${t.fallbackPolicy} IN ('COPILOT_VALID_ONLY','ABSTAIN')`,
    ),
  ],
);

/** Mutable lifecycle projection. Terms and authorization evidence stay immutable. */
export const tradingMandateStatesTable = pgTable(
  "trading_mandate_states",
  {
    id: serial("id").primaryKey(),
    mandateId: integer("mandate_id").notNull(),
    userId: integer("user_id").notNull(),
    section: text("section").notNull(),
    state: text("state").notNull().default("DRAFT"),
    lifecycleVersion: integer("lifecycle_version").notNull().default(1),
    reasonCode: text("reason_code").notNull().default("MANDATE_CREATED"),
    reason: text("reason").notNull(),
    approvingHumanId: integer("approving_human_id"),
    authorizationMethod: text("authorization_method"),
    authorizationId: text("authorization_id"),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("trading_mandate_states_mandate_unique").on(t.mandateId),
    unique("trading_mandate_states_authorization_unique").on(t.authorizationId),
    uniqueIndex("trading_mandate_states_active_scope_unique")
      .on(t.userId, t.section)
      .where(sql`${t.state} = 'ACTIVE'`),
    index("trading_mandate_states_scope_idx").on(t.userId, t.section, t.state),
    check(
      "trading_mandate_states_state_check",
      sql`${t.state} IN ('DRAFT','PENDING_APPROVAL','ACTIVE','SUSPENDED','REVOKED','EXPIRED','REPLACED','RETIRED')`,
    ),
    check(
      "trading_mandate_states_auth_method_check",
      sql`${t.authorizationMethod} IS NULL OR ${t.authorizationMethod} IN ('PASSWORD_STEP_UP','BASIC_REAUTH')`,
    ),
  ],
);

/** Append-only lifecycle and suspension audit. */
export const tradingMandateEventsTable = pgTable(
  "trading_mandate_events",
  {
    id: serial("id").primaryKey(),
    eventKey: text("event_key").notNull(),
    mandateId: integer("mandate_id").notNull(),
    userId: integer("user_id").notNull(),
    section: text("section").notNull(),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    actorUserId: integer("actor_user_id"),
    fromState: text("from_state"),
    toState: text("to_state"),
    reasonCode: text("reason_code").notNull(),
    reason: text("reason").notNull(),
    fingerprint: text("fingerprint"),
    payload: jsonb("payload"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("trading_mandate_events_key_unique").on(t.eventKey),
    index("trading_mandate_events_scope_time_idx").on(
      t.userId,
      t.section,
      t.occurredAt,
    ),
  ],
);

/** Append-only step-up authorization evidence, bound to the exact fingerprint. */
export const tradingMandateAuthorizationsTable = pgTable(
  "trading_mandate_authorizations",
  {
    id: serial("id").primaryKey(),
    authorizationId: text("authorization_id").notNull(),
    mandateId: integer("mandate_id").notNull(),
    userId: integer("user_id").notNull(),
    section: text("section").notNull(),
    mandateFingerprint: text("mandate_fingerprint").notNull(),
    approvingHumanId: integer("approving_human_id").notNull(),
    authorizationMethod: text("authorization_method").notNull(),
    sessionVersion: integer("session_version").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    reason: text("reason").notNull(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("trading_mandate_authorizations_id_unique").on(t.authorizationId),
    unique("trading_mandate_authorizations_request_unique").on(
      t.userId,
      t.clientRequestId,
    ),
    index("trading_mandate_authorizations_mandate_idx").on(t.mandateId),
  ],
);

/** Restart-safe server-authoritative usage projection, locked during a claim. */
export const tradingMandateUsageTable = pgTable(
  "trading_mandate_usage",
  {
    id: serial("id").primaryKey(),
    mandateId: integer("mandate_id").notNull(),
    userId: integer("user_id").notNull(),
    section: text("section").notNull(),
    aggregateExposure: numeric("aggregate_exposure", {
      precision: 38,
      scale: 0,
    }),
    canaryUsed: numeric("canary_used", { precision: 38, scale: 0 }),
    dailyLoss: numeric("daily_loss", { precision: 38, scale: 0 }),
    weeklyLoss: numeric("weekly_loss", { precision: 38, scale: 0 }),
    monthlyLoss: numeric("monthly_loss", { precision: 38, scale: 0 }),
    drawdownBps: integer("drawdown_bps"),
    openPositionCount: integer("open_position_count"),
    openOrderCount: integer("open_order_count"),
    lastDecisionAt: timestamp("last_decision_at", { withTimezone: true }),
    decisionsLastHour: integer("decisions_last_hour").notNull().default(0),
    entriesLastHour: integer("entries_last_hour").notNull().default(0),
    status: text("status").notNull().default("UNAVAILABLE"),
    staleReasons: jsonb("stale_reasons")
      .notNull()
      .default(sql`'[]'::jsonb`),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("trading_mandate_usage_mandate_unique").on(t.mandateId),
    index("trading_mandate_usage_scope_idx").on(t.userId, t.section),
    check(
      "trading_mandate_usage_status_check",
      sql`${t.status} IN ('CURRENT','STALE','UNAVAILABLE')`,
    ),
  ],
);

/** One durable claim for each mandate-bound autonomous Live decision. */
export const tradingMandateDecisionClaimsTable = pgTable(
  "trading_mandate_decision_claims",
  {
    id: serial("id").primaryKey(),
    mandateId: integer("mandate_id").notNull(),
    mandateRevision: integer("mandate_revision").notNull(),
    mandateFingerprint: text("mandate_fingerprint").notNull(),
    userId: integer("user_id").notNull(),
    section: text("section").notNull(),
    decisionId: text("decision_id").notNull(),
    decisionFingerprint: text("decision_fingerprint").notNull(),
    riskDecisionId: text("risk_decision_id").notNull(),
    riskFingerprint: text("risk_fingerprint").notNull(),
    planFingerprint: text("plan_fingerprint").notNull(),
    configurationFingerprint: text("configuration_fingerprint").notNull(),
    ownershipGeneration: integer("ownership_generation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    reservedRisk: numeric("reserved_risk", { precision: 38, scale: 0 }),
    reservedNotional: numeric("reserved_notional", {
      precision: 38,
      scale: 0,
    }),
    spreadBps: integer("spread_bps"),
    expectedSlippageBps: integer("expected_slippage_bps"),
    realizedSlippageBps: integer("realized_slippage_bps"),
    fillLatencyMs: integer("fill_latency_ms"),
    liveDemoDivergenceBps: integer("live_demo_divergence_bps"),
    status: text("status").notNull().default("CLAIMED"),
    reasonCode: text("reason_code").notNull(),
    reason: text("reason").notNull(),
    executionIntentId: integer("execution_intent_id"),
    brokerCommandId: text("broker_command_id"),
    brokerOrderId: text("broker_order_id"),
    tradeId: integer("trade_id"),
    fillId: text("fill_id"),
    suspensionEventId: integer("suspension_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("trading_mandate_claims_decision_unique").on(
      t.mandateId,
      t.decisionFingerprint,
    ),
    unique("trading_mandate_claims_idempotency_unique").on(t.idempotencyKey),
    index("trading_mandate_claims_scope_status_idx").on(
      t.userId,
      t.section,
      t.status,
      t.createdAt,
    ),
    check(
      "trading_mandate_claims_status_check",
      sql`${t.status} IN ('CLAIMED','BOUNDARY_AUTHORIZED','EXECUTED','REFUSED','FAILED','OUTCOME_UNKNOWN')`,
    ),
    check(
      "trading_mandate_claims_reservation_check",
      sql`${t.status} = 'REFUSED' OR (${t.reservedRisk} > 0 AND ${t.reservedNotional} > 0)`,
    ),
  ],
);

export const insertTradingMandateSchema = createInsertSchema(
  tradingMandatesTable,
).omit({ id: true, createdAt: true });
export const insertTradingMandateStateSchema = createInsertSchema(
  tradingMandateStatesTable,
).omit({ id: true, updatedAt: true });
export const insertTradingMandateEventSchema = createInsertSchema(
  tradingMandateEventsTable,
).omit({ id: true, occurredAt: true });

export type TradingMandateRecord = typeof tradingMandatesTable.$inferSelect;
export type TradingMandateStateRecord =
  typeof tradingMandateStatesTable.$inferSelect;
export type TradingMandateEventRecord =
  typeof tradingMandateEventsTable.$inferSelect;
export type TradingMandateAuthorizationRecord =
  typeof tradingMandateAuthorizationsTable.$inferSelect;
export type TradingMandateUsageRecord =
  typeof tradingMandateUsageTable.$inferSelect;
export type TradingMandateDecisionClaimRecord =
  typeof tradingMandateDecisionClaimsTable.$inferSelect;
export type InsertTradingMandate = z.infer<typeof insertTradingMandateSchema>;
export type InsertTradingMandateState = z.infer<
  typeof insertTradingMandateStateSchema
>;
export type InsertTradingMandateEvent = z.infer<
  typeof insertTradingMandateEventSchema
>;
