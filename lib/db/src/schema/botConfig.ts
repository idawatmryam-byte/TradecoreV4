import { pgTable, serial, numeric, integer, boolean, text, timestamp, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botConfigTable = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  /** Owning user. */
  userId: integer("user_id").notNull(),
  /**
   * Which independent trading SECTION this config belongs to. Crypto (Binance)
   * and Forex (OANDA) are fully separate, simultaneously-runnable sections —
   * each has its own config row, strategies, positions, and on/off switch.
   * One row per (userId, section). Existing rows backfill to "crypto".
   */
  section: text("section").notNull().default("crypto"), // crypto | forex
  /**
   * Which broker/venue this section trades through. "binance" (crypto spot/
   * futures via ccxt) or "oanda" (forex via the OANDA v20 REST adapter).
   * Selects the adapter + credential source; orthogonal to marketType.
   */
  broker: text("broker").notNull().default("binance"), // binance | oanda

  // ── Execution target and mode ──────────────────────────────────────────────
  /**
   * WHERE approved TradePlans get executed:
   *   "demo" — TradeCore's own simulation. No broker, no API keys, no real
   *            money. Uses live market data and the SAME fill model the
   *            backtest runs (execution/fillModel.ts), so a demo fill and a
   *            backtest fill mean the same thing.
   *   "live" — real orders through the connected broker.
   *
   * Defaults to "demo": a brand-new account can trade within minutes of
   * signing up, and reaching real money is a deliberate choice rather than the
   * only option. Existing rows backfill to "live" — see the migration note in
   * P3: nobody who was already trading for real gets silently moved to paper.
   */
  executionTarget: text("execution_target").notNull().default("live"), // demo | live
  /**
   * WHAT happens once a TradePlan exists:
   *   "autopilot" — execute it automatically (today's behaviour).
   *   "copilot"   — record it as a recommendation for the user to approve.
   *   "research"  — never execute; analysis surfaces only.
   *
   * The intelligence pipeline is identical in all three; only the executor
   * differs.
   *
   * The COLUMN default stays "autopilot" so existing rows backfill to the
   * behaviour they already had — an account that was auto-trading keeps
   * auto-trading. NEW sections are created in "copilot" (see
   * BotEngine.loadConfig): a fresh account should show its reasoning and let
   * the human decide before it is trusted to act alone.
   */
  mode: text("mode").notNull().default("autopilot"), // research | copilot | autopilot
  /**
   * Per-position management policy selected at entry time. Ownership is then
   * persisted on the trade so a later config edit cannot make two managers
   * race over an already-open position.
   *
   * fixed          — legacy TradeManager owns mutations.
   * phase7_shadow  — Phase 7 records proposals; fixed remains the owner.
   * phase7_active  — Phase 7 owns mutations, permitted only for Demo or a
   *                  broker sandbox (Binance testnet / OANDA practice).
   */
  positionManagementMode: text("position_management_mode").notNull().default("fixed"),
  /**
   * Virtual starting balance for the demo account. The live balance is read
   * from the broker; a demo account has no broker, so its balance is this plus
   * the realised P&L of its closed demo trades — always consistent with the
   * trade log by construction, with no counter to drift out of sync.
   */
  demoStartingBalanceUsdt: numeric("demo_starting_balance_usdt", { precision: 14, scale: 2 }).notNull().default("10000"),

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
  /**
   * Max NOTIONAL (entry price × qty) allowed in a single symbol at once, as a
   * % of balance — aggregated across any existing position(s) in that symbol
   * plus the candidate. Distinct from maxPortfolioRiskPercent, which caps
   * aggregate worst-case $ LOSS (risk), not capital concentration: a single
   * large position can respect the risk cap yet still put most of the
   * account's capital behind one symbol. Defaults permissive (100% — i.e. no
   * effective limit beyond what other gates already allow) so existing users
   * are unaffected until they opt in to a tighter value.
   */
  maxSymbolConcentrationPercent: numeric("max_symbol_concentration_percent", { precision: 6, scale: 2 }).notNull().default("100.0"),
  /**
   * Max NET directional exposure (Σ long notional − Σ short notional,
   * absolute value) across all open positions, as a % of balance. Guards
   * against a string of same-direction entries across different symbols
   * quietly building one large correlated directional bet. Only bites on
   * markets where shorting is possible (futures/forex) — spot is long-only,
   * so its net exposure is just its gross exposure. Defaults permissive
   * (200% — i.e. no effective limit) so existing users are unaffected until
   * they opt in to a tighter value.
   */
  maxNetExposurePercent: numeric("max_net_exposure_percent", { precision: 6, scale: 2 }).notNull().default("200.0"),
  /**
   * Max NOTIONAL allowed across one CORRELATED cluster — the candidate plus
   * every open position measured to be the same directional bet — as a % of
   * balance. The gate the other three miss: five "independent" longs across
   * correlated majors is one large position wearing a disguise, and no count,
   * per-symbol or net-direction cap notices it. Defaults permissive (200%)
   * so existing users and the harness are unaffected until they opt in.
   */
  maxCorrelatedExposurePercent: numeric("max_correlated_exposure_percent", { precision: 6, scale: 2 }).notNull().default("200.0"),
  /**
   * Reinforcement level (r adjusted for trade direction) at which two symbols
   * count as the same bet. 0.7 is the conventional "strongly correlated"
   * line; below ~0.5 almost everything in crypto would cluster together and
   * the gate would stop being informative.
   */
  correlationThreshold: numeric("correlation_threshold", { precision: 4, scale: 3 }).notNull().default("0.700"),
  /**
   * What to do when a pair has too little shared history to measure:
   * "allow" (default — a new account has no history yet and must stay
   * tradable) or "block" (never trade blind). Never silently treated as
   * uncorrelated, which would be an unearned claim of independence.
   */
  correlationUnknownPolicy: text("correlation_unknown_policy").notNull().default("allow"),

  // ── Signal / confidence ────────────────────────────────────────────────────
  confidenceThreshold: integer("confidence_threshold").notNull().default(55),

  // ── Gated memory influence ────────────────────────────────────────────────
  /**
   * Whether the account's own trade history may raise the bar on new plans.
   *
   * Defaults FALSE and backfills FALSE — this is the only setting in the
   * product that lets past results change future decisions, and no existing
   * account may acquire that behaviour by deploying a new version. Off, the
   * engine is byte-identical to one built without the feature.
   *
   * Memory can only ever WITHHOLD a trade. It cannot loosen a gate and cannot
   * originate a plan, so the worst case of a bad rule is a missed trade.
   */
  memoryInfluenceEnabled: boolean("memory_influence_enabled").notNull().default(false),
  /**
   * Hard cap, in confidence points, on how far memory may raise any plan's
   * bar. Applied after summing every matching cell, so no stack of dimensions
   * can reach past it. 10 points on a 0–100 score is a meaningful filter and
   * a long way from an off switch.
   */
  memoryInfluenceMaxDelta: numeric("memory_influence_max_delta", { precision: 5, scale: 2 }).notNull().default("10.0"),
  /**
   * The state version a passing walk-forward validation approved. Live
   * influence requires this to match the state currently in force; a refit
   * that changes the rules therefore revokes the permission automatically
   * instead of inheriting approval it never earned. Demo needs no approval —
   * that is the paper-first rollout.
   */
  memoryInfluenceApprovedVersion: text("memory_influence_approved_version"),

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
  /** "spot" (long-only, buy-to-open) | "futures" (long+short, leveraged) |
   *  "forex" (OANDA units with attached bracket SL/TP, no perp leverage). */
  marketType: text("market_type").notNull().default("spot"), // spot | futures | forex
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

  /**
   * Has the user deliberately set this section up?
   *
   * A row here is created LAZILY — the first read of a section's config
   * materialises it, including merely opening the Add Market flow and backing
   * out again. So "a row exists" is emphatically not "the user chose this
   * market", and the navigation cannot be driven off row existence. This is
   * the explicit signal, written when configuration actually is.
   *
   * The default is `true` on purpose, and it is a BACKFILL default rather than
   * a creation default: every row predating this column belongs to a real user
   * with a real section, and they must not lose a tab they have been using.
   * Newly created rows pass `activated: false` explicitly — see
   * `botEngine.ts`'s insert.
   */
  activated: boolean("activated").notNull().default(true),

  /** Persisted so a process restart can't silently clear a manual-reset-required pause. */
  riskPaused: boolean("risk_paused").notNull().default(false),
  riskViolationCount: integer("risk_violation_count").notNull().default(0),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("bot_config_user_section_unique").on(t.userId, t.section),
  check(
    "bot_config_position_management_mode_check",
    sql`${t.positionManagementMode} IN ('fixed', 'phase7_shadow', 'phase7_active')`,
  ),
]);

export const insertBotConfigSchema = createInsertSchema(botConfigTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type BotConfig = typeof botConfigTable.$inferSelect;
