import { pgTable, serial, numeric, integer, boolean, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botConfigTable = pgTable("bot_config", {
  id: serial("id").primaryKey(),

  // ── Position / risk ────────────────────────────────────────────────────────
  /** Fixed USDT position size — also acts as a hard cap when riskPercent > 0 */
  positionSizeUsdt: numeric("position_size_usdt", { precision: 10, scale: 2 }).notNull().default("10"),
  /** Risk % of account balance per trade (0 = use positionSizeUsdt only) */
  riskPercent: numeric("risk_percent", { precision: 5, scale: 2 }).notNull().default("1.0"),

  // ── Open positions / circuit breaker ──────────────────────────────────────
  maxOpenPositions: integer("max_open_positions").notNull().default(5),
  /** Maximum % of total balance across all open positions */
  maxPortfolioRiskPercent: numeric("max_portfolio_risk_percent", { precision: 5, scale: 2 }).notNull().default("10.0"),
  dailyLossLimitUsdt: numeric("daily_loss_limit_usdt", { precision: 10, scale: 2 }).notNull().default("10"),

  // ── Signal / confidence ────────────────────────────────────────────────────
  confidenceThreshold: integer("confidence_threshold").notNull().default(55),

  // ── Stop-loss / take-profit (Phase 5A: percentage-based, replaces ATR) ─────
  /** Stop-loss distance as a % below entry price */
  stopLossPercent: numeric("stop_loss_percent", { precision: 5, scale: 2 }).notNull().default("1.5"),
  /** Take-profit distance as a % above entry price */
  takeProfitPercent: numeric("take_profit_percent", { precision: 5, scale: 2 }).notNull().default("2.5"),

  // ── Trade cooldown ─────────────────────────────────────────────────────────
  /** Minutes to wait before re-entering a symbol after an exit */
  cooldownMinutes: integer("cooldown_minutes").notNull().default(30),

  // ── Engine / scan ─────────────────────────────────────────────────────────
  scanIntervalSeconds: integer("scan_interval_seconds").notNull().default(15),
  pairs: text("pairs").notNull().default("BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,MATICUSDT,LINKUSDT"),
  testnet: boolean("testnet").notNull().default(true),
  backtestMode: boolean("backtest_mode").notNull().default(false),

  /** Phase 2.5: Discord / Telegram / Slack incoming-webhook URL for risk alerts */
  alertWebhookUrl: text("alert_webhook_url"),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBotConfigSchema = createInsertSchema(botConfigTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type BotConfig = typeof botConfigTable.$inferSelect;
