import { pgTable, serial, text, numeric, integer, timestamp, index, jsonb, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Execution intents + events — the durable record of "we are about to place a
// real order", written BEFORE the broker is called.
//
// The gap this closes: enterTrade() places the market order and only then
// writes the trades row. Between those two awaits the process can die, and
// what is left behind is a real, funded, unprotected position that the
// database has never heard of. reconcileOnStartup() can find the POSITION,
// but it cannot recover the INTENT — it has no way to know what stop-loss and
// take-profit that fill was supposed to be protected by, or which strategy
// asked for it. So it adopts an orphan with no plan.
//
// With an intent row written first, a crash leaves a breadcrumb that names the
// client order id, the planned SL/TP/qty, and the originating plan — enough to
// either reconcile the position onto its intended protection or flatten it
// deliberately.
//
// `executionEventsTable` is append-only: every state transition is a new row,
// never an update. `executionIntentsTable.state` is the current-state
// projection, kept in step so the common lookup is one indexed read.
// ---------------------------------------------------------------------------

/**
 * Execution lifecycle. Forward-only — a terminal state is never left.
 *
 *   INTENT_RECORDED  persisted; nothing has been sent to the broker yet
 *   ORDER_SUBMITTED  broker call made; outcome NOT yet known (the danger zone)
 *   FILLED           fill confirmed, position exists on the venue
 *   RECORDED         trades row written — the engine now tracks the position
 *   PROTECTED        exchange-side SL (and usually TP) resting; terminal-good
 *   FLATTENED        filled, then deliberately closed by a risk guard
 *   FAILED           broker rejected or errored; no position expected
 *   ABANDONED        refused before any order was sent
 */
export const EXECUTION_STATES = [
  "INTENT_RECORDED",
  "ORDER_SUBMITTED",
  "FILLED",
  "RECORDED",
  "PROTECTED",
  "FLATTENED",
  "FAILED",
  "ABANDONED",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

/** States after which a real position may exist on the venue. */
export const POSITION_MAY_EXIST: ReadonlyArray<ExecutionState> = [
  "ORDER_SUBMITTED",
  "FILLED",
  "RECORDED",
];

export const executionIntentsTable = pgTable("execution_intents", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  /** Independent trading section (crypto | forex). */
  section: text("section").notNull().default("crypto"),

  /**
   * The join key for this trade's whole life: plan → execution → trade →
   * outcome. Stamped once here, at the seam where a decision becomes an
   * order, and copied onto the trades row. Cannot be backfilled onto rows
   * written before it existed, which is why it lands this early.
   */
  correlationId: text("correlation_id").notNull(),

  /**
   * The id sent to the broker as its own order reference (Binance
   * `newClientOrderId`). After a timeout this is how the order is looked up
   * rather than blindly resubmitted — resubmitting a market order that may
   * already have filled doubles the position.
   */
  clientOrderId: text("client_order_id").notNull(),

  /** SHA-256 of the TradePlan decision content (lib/plan/fingerprint.ts). */
  planFingerprint: text("plan_fingerprint").notNull(),

  symbol: text("symbol").notNull(),
  /** Order side that OPENS the position: "buy" | "sell". */
  side: text("side").notNull(),
  marketType: text("market_type").notNull(), // spot | futures | forex
  strategyId: text("strategy_id"),

  // The plan as it stood at submit time. This is the part reconciliation
  // cannot reconstruct from the venue, and the reason the row exists.
  plannedEntryPrice: numeric("planned_entry_price", { precision: 18, scale: 8 }).notNull(),
  plannedStopLoss: numeric("planned_stop_loss", { precision: 18, scale: 8 }).notNull(),
  plannedTakeProfit: numeric("planned_take_profit", { precision: 18, scale: 8 }).notNull(),
  plannedQuantity: numeric("planned_quantity", { precision: 18, scale: 8 }).notNull(),
  plannedLeverage: integer("planned_leverage"),

  /** Current-state projection of executionEventsTable. */
  state: text("state").notNull().default("INTENT_RECORDED"),
  /** Set once the trades row exists (state RECORDED onward). */
  tradeId: integer("trade_id"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("execution_intents_correlation_unique").on(t.correlationId),
  unique("execution_intents_client_order_unique").on(t.clientOrderId),
  // Startup recovery: "which intents could have left a live position?"
  index("execution_intents_user_state_idx").on(t.userId, t.state),
  index("execution_intents_user_created_idx").on(t.userId, t.createdAt),
]);

export const insertExecutionIntentSchema = createInsertSchema(executionIntentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertExecutionIntent = z.infer<typeof insertExecutionIntentSchema>;
export type ExecutionIntent = typeof executionIntentsTable.$inferSelect;

/** Append-only transition log. Never updated, never deleted. */
export const executionEventsTable = pgTable("execution_events", {
  id: serial("id").primaryKey(),
  intentId: integer("intent_id").notNull(),
  /** Null on the first row (nothing to transition from). */
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  /** Human-readable why — the broker error, the risk-guard verdict, etc. */
  reason: text("reason"),
  /** Structured detail: fill price, order ids, exchange response fragments. */
  payload: jsonb("payload"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("execution_events_intent_idx").on(t.intentId, t.occurredAt),
]);

export const insertExecutionEventSchema = createInsertSchema(executionEventsTable).omit({
  id: true,
  occurredAt: true,
});
export type InsertExecutionEvent = z.infer<typeof insertExecutionEventSchema>;
export type ExecutionEvent = typeof executionEventsTable.$inferSelect;
