import { pgTable, serial, text, numeric, integer, timestamp, index, jsonb, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Co-Pilot recommendations — a TradePlan the engine produced and handed to the
// human instead of executing.
//
// The plan itself is IMMUTABLE. That is the architectural claim the whole
// product rests on, and it survives here: a user who wants a different stop
// does not edit this row, they create a NEW row that references it
// (`derivedFromId`), authored by them, re-validated from scratch. The original
// is marked `superseded` and keeps its exact original numbers forever.
//
// That matters beyond tidiness. When a trade loses money, the post-mortem must
// be able to say whether the engine's plan lost it or the user's override did.
// Mutating the plan in place destroys that answer permanently.
// ---------------------------------------------------------------------------

/**
 * Lifecycle. `created` is the only state from which a recommendation can be
 * acted on; everything else is terminal.
 *
 *   created     awaiting the user
 *   executing   atomically claimed by one approval request; no second request
 *               may cross the broker boundary while this state is present
 *   executed    the user approved it and a position was opened
 *   rejected    the user declined it
 *   expired     the user did not act before the plan went stale
 *   superseded  the user modified it; a derived plan replaced it
 *   blocked     re-validation at execute time refused it (risk moved, price
 *               drifted, account state changed). Terminal and READ-ONLY —
 *               there is no path from here to a position.
 */
export const RECOMMENDATION_STATUSES = [
  "created", "executing", "executed", "rejected", "expired", "superseded", "blocked",
] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export const recommendationsTable = pgTable("recommendations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  section: text("section").notNull().default("crypto"),

  /** Join key to the capture log and, once executed, to the trade. */
  correlationId: text("correlation_id").notNull(),
  /**
   * SHA-256 of the plan's decision content. A Co-Pilot recommendation and the
   * plan AutoPilot would have executed for the same scan hash identically —
   * that is how "same pipeline, different executor" is proved rather than
   * asserted.
   */
  planFingerprint: text("plan_fingerprint").notNull(),

  status: text("status").notNull().default("created"),
  /**
   * Who wrote this plan: "engine" (the strategy) or "user" (a modification of
   * an engine plan). Outcome attribution depends on this being honest.
   */
  authoredBy: text("authored_by").notNull().default("engine"),
  /** Set when this plan is a user's modification of another one. */
  derivedFromId: integer("derived_from_id"),

  symbol: text("symbol").notNull(),
  strategyId: text("strategy_id").notNull(),
  strategyName: text("strategy_name"),
  side: text("side").notNull(), // long | short
  confidence: numeric("confidence", { precision: 5, scale: 2 }).notNull(),

  // Denormalised so the inbox can list and filter without parsing the plan.
  entryPrice: numeric("entry_price", { precision: 18, scale: 8 }).notNull(),
  slPrice: numeric("sl_price", { precision: 18, scale: 8 }).notNull(),
  tpPrice: numeric("tp_price", { precision: 18, scale: 8 }).notNull(),
  qty: numeric("qty", { precision: 18, scale: 8 }).notNull(),
  leverage: integer("leverage").notNull().default(1),

  /** The full immutable TradePlan, verbatim. */
  plan: jsonb("plan").notNull(),
  /**
   * The indicator snapshot the plan was decided on. Kept so executing later
   * replays the ORIGINAL decision rather than re-deriving one from whatever
   * the market looks like at approval time.
   */
  signalRow: jsonb("signal_row"),
  /**
   * The five-stage pipeline trace (Market Data → Indicators → Signal → Risk
   * Checks → Order) as it stood the moment this recommendation was created —
   * a PipelineStage[] snapshot, same shape as decisionTrace.ts's live
   * SymbolDecision. BotEngine's own trace is in-memory only and is
   * overwritten every scan tick, so without capturing it here, the exact
   * reasoning behind a plan would be gone by the time a user opens the
   * workspace minutes later, leaving nothing for the Decision Timeline to
   * show but the plan's own after-the-fact narrative (report.summary etc.).
   */
  decisionTrace: jsonb("decision_trace"),

  /**
   * When this plan goes stale. An intraday setup is a statement about a
   * moment; approving it an hour later is a different trade wearing the same
   * numbers, so acting after this is refused rather than quietly allowed.
   */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  /** When the user (or expiry) resolved it. */
  actedAt: timestamp("acted_at", { withTimezone: true }),
  /** Set on execution. */
  tradeId: integer("trade_id"),
  /** Why a `blocked` or `rejected` recommendation ended that way. */
  resolutionReason: text("resolution_reason"),
}, (t) => [
  unique("recommendations_correlation_unique").on(t.correlationId),
  // The inbox query: this user's live recommendations, newest first.
  index("recommendations_user_status_idx").on(t.userId, t.section, t.status, t.createdAt),
  index("recommendations_expiry_idx").on(t.status, t.expiresAt),
]);

export const insertRecommendationSchema = createInsertSchema(recommendationsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertRecommendation = z.infer<typeof insertRecommendationSchema>;
export type Recommendation = typeof recommendationsTable.$inferSelect;
