import { pgTable, serial, text, numeric, integer, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  /** Owning user — each user runs a fully independent bot instance. */
  userId: integer("user_id").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull().default("buy"),
  entryPrice: numeric("entry_price", { precision: 18, scale: 8 }).notNull(),
  exitPrice: numeric("exit_price", { precision: 18, scale: 8 }),
  quantity: numeric("quantity", { precision: 18, scale: 8 }).notNull(),
  pnl: numeric("pnl", { precision: 18, scale: 8 }),
  status: text("status").notNull().default("open"), // open | closed | stopped
  confidence: numeric("confidence", { precision: 5, scale: 2 }).notNull(),
  stopLoss: numeric("stop_loss", { precision: 18, scale: 8 }).notNull(),
  takeProfit: numeric("take_profit", { precision: 18, scale: 8 }).notNull(),
  entryTime: timestamp("entry_time", { withTimezone: true }).notNull().defaultNow(),
  exitTime: timestamp("exit_time", { withTimezone: true }),
  // take_profit | stop_loss | signal_exit | timeout (= TIME_LIMIT) | break_even |
  // trailing_stop | manual | emergency_stop | circuit_breaker — see lib/exitTypes.ts
  exitReason: text("exit_reason"),
  isBacktest: boolean("is_backtest").notNull().default(false),
  /** Phase 2: which strategy generated this trade */
  strategyId: text("strategy_id"),
  strategyName: text("strategy_name"),
  /** Phase 2.5 Risk Audit: true when actual loss exceeded expected max loss */
  riskViolation: boolean("risk_violation").notNull().default(false),
  /** Phase 2.5 Risk Audit: human-readable explanation of the violation */
  riskViolationReason: text("risk_violation_reason"),

  // ── Phase 4A: full exit audit trail (ExitManager) ──────────────────────────
  /** SL/TP exactly as the strategy signal computed them, before entry-slippage
   *  adjustment. Compared against the actual placed stopLoss/takeProfit below
   *  to catch any drift between "intended" and "sent to the exchange". */
  plannedStopLoss: numeric("planned_stop_loss", { precision: 18, scale: 8 }),
  plannedTakeProfit: numeric("planned_take_profit", { precision: 18, scale: 8 }),
  /** Quantity the strategy/risk sizing intended vs. what the exchange actually filled. */
  plannedQuantity: numeric("planned_quantity", { precision: 18, scale: 8 }),
  /** Estimated round-trip taker fees (entry + exit) in USDT. */
  feesUsdt: numeric("fees_usdt", { precision: 18, scale: 8 }),
  /** |actual exit price − planned trigger price| × qty, for stop_loss/take_profit exits. */
  slippageUsdt: numeric("slippage_usdt", { precision: 18, scale: 8 }),
  /** Holding duration in whole seconds (exitTime − entryTime). */
  holdingSeconds: integer("holding_seconds"),
  /** Profit before fees are subtracted. `pnl` above remains the NET profit. */
  grossPnl: numeric("gross_pnl", { precision: 18, scale: 8 }),

  // ── Phase 4B: professional trade management ────────────────────────────────
  /** Quantity still open after any partial closes (TP1/TP2). Defaults to `quantity` at entry. */
  remainingQuantity: numeric("remaining_quantity", { precision: 18, scale: 8 }),
  tp1Price: numeric("tp1_price", { precision: 18, scale: 8 }),
  tp1Quantity: numeric("tp1_quantity", { precision: 18, scale: 8 }),
  tp1Filled: boolean("tp1_filled").notNull().default(false),
  tp1FillPrice: numeric("tp1_fill_price", { precision: 18, scale: 8 }),
  tp1FillTime: timestamp("tp1_fill_time", { withTimezone: true }),
  /** Only populated/used when the strategy config has tp3Enabled. */
  tp2Price: numeric("tp2_price", { precision: 18, scale: 8 }),
  tp2Quantity: numeric("tp2_quantity", { precision: 18, scale: 8 }),
  tp2Filled: boolean("tp2_filled").notNull().default(false),
  tp2FillPrice: numeric("tp2_fill_price", { precision: 18, scale: 8 }),
  tp2FillTime: timestamp("tp2_fill_time", { withTimezone: true }),
  /** Reserved for a future manual final-target override. The automatic TP1/TP2
   *  ladder never needs this — TP1/TP2 are always interior waypoints strictly
   *  between entry and the strategy's own `takeProfit`, which remains the
   *  final target for the remainder throughout (see enterTrade/TradeManager). */
  tp3Price: numeric("tp3_price", { precision: 18, scale: 8 }),
  /** True once TP1 has filled and `stopLoss` has been moved to entry price. */
  breakEvenActive: boolean("break_even_active").notNull().default(false),
  /** True once a trailing stop has taken over management of `stopLoss`. */
  trailingStopActive: boolean("trailing_stop_active").notNull().default(false),
  trailingStopMode: text("trailing_stop_mode"), // none|atr|percent|dynamic|emergency
  /** Best price seen since trailing armed — the reference point the trailing distance is measured from. */
  trailingStopArmedPrice: numeric("trailing_stop_armed_price", { precision: 18, scale: 8 }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Frequently queried in every scan cycle — open position lookup + blacklist update
  index("trades_user_status_idx").on(t.userId, t.status),
  index("trades_user_symbol_idx").on(t.userId, t.symbol),
  // Composite for the per-symbol "last 10 closed trades" query in updateBlacklist
  index("trades_user_symbol_status_exit_time_idx").on(t.userId, t.symbol, t.status, t.exitTime),
]);

export const insertTradeSchema = createInsertSchema(tradesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;

// ---------------------------------------------------------------------------
// Phase 4B: partial-exit audit trail (TP1/TP2 partial closes)
// ---------------------------------------------------------------------------

export const tradePartialExitsTable = pgTable("trade_partial_exits", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id").notNull(),
  reason: text("reason").notNull(), // tp1 | tp2 | manual_partial
  quantity: numeric("quantity", { precision: 18, scale: 8 }).notNull(),
  price: numeric("price", { precision: 18, scale: 8 }).notNull(),
  /** Fees attributed to this slice (entry-share + this exit's fee). */
  fees: numeric("fees", { precision: 18, scale: 8 }).notNull().default("0"),
  /** NET profit for this slice (after `fees`). */
  pnl: numeric("pnl", { precision: 18, scale: 8 }).notNull(),
  time: timestamp("time", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("trade_partial_exits_trade_id_idx").on(t.tradeId),
]);

export const insertTradePartialExitSchema = createInsertSchema(tradePartialExitsTable).omit({
  id: true,
});
export type InsertTradePartialExit = z.infer<typeof insertTradePartialExitSchema>;
export type TradePartialExit = typeof tradePartialExitsTable.$inferSelect;
