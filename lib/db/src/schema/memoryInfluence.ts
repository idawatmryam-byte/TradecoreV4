import { pgTable, serial, text, numeric, integer, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { captureSchema } from "./capture";

// ---------------------------------------------------------------------------
// Gated memory influence — the audit trail for the one place the engine's own
// history changes what it does.
//
// Two tables, deliberately in different schemas:
//
//   capture.memory_influences  every delta memory actually applied, append-only
//                              and enforced by GRANT. A record of what the
//                              engine did to a live decision must not be
//                              editable by the thing that wrote it.
//
//   memory_validations         walk-forward runs. Mutable (a run moves through
//                              pending → running → completed, like
//                              autopsy_runs) and therefore in `public`, where
//                              UPDATE is permitted.
// ---------------------------------------------------------------------------

/**
 * One applied influence, written whenever memory raised a plan's bar —
 * whether or not the plan cleared it.
 *
 * Both outcomes are recorded on purpose. Logging only the withheld trades
 * would make the log look like a list of saves and hide every case where the
 * rule fired and cost nothing, which is exactly the comparison a user needs
 * to decide whether to keep influence on.
 */
export const memoryInfluencesTable = captureSchema.table("memory_influences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull().default("crypto"),

  /** The memory state in force: "memory-1:<hash>". Joins a decision to its rules. */
  memoryVersion: text("memory_version").notNull(),
  /** Links to the trade / captured decision when the plan was admitted. */
  correlationId: text("correlation_id"),
  /** The plan's content hash — unchanged by influence, which is the point. */
  planFingerprint: text("plan_fingerprint"),

  symbol: text("symbol").notNull(),
  strategyId: text("strategy_id").notNull(),
  /** demo | live — paper-first rollout is auditable only if this is recorded. */
  executionTarget: text("execution_target").notNull().default("demo"),

  /** True when the plan cleared the raised bar and went on to execute. */
  admitted: boolean("admitted").notNull(),
  /** The plan's own confidence, 0–100. */
  confidence: numeric("confidence", { precision: 5, scale: 2 }).notNull(),
  /** The bar the plan had already cleared, before memory. */
  referenceConfidence: numeric("reference_confidence", { precision: 5, scale: 2 }).notNull(),
  /** Confidence points memory added. Always positive — memory only tightens. */
  delta: numeric("delta", { precision: 5, scale: 2 }).notNull(),
  /** referenceConfidence + delta. */
  requiredConfidence: numeric("required_confidence", { precision: 5, scale: 2 }).notNull(),

  /** The cells that contributed, with their samples, win rates and q-values. */
  rules: jsonb("rules").notNull(),
  reason: text("reason").notNull(),

  /** Market time of the decision, mirroring the capture log. */
  dataTimestamp: timestamp("data_timestamp", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("capture_memory_influences_user_time_idx").on(t.userId, t.createdAt),
  index("capture_memory_influences_version_idx").on(t.memoryVersion),
  index("capture_memory_influences_correlation_idx").on(t.correlationId),
]);

export const insertMemoryInfluenceSchema = createInsertSchema(memoryInfluencesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMemoryInfluence = z.infer<typeof insertMemoryInfluenceSchema>;
export type MemoryInfluence = typeof memoryInfluencesTable.$inferSelect;

/**
 * A walk-forward validation run: cells fitted on an earlier window, tested on
 * a later one the fit never saw.
 *
 * The row is the permission slip. Live influence requires a `completed` run
 * with verdict `improved` whose `stateVersion` matches the state currently in
 * force — so a refit that changes the rules invalidates the permission
 * automatically rather than inheriting it.
 */
export const memoryValidationsTable = pgTable("memory_validations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull().default("crypto"),

  status: text("status").notNull().default("pending"), // pending | running | completed | failed
  /** improved | no_better | insufficient_data */
  verdict: text("verdict"),
  summary: text("summary"),
  error: text("error"),

  /** Version of the state this run validated. The permission is version-scoped. */
  stateVersion: text("state_version"),
  /** The full InfluenceState, so the exact rules that earned approval are kept. */
  state: jsonb("state"),
  /** Which execution target's record it was fitted on. */
  executionTarget: text("execution_target").notNull().default("demo"),

  /** Point-in-time provenance and the gap between fit and evaluation. */
  dataCutoff: timestamp("data_cutoff", { withTimezone: true }),
  embargoMs: integer("embargo_ms").notNull().default(86400000),
  embargoedTrades: integer("embargoed_trades").notNull().default(0),
  trainFrom: timestamp("train_from", { withTimezone: true }),
  trainTo: timestamp("train_to", { withTimezone: true }),
  validationFrom: timestamp("validation_from", { withTimezone: true }),
  validationTo: timestamp("validation_to", { withTimezone: true }),
  correction: text("correction").notNull().default("benjamini-hochberg"),

  trainTrades: integer("train_trades").notNull().default(0),
  validationTrades: integer("validation_trades").notNull().default(0),
  withheld: integer("withheld").notNull().default(0),
  withheldPnlUsdt: numeric("withheld_pnl_usdt", { precision: 18, scale: 8 }),
  expectancyDelta: numeric("expectancy_delta", { precision: 18, scale: 8 }),
  /** ArmMetrics for each side of the comparison. */
  baseline: jsonb("baseline"),
  withMemory: jsonb("with_memory"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  index("memory_validations_user_created_idx").on(t.userId, t.section, t.createdAt),
]);

export const insertMemoryValidationSchema = createInsertSchema(memoryValidationsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMemoryValidation = z.infer<typeof insertMemoryValidationSchema>;
export type MemoryValidation = typeof memoryValidationsTable.$inferSelect;
