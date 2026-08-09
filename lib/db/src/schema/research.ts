import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { captureSchema } from "./capture";

/**
 * Mutable orchestration state for a bounded Research experiment. Scientific
 * inputs and outputs are immutable JSON contracts; only lifecycle/progress and
 * the terminal report change while the job runs.
 */
export const researchExperimentsTable = pgTable(
  "research_experiments",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    section: text("section").notNull(),
    experimentId: text("experiment_id"),
    name: text("name").notNull(),
    manifestVersion: text("manifest_version"),
    manifestFingerprint: text("manifest_fingerprint"),
    manifest: jsonb("manifest"),
    request: jsonb("request").notNull(),
    status: text("status").notNull().default("preparing"),
    stage: text("stage").notNull().default("data-preparation"),
    progress: integer("progress").notNull().default(0),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    decisionEventCount: integer("decision_event_count").notNull().default(0),
    managementEventCount: integer("management_event_count")
      .notNull()
      .default(0),
    goldenStreamFingerprint: text("golden_stream_fingerprint"),
    report: jsonb("report"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("research_experiments_tenant_id_unique").on(
      table.userId,
      table.section,
      table.experimentId,
    ),
    index("research_experiments_user_created_idx").on(
      table.userId,
      table.section,
      table.createdAt,
    ),
    index("research_experiments_status_idx").on(table.status),
    uniqueIndex("research_experiments_one_active_per_tenant_idx")
      .on(table.userId, table.section)
      .where(sql`${table.status} IN ('preparing', 'pending', 'running')`),
    check(
      "research_experiments_section_check",
      sql`${table.section} IN ('crypto', 'forex')`,
    ),
    check(
      "research_experiments_status_check",
      sql`${table.status} IN ('preparing', 'pending', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "research_experiments_progress_check",
      sql`${table.progress} >= 0 AND ${table.progress} <= 100`,
    ),
    check(
      "research_experiments_event_count_check",
      sql`${table.decisionEventCount} >= 0 AND ${table.managementEventCount} >= 0`,
    ),
  ],
);

/**
 * Append-only, bounded replay stream. Payloads are strict Phase 8 contracts;
 * the summary columns support tenant-scoped replay pagination without reading
 * or indexing arbitrary JSON fields.
 */
export const researchReplayEventsTable = captureSchema.table(
  "research_replay_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    section: text("section").notNull(),
    experimentDbId: integer("experiment_db_id")
      .notNull()
      .references(() => researchExperimentsTable.id),
    experimentId: text("experiment_id").notNull(),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    partitionId: text("partition_id").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    symbol: text("symbol"),
    tradeId: integer("trade_id"),
    eventFingerprint: text("event_fingerprint").notNull(),
    event: jsonb("event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("capture_research_replay_event_unique").on(
      table.experimentDbId,
      table.sequence,
    ),
    unique("capture_research_replay_fingerprint_unique").on(
      table.experimentDbId,
      table.eventFingerprint,
    ),
    index("capture_research_replay_user_time_idx").on(
      table.userId,
      table.section,
      table.observedAt,
    ),
    index("capture_research_replay_experiment_sequence_idx").on(
      table.experimentDbId,
      table.sequence,
    ),
    index("capture_research_replay_symbol_time_idx").on(
      table.symbol,
      table.observedAt,
    ),
    check(
      "capture_research_replay_section_check",
      sql`${table.section} IN ('crypto', 'forex')`,
    ),
    check(
      "capture_research_replay_kind_check",
      sql`${table.kind} IN ('decision', 'management')`,
    ),
    check(
      "capture_research_replay_sequence_check",
      sql`${table.sequence} >= 0`,
    ),
  ],
);

export const insertResearchExperimentSchema = createInsertSchema(
  researchExperimentsTable,
).omit({
  id: true,
  createdAt: true,
});
export const insertResearchReplayEventSchema = createInsertSchema(
  researchReplayEventsTable,
).omit({
  id: true,
  createdAt: true,
});

export type InsertResearchExperiment = z.infer<
  typeof insertResearchExperimentSchema
>;
export type ResearchExperimentRecord =
  typeof researchExperimentsTable.$inferSelect;
export type InsertResearchReplayEvent = z.infer<
  typeof insertResearchReplayEventSchema
>;
export type ResearchReplayEventRecord =
  typeof researchReplayEventsTable.$inferSelect;
