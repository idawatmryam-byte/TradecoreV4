import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  timestamp,
  bigint,
  jsonb,
  uniqueIndex,
  index,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Historical candles cache
// ---------------------------------------------------------------------------

export const historicalCandlesTable = pgTable(
  "historical_candles",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(), // ms epoch
    open: numeric("open", { precision: 18, scale: 8 }).notNull(),
    high: numeric("high", { precision: 18, scale: 8 }).notNull(),
    low: numeric("low", { precision: 18, scale: 8 }).notNull(),
    close: numeric("close", { precision: 18, scale: 8 }).notNull(),
    volume: numeric("volume", { precision: 28, scale: 8 }).notNull(),
    downloadedAt: timestamp("downloaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    symbolTimeframeTsUnique: uniqueIndex("hist_candles_sym_tf_ts_unique").on(
      t.symbol,
      t.timeframe,
      t.timestamp
    ),
  })
);

export const insertHistoricalCandleSchema = createInsertSchema(
  historicalCandlesTable
).omit({ id: true, downloadedAt: true });
export type InsertHistoricalCandle = z.infer<
  typeof insertHistoricalCandleSchema
>;
export type HistoricalCandle = typeof historicalCandlesTable.$inferSelect;

// ---------------------------------------------------------------------------
// Backtest runs
// ---------------------------------------------------------------------------

export const backtestRunsTable = pgTable("backtest_runs", {
  id: serial("id").primaryKey(),
  /** Owning user — backtest_trades/equity_curve/optimization_results all
   *  cascade-scope via run_id, so only this table needs the column directly. */
  userId: integer("user_id").notNull(),
  strategyVersion: text("strategy_version").notNull().default("1.0"),
  strategyName: text("strategy_name").notNull().default("TradeCore v1"),
  symbols: text("symbols").notNull(), // comma-separated
  timeframe: text("timeframe").notNull(),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }).notNull(),
  startingBalance: numeric("starting_balance", {
    precision: 18,
    scale: 2,
  }).notNull(),
  endingBalance: numeric("ending_balance", { precision: 18, scale: 2 }),
  totalReturn: numeric("total_return", { precision: 10, scale: 4 }),
  totalPnl: numeric("total_pnl", { precision: 18, scale: 2 }),
  totalTrades: integer("total_trades"),
  winningTrades: integer("winning_trades"),
  losingTrades: integer("losing_trades"),
  winRate: numeric("win_rate", { precision: 5, scale: 4 }),
  profitFactor: numeric("profit_factor", { precision: 10, scale: 4 }),
  sharpeRatio: numeric("sharpe_ratio", { precision: 10, scale: 4 }),
  sortinoRatio: numeric("sortino_ratio", { precision: 10, scale: 4 }),
  maxDrawdown: numeric("max_drawdown", { precision: 10, scale: 4 }),
  averageWin: numeric("average_win", { precision: 18, scale: 8 }),
  averageLoss: numeric("average_loss", { precision: 18, scale: 8 }),
  expectancy: numeric("expectancy", { precision: 18, scale: 8 }),
  /** Phase 4C: single largest winning/losing trade (USDT). */
  largestWin: numeric("largest_win", { precision: 18, scale: 8 }),
  largestLoss: numeric("largest_loss", { precision: 18, scale: 8 }),
  /** Phase 4C: [{ date: "YYYY-MM-DD", pnl, return }] and [{ month: "YYYY-MM", pnl, return }] */
  dailyReturns: jsonb("daily_returns"),
  monthlyReturns: jsonb("monthly_returns"),
  /** Phase 4C: per-strategy breakdown — [{ strategyId, strategyName, trades, winRate, pnl, profitFactor }] */
  strategyComparison: jsonb("strategy_comparison"),
  /** Phase 7: what fraction of trades actually exercised each stage of the
   *  TP1/TP2/break-even/trailing ladder — the direct, checkable answer to
   *  "does this backtest exercise the same trade-management machinery live
   *  trading runs," not just an assertion that it does. */
  tp1HitRate: numeric("tp1_hit_rate", { precision: 6, scale: 4 }),
  tp2HitRate: numeric("tp2_hit_rate", { precision: 6, scale: 4 }),
  breakEvenRate: numeric("break_even_rate", { precision: 6, scale: 4 }),
  trailingStopRate: numeric("trailing_stop_rate", { precision: 6, scale: 4 }),
  /** Phase 6 audit Finding A/E fix: populated at submission time when any
   *  enabled strategy's maxHoldingSeconds is ≤ the selected primary
   *  timeframe's candle interval — the dominant failure mode found in the
   *  audit (positions guaranteed to time out before a single genuine SL/TP
   *  check could run). Surfaced in the UI/CSV/report so a 97-100% timeout
   *  result isn't misread as "the strategy doesn't work." */
  timeframeWarnings: jsonb("timeframe_warnings"),
  /** Diagnostic: the actual per-strategy config used for this run — both
   *  the per-strategy summary (stopLossPercent/takeProfitPercent/
   *  confidenceThreshold/riskPercent) and the run-level overrides applied,
   *  as `{ summary: [...], runLevelOverrides: {...} }`. Computed by
   *  buildEffectiveBacktestConfigs() and persisted BEFORE the simulation
   *  starts. This is what powers the "Effective Backtest Configuration"
   *  panel and proves the submitted params were actually applied — see
   *  lib/backtestConfig.ts. */
  effectiveConfig: jsonb("effective_config"),
  // Run params stored as JSON for flexibility
  params: jsonb("params"),
  // Execution state
  status: text("status").notNull().default("pending"), // pending|running|completed|failed|cancelled
  progress: integer("progress").notNull().default(0), // 0-100
  error: text("error"),
  aiAnalysis: jsonb("ai_analysis"),
  /** Decision-engine telemetry for the run, AGGREGATED (never row-per-event):
   *  per strategy × stage × reason → { count, sample[≤5] } of rejections and
   *  approved-not-taken decisions. Bounded by construction — a 2-week 1m run
   *  evaluates ~45k candles and would explode any per-event table. */
  decisionStats: jsonb("decision_stats"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  index("backtest_runs_user_id_idx").on(t.userId),
]);

export const insertBacktestRunSchema = createInsertSchema(
  backtestRunsTable
).omit({ id: true, createdAt: true });
export type InsertBacktestRun = z.infer<typeof insertBacktestRunSchema>;
export type BacktestRun = typeof backtestRunsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Backtest trades (per-run trade history)
// ---------------------------------------------------------------------------

export const backtestTradesTable = pgTable("backtest_trades", {
  id: serial("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => backtestRunsTable.id, { onDelete: "cascade" }),
  symbol: text("symbol").notNull(),
  side: text("side").notNull().default("buy"),
  entryTime: timestamp("entry_time", { withTimezone: true }).notNull(),
  exitTime: timestamp("exit_time", { withTimezone: true }),
  entryPrice: numeric("entry_price", { precision: 18, scale: 8 }).notNull(),
  exitPrice: numeric("exit_price", { precision: 18, scale: 8 }),
  quantity: numeric("quantity", { precision: 18, scale: 8 }).notNull(),
  stopLoss: numeric("stop_loss", { precision: 18, scale: 8 }).notNull(),
  takeProfit: numeric("take_profit", { precision: 18, scale: 8 }).notNull(),
  fees: numeric("fees", { precision: 18, scale: 8 }),
  slippage: numeric("slippage", { precision: 18, scale: 8 }),
  pnl: numeric("pnl", { precision: 18, scale: 8 }),
  pnlPercent: numeric("pnl_percent", { precision: 10, scale: 4 }),
  confidence: numeric("confidence", { precision: 5, scale: 2 }),
  exitReason: text("exit_reason"), // take_profit|stop_loss|timeout
  durationSeconds: integer("duration_seconds"),
  /** Phase 4C: Maximum Favorable/Adverse Excursion in quote-currency (USDT) terms,
   *  tracked bar-by-bar for the life of the position. */
  mfe: numeric("mfe", { precision: 18, scale: 8 }),
  mae: numeric("mae", { precision: 18, scale: 8 }),
  /** Planned reward/risk ratio: (tpPrice − entryPrice) / (entryPrice − slPrice). */
  riskReward: numeric("risk_reward", { precision: 10, scale: 4 }),
  /** Phase 2: which strategy generated this trade */
  strategyId: text("strategy_id"),
  strategyName: text("strategy_name"),
  marketRegime: text("market_regime"),
  /** Profit before fees. `pnl` above is NET (post-fees) — mirrors the live
   *  `trades.grossPnl`/`trades.pnl` split so the same fee-drag analysis
   *  (e.g. "did fees exceed the gross move") works on backtest data too. */
  grossPnl: numeric("gross_pnl", { precision: 18, scale: 8 }),

  // ── Phase 7: trade-management parity (TP1/TP2/break-even/trailing) ─────────
  // Mirrors trades.* (Phase 4B) exactly — same field names/semantics — so the
  // backtest simulates the identical staged-exit ladder live trading runs,
  // not a simplified binary SL/TP/timeout. `quantity` above remains the
  // original full entry size; these track how that size was actually worked
  // off in stages. Per-slice detail (fill price/fees/pnl for each partial)
  // lives in backtestTradePartialExitsTable — these are summary/filter flags.
  tp1Price: numeric("tp1_price", { precision: 18, scale: 8 }),
  tp1Quantity: numeric("tp1_quantity", { precision: 18, scale: 8 }),
  tp1Filled: boolean("tp1_filled").notNull().default(false),
  tp1FillPrice: numeric("tp1_fill_price", { precision: 18, scale: 8 }),
  tp1FillTime: timestamp("tp1_fill_time", { withTimezone: true }),
  tp2Price: numeric("tp2_price", { precision: 18, scale: 8 }),
  tp2Quantity: numeric("tp2_quantity", { precision: 18, scale: 8 }),
  tp2Filled: boolean("tp2_filled").notNull().default(false),
  tp2FillPrice: numeric("tp2_fill_price", { precision: 18, scale: 8 }),
  tp2FillTime: timestamp("tp2_fill_time", { withTimezone: true }),
  breakEvenActive: boolean("break_even_active").notNull().default(false),
  trailingStopActive: boolean("trailing_stop_active").notNull().default(false),
  trailingStopMode: text("trailing_stop_mode"), // none|atr|percent|dynamic|emergency

  // ── Decision-making engine ("the brains") — mirrors trades.* ──────────────
  /** Per-trade leverage the plan chose (native strategies may pick below the
   *  run's leverage cap; legacy plans equal it). */
  leverage: integer("leverage"),
  entryReason: text("entry_reason"),
  /** The full TradePlan this simulated trade executed. */
  tradePlan: jsonb("trade_plan"),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertBacktestTradeSchema = createInsertSchema(
  backtestTradesTable
).omit({ id: true, createdAt: true });
export type InsertBacktestTrade = z.infer<typeof insertBacktestTradeSchema>;
export type BacktestTrade = typeof backtestTradesTable.$inferSelect;

// ---------------------------------------------------------------------------
// Phase 7: backtest partial-exit audit trail (TP1/TP2 partial closes)
// Mirrors trade_partial_exits (live, Phase 4B) exactly — see trades.ts.
// ---------------------------------------------------------------------------

export const backtestTradePartialExitsTable = pgTable("backtest_trade_partial_exits", {
  id: serial("id").primaryKey(),
  backtestTradeId: integer("backtest_trade_id")
    .notNull()
    .references(() => backtestTradesTable.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(), // tp1 | tp2
  quantity: numeric("quantity", { precision: 18, scale: 8 }).notNull(),
  price: numeric("price", { precision: 18, scale: 8 }).notNull(),
  fees: numeric("fees", { precision: 18, scale: 8 }).notNull().default("0"),
  /** NET profit for this slice (after `fees`). */
  pnl: numeric("pnl", { precision: 18, scale: 8 }).notNull(),
  time: timestamp("time", { withTimezone: true }).notNull(),
}, (t) => [
  index("backtest_trade_partial_exits_trade_id_idx").on(t.backtestTradeId),
]);

export const insertBacktestTradePartialExitSchema = createInsertSchema(backtestTradePartialExitsTable).omit({
  id: true,
});
export type InsertBacktestTradePartialExit = z.infer<typeof insertBacktestTradePartialExitSchema>;
export type BacktestTradePartialExit = typeof backtestTradePartialExitsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Equity curve (time-series balance snapshots per run)
// ---------------------------------------------------------------------------

export const equityCurveTable = pgTable("equity_curve", {
  id: serial("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => backtestRunsTable.id, { onDelete: "cascade" }),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  balance: numeric("balance", { precision: 18, scale: 2 }).notNull(),
  drawdown: numeric("drawdown", { precision: 10, scale: 4 }).notNull().default("0"),
});

export const insertEquityCurveSchema = createInsertSchema(
  equityCurveTable
).omit({ id: true });
export type InsertEquityCurve = z.infer<typeof insertEquityCurveSchema>;
export type EquityCurvePoint = typeof equityCurveTable.$inferSelect;

// ---------------------------------------------------------------------------
// Optimization results
// ---------------------------------------------------------------------------

export const optimizationResultsTable = pgTable("optimization_results", {
  id: serial("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => backtestRunsTable.id, { onDelete: "cascade" }),
  parameterSet: jsonb("parameter_set").notNull(),
  score: numeric("score", { precision: 10, scale: 4 }),
  winRate: numeric("win_rate", { precision: 5, scale: 4 }),
  pnl: numeric("pnl", { precision: 18, scale: 2 }),
  drawdown: numeric("drawdown", { precision: 10, scale: 4 }),
  profitFactor: numeric("profit_factor", { precision: 10, scale: 4 }),
  totalTrades: integer("total_trades"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertOptimizationResultSchema = createInsertSchema(
  optimizationResultsTable
).omit({ id: true, createdAt: true });
export type InsertOptimizationResult = z.infer<
  typeof insertOptimizationResultSchema
>;
export type OptimizationResult =
  typeof optimizationResultsTable.$inferSelect;
