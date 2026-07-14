import { pgTable, serial, text, numeric, integer, timestamp, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const blacklistTable = pgTable("blacklist_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  symbol: text("symbol").notNull(),
  winRate: numeric("win_rate", { precision: 5, scale: 4 }).notNull(),
  tradeCount: integer("trade_count").notNull(),
  blacklistedAt: timestamp("blacklisted_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  // Queried on every scan: WHERE user_id = ? AND expires_at >= now
  index("blacklist_user_expires_at_idx").on(t.userId, t.expiresAt),
  unique("blacklist_user_id_symbol_unique").on(t.userId, t.symbol),
]);

export const insertBlacklistSchema = createInsertSchema(blacklistTable).omit({ id: true });
export type InsertBlacklist = z.infer<typeof insertBlacklistSchema>;
export type BlacklistEntry = typeof blacklistTable.$inferSelect;

export const hourlyStatsTable = pgTable("hourly_stats", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  hour: integer("hour").notNull(), // 0-23 UTC
  pnl: numeric("pnl", { precision: 12, scale: 8 }).notNull().default("0"),
  tradeCount: integer("trade_count").notNull().default(0),
  winCount: integer("win_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  userDateHourUnique: unique("hourly_stats_user_id_date_hour_unique").on(t.userId, t.date, t.hour),
}));

export const insertHourlyStatSchema = createInsertSchema(hourlyStatsTable).omit({ id: true, createdAt: true });
export type InsertHourlyStat = z.infer<typeof insertHourlyStatSchema>;
export type HourlyStat = typeof hourlyStatsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Post-trade analysis — the engine's persistent memory of WHY each closed
// trade turned out the way it did. Generated deterministically from the
// recorded trade facts the moment a trade closes (see lib/tradeAnalysis.ts);
// no assumptions, no fabrication. The derived columns (outcome, rMultiple,
// grade) are stored so patterns can be aggregated with plain SQL; `findings`
// holds the itemised factual points and `summary` the readable explanation.
// ---------------------------------------------------------------------------
export const tradeAnalysesTable = pgTable("trade_analyses", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tradeId: integer("trade_id").notNull(),
  /** "win" | "loss" | "breakeven" — sign of net P&L. */
  outcome: text("outcome").notNull(),
  /** Realized reward:risk in R units = net P&L ÷ planned dollar risk. */
  rMultiple: numeric("r_multiple", { precision: 10, scale: 4 }),
  /** Evidence-based execution grade A–F (entry conviction, exit quality,
   *  risk adherence, cost drag) — NOT a prediction, a scorecard of what happened. */
  grade: text("grade"),
  /** JSON array of factual findings, one per analysed dimension. */
  findings: text("findings").notNull(),
  /** Human-readable one-paragraph explanation of the outcome. */
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("trade_analyses_user_trade_unique").on(t.userId, t.tradeId),
  index("trade_analyses_user_idx").on(t.userId),
]);

export const insertTradeAnalysisSchema = createInsertSchema(tradeAnalysesTable).omit({ id: true, createdAt: true });
export type InsertTradeAnalysis = z.infer<typeof insertTradeAnalysisSchema>;
export type TradeAnalysis = typeof tradeAnalysesTable.$inferSelect;
