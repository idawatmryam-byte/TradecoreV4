import { pgTable, serial, text, numeric, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Optimization Autopsy runs — "what's wrong with MY configuration?"
//
// A staged parameter sweep over ONE strategy's real tunable knobs (dollar
// risk/target, confidence floor, hold time), evaluated with the live-parity
// backtest engine and — critically — WALK-FORWARD VALIDATED: candidates are
// fitted on the train window and only survive if they ALSO beat the current
// configuration on the later validation window they were never fitted to.
// That out-of-sample gate is what separates a diagnostic from a
// curve-fitting machine; "no_better" is an honest, first-class verdict.
//
// Child backtest_runs created during the sweep are deleted on completion
// (their metrics are summarized here) so the user's backtest list isn't
// flooded with dozens of internal runs.
// ---------------------------------------------------------------------------

export const autopsyRunsTable = pgTable("autopsy_runs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  /** crypto-only in v1 (the forex backtest engine doesn't exist yet). */
  section: text("section").notNull().default("crypto"),
  strategyId: text("strategy_id").notNull(),
  strategyName: text("strategy_name"),
  symbols: text("symbols").notNull(), // comma-separated
  timeframe: text("timeframe").notNull(),
  trainStart: timestamp("train_start", { withTimezone: true }).notNull(),
  trainEnd: timestamp("train_end", { withTimezone: true }).notNull(),
  valStart: timestamp("val_start", { withTimezone: true }).notNull(),
  valEnd: timestamp("val_end", { withTimezone: true }).notNull(),

  status: text("status").notNull().default("pending"), // pending | running | completed | failed
  progress: integer("progress").notNull().default(0),  // 0-100
  /** Live progress caption ("sweeping dollar plans 4/12…") for the UI. */
  stage: text("stage"),
  totalBacktests: integer("total_backtests").notNull().default(0),
  /** Set when the 10-minute budget truncated the sweep (results still valid,
   *  just narrower coverage). */
  truncated: integer("truncated").notNull().default(0), // 0|1 (boolean)

  /** The strategy's live config knobs at launch time (the baseline). */
  currentParams: jsonb("current_params").notNull(),
  /** The best out-of-sample-surviving candidate's knobs (null = none beat current). */
  bestParams: jsonb("best_params"),
  /** MetricsSummary (winRate/profitFactor/sharpe/maxDrawdown/trades/pnl +
   *  exit-reason counts) for each config on each window. */
  currentTrain: jsonb("current_train"),
  currentVal: jsonb("current_val"),
  bestTrain: jsonb("best_train"),
  bestVal: jsonb("best_val"),

  /** improved | no_better | insufficient_data */
  verdict: text("verdict"),
  /** Array of findings: { param, label, current, suggested, evidence, action }
   *  plus a summary string — the plain-English autopsy. */
  diagnosis: jsonb("diagnosis"),
  error: text("error"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  index("autopsy_runs_user_created_idx").on(t.userId, t.createdAt),
]);

export type AutopsyRun = typeof autopsyRunsTable.$inferSelect;
