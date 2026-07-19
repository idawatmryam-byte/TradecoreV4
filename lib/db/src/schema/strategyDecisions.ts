import { pgTable, serial, text, numeric, integer, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Every trade a strategy genuinely CONSIDERED — approved and executed,
 * approved but not taken (lost fair allocation, portfolio risk, margin…),
 * or rejected by the strategy's own reasoning. This is the persistent
 * decision journal behind the Decisions feed: the professional trader's
 * "why I traded / why I passed" record, kept auditable across restarts.
 *
 * Growth is bounded two ways (see lib/decisionRecorder.ts):
 *   • dedupe — an identical repeating rejection bumps `occurrences` instead
 *     of inserting a new row;
 *   • retention — rows older than the retention window are pruned hourly.
 */
export const strategyDecisionsTable = pgTable("strategy_decisions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  /** Independent trading section (crypto | forex) — keeps each section's
   *  Decisions feed separate. Backfills to "crypto". */
  section: text("section").notNull().default("crypto"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  symbol: text("symbol").notNull(),
  strategyId: text("strategy_id").notNull(),
  strategyName: text("strategy_name"),
  /** "executed" | "approved_not_taken" | "rejected" */
  kind: text("kind").notNull(),
  side: text("side"), // long | short
  confidence: numeric("confidence", { precision: 5, scale: 2 }),
  /** Rejection stage (setup | dollar-plan | coin-fit | leverage | reward-risk |
   *  sizing) or the engine stage for approved_not_taken. */
  stage: text("stage"),
  reason: text("reason"),
  /** DecisionReport for rejections; the full TradePlan for approved/executed. */
  report: jsonb("report"),
  /** Set when kind = "executed" — links to the trades row. */
  tradeId: integer("trade_id"),
  /** Dedupe counter: identical repeating decisions bump this, not row count. */
  occurrences: integer("occurrences").notNull().default(1),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("strategy_decisions_user_created_idx").on(t.userId, t.createdAt),
  index("strategy_decisions_user_symbol_idx").on(t.userId, t.symbol),
]);

export const insertStrategyDecisionSchema = createInsertSchema(strategyDecisionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertStrategyDecision = z.infer<typeof insertStrategyDecisionSchema>;
export type StrategyDecision = typeof strategyDecisionsTable.$inferSelect;
