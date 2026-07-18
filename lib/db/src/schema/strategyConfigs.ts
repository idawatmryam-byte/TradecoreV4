import { pgTable, serial, text, numeric, integer, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Per-strategy configurable parameters — one row per (user, strategy): each
// user's bot instance tunes strategies independently.
// ---------------------------------------------------------------------------

export const strategyConfigsTable = pgTable("strategy_configs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  strategyId: text("strategy_id").notNull(),
  strategyName: text("strategy_name").notNull(),
  enabled: boolean("enabled").notNull().default(true),

  // ── Dollar trade plan (the PRIMARY per-strategy controls in the UI) ────────
  // When maxLossUsdt AND targetProfitUsdt are set, this strategy trades the
  // dollar risk model (lib/dollarRisk.ts): the engine derives SL/TP prices and
  // position size from these three numbers, overriding the legacy %-based
  // fields below. NULL = legacy behavior (percent SL/TP + riskPercent sizing),
  // preserving existing installs until the user saves the new form.
  /** Spot: notional per trade. Futures: MARGIN per trade (notional = × leverage). */
  tradeAmountUsdt: numeric("trade_amount_usdt", { precision: 12, scale: 2 }),
  /** Max dollars to lose on one trade (net of fees). */
  maxLossUsdt: numeric("max_loss_usdt", { precision: 12, scale: 2 }),
  /** Desired dollar profit for one trade (net of fees). */
  targetProfitUsdt: numeric("target_profit_usdt", { precision: 12, scale: 2 }),

  /** % of account balance to risk per trade */
  riskPercent: numeric("risk_percent", { precision: 5, scale: 2 }).notNull().default("1.0"),
  /** Minimum confidence score to enter (0–100) */
  confidenceThreshold: integer("confidence_threshold").notNull().default(65),
  /** Stop-loss distance as a % below entry price (Phase 5A — replaces atr_multiplier_sl) */
  stopLossPercent: numeric("stop_loss_percent", { precision: 5, scale: 2 }).notNull().default("1.5"),
  /** Take-profit distance as a % above entry price (Phase 5A — replaces atr_multiplier_tp) */
  takeProfitPercent: numeric("take_profit_percent", { precision: 5, scale: 2 }).notNull().default("2.5"),
  /** Maximum seconds to hold a position before forced exit */
  maxHoldingSeconds: integer("max_holding_seconds").notNull().default(3600),
  /** Max concurrent open positions for this strategy */
  maxConcurrentPositions: integer("max_concurrent_positions").notNull().default(2),
  /** Cooldown minutes after an exit before re-entering the same symbol */
  cooldownMinutes: integer("cooldown_minutes").notNull().default(30),

  // ── Phase 4B: professional trade management ─────────────────────────────
  /** Pre-TP1 break-even arm: when unrealized profit reaches this many R
   *  (× the entry→SL distance), the stop moves to the entry price even
   *  BEFORE TP1 fills — a trade that entered the profit zone can no longer
   *  turn into a loss. 0 disables (break-even then arms only via TP1). */
  breakEvenRMultiple: numeric("break_even_r_multiple", { precision: 5, scale: 2 }).notNull().default("0"),
  /** R-multiple (× the entry→SL distance) at which TP1 partial-closes. 0 disables TP1/BE/trailing entirely — reduces to the original single-TP behavior. */
  tp1RMultiple: numeric("tp1_r_multiple", { precision: 5, scale: 2 }).notNull().default("1.0"),
  /** % of the original position closed at TP1 (1-99). */
  tp1ClosePercent: integer("tp1_close_percent").notNull().default(50),
  /** If true, a third scale-out level is used: TP1 → TP2 (partial) → TP3 (final, remainder). If false, TP1 → existing takeProfit column (final, remainder). */
  tp3Enabled: boolean("tp3_enabled").notNull().default(false),
  /** R-multiple for TP2 (only used when tp3Enabled). */
  tp2RMultiple: numeric("tp2_r_multiple", { precision: 5, scale: 2 }).notNull().default("2.0"),
  /** % of the *original* position closed at TP2 (only used when tp3Enabled). */
  tp2ClosePercent: integer("tp2_close_percent").notNull().default(25),
  /** R-multiple for TP3 / final target (only used when tp3Enabled — otherwise the existing takeProfitPercent-derived takeProfit is the final target). */
  tp3RMultiple: numeric("tp3_r_multiple", { precision: 5, scale: 2 }).notNull().default("4.0"),
  /** Trailing stop mode, applied to the post-TP1 remainder. */
  trailingStopMode: text("trailing_stop_mode").notNull().default("none"), // none|atr|percent|dynamic
  /** ATR multiplier for the trailing distance, when trailingStopMode = "atr" or "dynamic". */
  trailingStopAtrMultiplier: numeric("trailing_stop_atr_multiplier", { precision: 4, scale: 2 }).notNull().default("1.5"),
  /** Trailing distance as % of price, when trailingStopMode = "percent". */
  trailingStopPercent: numeric("trailing_stop_percent", { precision: 5, scale: 2 }).notNull().default("1.0"),
  /** Only start trailing once TP1 has filled (recommended — locks in the BE move first). */
  trailingAfterTp1Only: boolean("trailing_after_tp1_only").notNull().default(true),
  /** Emergency trailing: if unrealized profit reaches this R-multiple before TP1 would normally arm trailing, tighten the stop anyway rather than risk giving the whole move back. 0 disables. */
  emergencyTrailingRMultiple: numeric("emergency_trailing_r_multiple", { precision: 5, scale: 2 }).notNull().default("3.0"),
  /** Emergency trailing distance as % of price (kept tighter than the normal trailing distance). */
  emergencyTrailingPercent: numeric("emergency_trailing_percent", { precision: 5, scale: 2 }).notNull().default("0.5"),
  /** Order in which exit conditions are checked when more than one could apply on the same bar.
   *  Comma-separated subset/permutation of: stop_loss,take_profit,trailing_stop,timeout */
  exitPriority: text("exit_priority").notNull().default("stop_loss,take_profit,trailing_stop,timeout"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("strategy_configs_user_id_strategy_id_unique").on(t.userId, t.strategyId),
]);

export const insertStrategyConfigSchema = createInsertSchema(strategyConfigsTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertStrategyConfig = z.infer<typeof insertStrategyConfigSchema>;
export type StrategyConfigRow = typeof strategyConfigsTable.$inferSelect;
