import { pgTable, serial, numeric, integer, boolean, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botConfigTable = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  /** One config row per user — each user's bot instance has its own settings. */
  userId: integer("user_id").notNull(),

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

  // ── Risk model: how SL/TP are decided ──────────────────────────────────────
  /**
   * "percent" (legacy): SL/TP are a % distance of PRICE from entry (the
   *   stopLossPercent/takeProfitPercent below), and position size comes from
   *   riskPercent/positionSizeUsdt.
   * "dollar": the user instead states a fixed MAX DOLLAR LOSS and a DESIRED
   *   DOLLAR PROFIT per trade; the engine derives the SL price, TP price and
   *   the exact price-distance %s from those dollar amounts and the position's
   *   notional (positionSizeUsdt for spot, positionSizeUsdt × leverage for
   *   futures). See lib/dollarRisk.ts — one planner shared by live + backtest.
   */
  riskModel: text("risk_model").notNull().default("percent"), // percent | dollar

  // ── Stop-loss / take-profit (Phase 5A: percentage-based, replaces ATR) ─────
  /** Stop-loss distance as a % below entry price (used when riskModel = "percent"). */
  stopLossPercent: numeric("stop_loss_percent", { precision: 5, scale: 2 }).notNull().default("1.5"),
  /** Take-profit distance as a % above entry price (used when riskModel = "percent"). */
  takeProfitPercent: numeric("take_profit_percent", { precision: 5, scale: 2 }).notNull().default("2.5"),

  // ── Dollar-based risk model (used when riskModel = "dollar") ────────────────
  /** Maximum dollars the user is willing to LOSE on one trade (net of fees). */
  maxLossUsdt: numeric("max_loss_usdt", { precision: 12, scale: 2 }).notNull().default("5"),
  /** Desired dollar PROFIT target for one trade (net of fees). */
  targetProfitUsdt: numeric("target_profit_usdt", { precision: 12, scale: 2 }).notNull().default("10"),

  // ── Trade cooldown ─────────────────────────────────────────────────────────
  /** Minutes to wait before re-entering a symbol after an exit */
  cooldownMinutes: integer("cooldown_minutes").notNull().default(30),

  // ── Engine / scan ─────────────────────────────────────────────────────────
  scanIntervalSeconds: integer("scan_interval_seconds").notNull().default(15),
  pairs: text("pairs").notNull().default("BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,MATICUSDT,LINKUSDT"),
  testnet: boolean("testnet").notNull().default(true),
  backtestMode: boolean("backtest_mode").notNull().default(false),

  /**
   * High-frequency TEST mode (testnet/demo only — the engine ignores this flag
   * on live keys). When on, the live engine overrides its turnover-limiting
   * gates to generate a high volume of trades for end-to-end testing: no
   * post-trade cooldown, no confidence floor, no toxic-hour skips, a very high
   * open-position cap, the daily-loss circuit breaker effectively disabled, and
   * every strategy's max holding time capped short so positions cycle quickly.
   * This is for shaking out bugs and producing data on Demo Trading — it is NOT
   * a profitable trading configuration and has no effect on real-money keys.
   */
  highFrequencyTestMode: boolean("high_frequency_test_mode").notNull().default(false),

  // ── Futures trading (long + short) ─────────────────────────────────────────
  /** "spot" (long-only, buy-to-open) | "futures" (long+short, leveraged). */
  marketType: text("market_type").notNull().default("spot"), // spot | futures
  /** Only applies when marketType = "futures". 1 = no leverage. Binance USDⓈ-M caps vary by symbol (often up to 125x) — the app enforces its own lower safety cap, see lib/env.ts / routes/config.ts. */
  leverage: integer("leverage").notNull().default(1),
  /** Only applies when marketType = "futures". isolated: only that position's margin is at risk of liquidation. cross: the whole futures wallet backs every position — one bad position can drag down others. */
  marginMode: text("margin_mode").notNull().default("isolated"), // isolated | cross

  /** Phase 2.5: Discord / Telegram / Slack incoming-webhook URL for risk alerts */
  alertWebhookUrl: text("alert_webhook_url"),

  /**
   * Desired engine state, persisted: true after a successful Start, false
   * after Stop. On server boot (pm2 restart, update.sh, reboot) every user
   * whose flag is true has their engine auto-resumed — previously each
   * deploy silently stopped all trading until every user pressed START
   * again, which read as "the engine stopped making trades".
   */
  engineDesiredRunning: boolean("engine_desired_running").notNull().default(false),

  /** Persisted so a process restart can't silently clear a manual-reset-required pause. */
  riskPaused: boolean("risk_paused").notNull().default(false),
  riskViolationCount: integer("risk_violation_count").notNull().default(0),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("bot_config_user_id_unique").on(t.userId),
]);

export const insertBotConfigSchema = createInsertSchema(botConfigTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type BotConfig = typeof botConfigTable.$inferSelect;
