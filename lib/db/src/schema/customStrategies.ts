import { pgTable, serial, integer, text, timestamp, jsonb, unique } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Custom strategies — the no-code strategy builder.
//
// A custom strategy is DATA, never code: a validated set of declarative
// entry conditions over indicators the engine already computes every scan
// (see api-server lib/customRules.ts for the zod schema), plus a stop-
// placement choice and a static confidence. One generic interpreter class
// (api-server lib/strategies/custom.ts) turns each row into a Strategy
// instance that runs through the exact same selector pipeline — dollar-risk
// solver, cost gates, decisions journal, backtesting, autopsy — as the
// built-in catalog. Users can never bypass a risk control, because none of
// the risk machinery lives in strategies.
//
// Risk/exit configuration deliberately REUSES strategy_configs (same
// (userId, section, strategyId) key), so a custom strategy gets the full
// dollar plan / TP ladder / trailing editor with zero new plumbing.
//
// BACKTEST-FIRST LIVE GATE: lastBacktestAt is stamped when a single-strategy
// backtest of this strategy completes; enabling it for live requires the
// stamp. Editing the rules resets the stamp (a changed strategy is a new,
// untested strategy) — see routes/customStrategies.ts.
// ---------------------------------------------------------------------------

export const customStrategiesTable = pgTable("custom_strategies", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  /** Independent trading section (crypto | forex) this strategy belongs to. */
  section: text("section").notNull().default("crypto"),
  /** Engine-facing id, "custom_<id>" — set right after insert. Namespaced so
   *  it can never collide with a built-in strategyId. */
  strategyId: text("strategy_id").notNull().default(""),
  name: text("name").notNull(),
  description: text("description"),
  /** The validated rule document (CustomRules in api-server lib/customRules.ts):
   *  { long?: Condition[], short?: Condition[], stop: {...}, confidence }. */
  rules: jsonb("rules").notNull(),
  /** Set when a single-strategy backtest of this strategy COMPLETES; null
   *  until then (and reset to null on every rules edit). Live enablement
   *  requires it — see routes/strategies.ts. */
  lastBacktestAt: timestamp("last_backtest_at", { withTimezone: true }),
  /** Bumped on every rules/name edit — pairs with lastBacktestAt. */
  rulesUpdatedAt: timestamp("rules_updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("custom_strategies_user_section_strategy_unique").on(t.userId, t.section, t.strategyId),
]);

export type CustomStrategyRow = typeof customStrategiesTable.$inferSelect;
export type InsertCustomStrategy = typeof customStrategiesTable.$inferInsert;
