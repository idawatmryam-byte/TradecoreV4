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

/** Mutable tenant projection optimized for the synchronous pre-broker gate. */
export const liveExecutionStatesTable = pgTable(
  "live_execution_states",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    section: text("section").notNull(),
    operatingMode: text("operating_mode").notNull().default("NO_NEW_ENTRY"),
    operatingModeSource: text("operating_mode_source")
      .notNull()
      .default("SYSTEM"),
    reconciliationState: text("reconciliation_state")
      .notNull()
      .default("UNKNOWN"),
    protectionState: text("protection_state").notNull().default("UNKNOWN"),
    ownershipGeneration: integer("ownership_generation").notNull().default(0),
    ownerInstanceId: text("owner_instance_id"),
    ownerClaimedAt: timestamp("owner_claimed_at", { withTimezone: true }),
    entryBlockReason: text("entry_block_reason"),
    currentEquityMinor: numeric("current_equity_minor", {
      precision: 30,
      scale: 0,
    }),
    peakEquityMinor: numeric("peak_equity_minor", { precision: 30, scale: 0 }),
    equitySource: text("equity_source"),
    equityObservedAt: timestamp("equity_observed_at", { withTimezone: true }),
    equityFreshUntil: timestamp("equity_fresh_until", { withTimezone: true }),
    accountDrawdownState: text("account_drawdown_state")
      .notNull()
      .default("UNKNOWN"),
    accountDrawdownLimitBps: integer("account_drawdown_limit_bps")
      .notNull()
      .default(2000),
    globalDrawdownState: text("global_drawdown_state")
      .notNull()
      .default("UNKNOWN"),
    globalDrawdownLimitBps: integer("global_drawdown_limit_bps")
      .notNull()
      .default(2500),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    lastIncidentAt: timestamp("last_incident_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("live_execution_states_user_section_unique").on(t.userId, t.section),
    check(
      "live_execution_states_mode_check",
      sql`${t.operatingMode} IN ('NORMAL','NO_NEW_ENTRY','EXIT_ONLY','MAINTENANCE','PROTECTION_DEGRADED')`,
    ),
    check(
      "live_execution_states_mode_source_check",
      sql`${t.operatingModeSource} IN ('SYSTEM','OPERATOR')`,
    ),
    check(
      "live_execution_states_reconciliation_check",
      sql`${t.reconciliationState} IN ('HEALTHY','INCOMPLETE','UNKNOWN','ESCALATED')`,
    ),
    check(
      "live_execution_states_protection_check",
      sql`${t.protectionState} IN ('HEALTHY','DEGRADED','UNKNOWN')`,
    ),
    check(
      "live_execution_states_account_drawdown_check",
      sql`${t.accountDrawdownState} IN ('HEALTHY','BREACHED','UNKNOWN')`,
    ),
    check(
      "live_execution_states_global_drawdown_check",
      sql`${t.globalDrawdownState} IN ('HEALTHY','BREACHED','UNKNOWN')`,
    ),
    check(
      "live_execution_states_drawdown_limits_check",
      sql`${t.accountDrawdownLimitBps} BETWEEN 1 AND 10000 AND ${t.globalDrawdownLimitBps} BETWEEN 1 AND 10000`,
    ),
  ],
);

/** Platform aggregate of fresh account-equity snapshots. */
export const liveGlobalEquityStateTable = pgTable(
  "live_global_equity_state",
  {
    id: text("id").primaryKey().default("platform"),
    currentEquityMinor: numeric("current_equity_minor", {
      precision: 38,
      scale: 0,
    }),
    peakEquityMinor: numeric("peak_equity_minor", { precision: 38, scale: 0 }),
    sourceCount: integer("source_count").notNull().default(0),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    freshUntil: timestamp("fresh_until", { withTimezone: true }),
    drawdownState: text("drawdown_state").notNull().default("UNKNOWN"),
    drawdownLimitBps: integer("drawdown_limit_bps").notNull().default(2500),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      "live_global_equity_state_drawdown_check",
      sql`${t.drawdownState} IN ('HEALTHY','BREACHED','UNKNOWN')`,
    ),
    check(
      "live_global_equity_state_limit_check",
      sql`${t.drawdownLimitBps} BETWEEN 1 AND 10000`,
    ),
  ],
);

/**
 * Synchronously evaluated kill-switch projections. owner_user_id=0 and
 * section='*' are operator-owned platform scopes. User routes may only mutate
 * their own user/section rows.
 */
export const liveKillSwitchesTable = pgTable(
  "live_kill_switches",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id").notNull(),
    section: text("section").notNull().default("*"),
    scope: text("scope").notNull(),
    scopeKey: text("scope_key").notNull().default("*"),
    active: boolean("active").notNull().default(true),
    reason: text("reason").notNull(),
    activatedByUserId: integer("activated_by_user_id"),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    resumeRequestId: text("resume_request_id"),
    resumeRequestedByUserId: integer("resume_requested_by_user_id"),
    resumeRequestedAt: timestamp("resume_requested_at", { withTimezone: true }),
    resumeRequestExpiresAt: timestamp("resume_request_expires_at", {
      withTimezone: true,
    }),
    resumeRequestReason: text("resume_request_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("live_kill_switches_identity_unique").on(
      t.ownerUserId,
      t.section,
      t.scope,
      t.scopeKey,
    ),
    unique("live_kill_switches_resume_request_unique").on(t.resumeRequestId),
    index("live_kill_switches_active_idx").on(
      t.active,
      t.ownerUserId,
      t.section,
    ),
    check(
      "live_kill_switches_scope_check",
      sql`${t.scope} IN ('GLOBAL','EXCHANGE','MARKET','SYMBOL','STRATEGY_MODEL','USER','SECTION','AUTOPILOT')`,
    ),
    check(
      "live_kill_switches_resume_request_complete_check",
      sql`(
        ${t.resumeRequestId} IS NULL
        AND ${t.resumeRequestedByUserId} IS NULL
        AND ${t.resumeRequestedAt} IS NULL
        AND ${t.resumeRequestExpiresAt} IS NULL
        AND ${t.resumeRequestReason} IS NULL
      ) OR (
        ${t.resumeRequestId} IS NOT NULL
        AND ${t.resumeRequestedByUserId} IS NOT NULL
        AND ${t.resumeRequestedAt} IS NOT NULL
        AND ${t.resumeRequestExpiresAt} IS NOT NULL
        AND char_length(${t.resumeRequestReason}) BETWEEN 8 AND 500
      )`,
    ),
  ],
);

/** Append-only audit and incident history. Runtime roles must not update/delete. */
export const liveSafetyEventsTable = pgTable(
  "live_safety_events",
  {
    id: serial("id").primaryKey(),
    eventKey: text("event_key"),
    targetUserId: integer("target_user_id").notNull(),
    section: text("section").notNull(),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    actorUserId: integer("actor_user_id"),
    reasonCode: text("reason_code").notNull(),
    reason: text("reason").notNull(),
    payload: jsonb("payload"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("live_safety_events_event_key_unique").on(t.eventKey),
    index("live_safety_events_target_idx").on(
      t.targetUserId,
      t.section,
      t.occurredAt,
    ),
  ],
);

export const insertLiveExecutionStateSchema = createInsertSchema(
  liveExecutionStatesTable,
).omit({ id: true, updatedAt: true });
export const insertLiveKillSwitchSchema = createInsertSchema(
  liveKillSwitchesTable,
).omit({ id: true, activatedAt: true, updatedAt: true });
export const insertLiveSafetyEventSchema = createInsertSchema(
  liveSafetyEventsTable,
).omit({ id: true, occurredAt: true });

export type LiveExecutionState = typeof liveExecutionStatesTable.$inferSelect;
export type LiveGlobalEquityState =
  typeof liveGlobalEquityStateTable.$inferSelect;
export type LiveKillSwitch = typeof liveKillSwitchesTable.$inferSelect;
export type LiveSafetyEvent = typeof liveSafetyEventsTable.$inferSelect;
export type InsertLiveExecutionState = z.infer<
  typeof insertLiveExecutionStateSchema
>;
export type InsertLiveKillSwitch = z.infer<typeof insertLiveKillSwitchSchema>;
export type InsertLiveSafetyEvent = z.infer<typeof insertLiveSafetyEventSchema>;
