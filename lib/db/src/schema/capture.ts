import { pgSchema, pgTable, serial, text, numeric, integer, timestamp, index, jsonb, unique, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// The capture log — the historical asset.
//
// Everything here is APPEND-ONLY and lives in its own Postgres schema so the
// guarantee is enforced by a GRANT, not by convention: the application role
// holds INSERT and SELECT on `capture.*` and nothing else (see
// scripts/sql/capture-grants.sql). A stray UPDATE is a permission error, not a
// silently rewritten fact.
//
// This is deliberately NOT strategy_decisions. That table is the operational
// Decisions feed and is *supposed* to mutate — it dedupes repeat rejections
// into an occurrences counter and prunes at 14 days, which is right for a UI
// feed and fatal for a training set. The two now sit side by side: the feed
// stays bounded and mutable, the capture log stays immutable and complete.
//
// VOLUME — the reason this is signal-only. The scan loop runs every
// `scanIntervalSeconds` (default 15) per symbol. Capturing every evaluation
// would be ~5,760 scans/day/symbol — north of 20M rows per user per year, each
// with a features blob. So a full snapshot is written only when a strategy
// actually produced a DECISION (executed, approved-but-not-taken, or a
// reasoned rejection). Scans where no setup formed at all are counted, not
// captured, in `scan_counters` below.
// ---------------------------------------------------------------------------

export const captureSchema = pgSchema("capture");

/**
 * The exact indicator state a decision was made on — the inputs half of the
 * capture triple (features → plan → outcome).
 *
 * Deduplicated by content hash: several strategies deciding on the same symbol
 * in the same scan share one snapshot row rather than storing N copies.
 */
export const featureSnapshotsTable = captureSchema.table("feature_snapshots", {
  id: serial("id").primaryKey(),
  /** SHA-256 of the canonicalised features object. The dedupe key. */
  snapshotHash: text("snapshot_hash").notNull(),
  /** Where the data came from: binance | oanda. */
  provider: text("provider").notNull(),
  /** Which venue shape: spot | futures | forex. */
  venue: text("venue").notNull(),
  symbol: text("symbol").notNull(),
  /** Primary timeframe the indicators were computed on. */
  timeframe: text("timeframe").notNull(),
  /**
   * MARKET time — the close time of the newest candle behind these features.
   * Deliberately distinct from `createdAt` (wall-clock write time): only this
   * one makes an as-of-T query honest, because it is the moment the data was
   * actually true rather than the moment we happened to store it.
   */
  dataTimestamp: timestamp("data_timestamp", { withTimezone: true }).notNull(),
  /** The SignalRow: confidence, rsi, adx, regime, atr, macro flags, … */
  features: jsonb("features").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("capture_feature_snapshots_hash_unique").on(t.snapshotHash),
  index("capture_feature_snapshots_symbol_time_idx").on(t.symbol, t.dataTimestamp),
]);

export const insertFeatureSnapshotSchema = createInsertSchema(featureSnapshotsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertFeatureSnapshot = z.infer<typeof insertFeatureSnapshotSchema>;
export type FeatureSnapshot = typeof featureSnapshotsTable.$inferSelect;

/**
 * Every decision a strategy genuinely made, with the snapshot it was made on
 * and the provenance needed to reproduce it years later.
 */
export const capturedDecisionsTable = captureSchema.table("decisions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull().default("crypto"),

  /** Links to execution_intents + trades when this decision was executed. */
  correlationId: text("correlation_id"),
  /** SHA-256 of the TradePlan decision content (lib/plan/fingerprint.ts). */
  planFingerprint: text("plan_fingerprint"),
  /** The inputs this decision was made on. */
  featureSnapshotId: integer("feature_snapshot_id").notNull(),

  /** executed | approved_not_taken | rejected */
  outcome: text("outcome").notNull(),
  symbol: text("symbol").notNull(),
  strategyId: text("strategy_id").notNull(),
  side: text("side"),
  confidence: numeric("confidence", { precision: 5, scale: 2 }),
  /** Where it stopped (rejection stage, or the engine stage that blocked it). */
  stage: text("stage"),
  reason: text("reason"),
  /** Full TradePlan for approved/executed; DecisionReport for rejections. */
  payload: jsonb("payload"),

  // ── Provenance: what produced this, so a replay can be pinned to it ────────
  /** Engine build that made the decision (lib/version.ts). */
  engineVersion: text("engine_version").notNull(),
  /** Content hash of the effective strategy config in force at the time. */
  configVersion: text("config_version").notNull(),
  /** MemoryState version that influenced it. "memory-0" = no influence. */
  memoryVersion: text("memory_version").notNull().default("memory-0"),
  // NOTE: no strategy_version column. Strategies do not carry versions yet,
  // and a column that can only be filled with a placeholder is worse than an
  // absent one — it reads as provenance while guaranteeing nothing. It lands
  // when strategies are actually versioned.

  /** Market time of the decision (mirrors the snapshot's dataTimestamp). */
  dataTimestamp: timestamp("data_timestamp", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("capture_decisions_user_time_idx").on(t.userId, t.dataTimestamp),
  index("capture_decisions_strategy_idx").on(t.strategyId, t.dataTimestamp),
  index("capture_decisions_correlation_idx").on(t.correlationId),
  index("capture_decisions_snapshot_idx").on(t.featureSnapshotId),
]);

export const insertCapturedDecisionSchema = createInsertSchema(capturedDecisionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCapturedDecision = z.infer<typeof insertCapturedDecisionSchema>;
export type CapturedDecision = typeof capturedDecisionsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Scan counters — the cheap half of the signal-only policy.
//
// Lives in `public`, NOT `capture`, and that is deliberate: it is an
// incrementing aggregate, so it must be UPDATE-able, which is exactly what the
// capture schema forbids. It is derived operational data ("how often did this
// symbol get this far?"), not a historical fact about a decision.
//
// Bounded by construction: symbols × stages × hours.
// ---------------------------------------------------------------------------
export const scanCountersTable = pgTable("scan_counters", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull().default("crypto"),
  symbol: text("symbol").notNull(),
  /**
   * The pipeline stage the symbol stopped at — "Market Data", "Indicators",
   * "Signal", "Risk Checks", "Order", or "no_signal" when every strategy
   * looked and found no setup worth reporting. Stable values only: reason
   * TEXT embeds live numbers and would shatter the aggregate.
   */
  stage: text("stage").notNull(),
  /** UTC hour bucket this count belongs to. */
  hourBucket: timestamp("hour_bucket", { withTimezone: true }).notNull(),
  count: bigint("count", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("scan_counters_unique").on(t.userId, t.section, t.symbol, t.stage, t.hourBucket),
  index("scan_counters_user_bucket_idx").on(t.userId, t.hourBucket),
]);

export const insertScanCounterSchema = createInsertSchema(scanCountersTable).omit({ id: true, updatedAt: true });
export type InsertScanCounter = z.infer<typeof insertScanCounterSchema>;
export type ScanCounter = typeof scanCountersTable.$inferSelect;
