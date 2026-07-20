/**
 * LIVE-ENGINE integration test — the missing counterpart to the backtest
 * harness. The backtest suite proves the STRATEGY logic; this proves the
 * LIVE EXECUTION path, where every production incident has actually lived
 * (orphaned stops, phantom positions, lost order tracking, bad P&L rows).
 *
 * It drives the REAL BotEngine / TradeManager / ExitManager code against a
 * scripted in-memory mock exchange (ccxt-shaped, spot), asserting the DB
 * rows, in-memory order tracking, and the mock's order book after every
 * stage of a trade's life:
 *
 *   S1  entry + exchange-side protection (OCO-fallback path)
 *   S2  stop-loss fill detection → close row, fees, cooldown, leg cleanup
 *   S3  TP1 partial close → partial-exit row, remaining qty, re-protection
 *   S4  restart reconciliation → order tracking rebuilt from the exchange
 *   S5  "no stop, no position" risk rule → failed SL placement flattens
 *
 * Needs the harness Postgres (bash harness/setup.sh). Skips cleanly when
 * DATABASE_URL is unset so the pure-test chain stays runnable anywhere.
 *
 * Run:  DATABASE_URL=... tsx harness/live-engine.test.ts   (exit 0 = pass)
 */
if (!process.env.DATABASE_URL) {
  console.log("live-engine test SKIPPED (no DATABASE_URL — run harness/setup.sh first)");
  process.exit(0);
}
process.env.CREDENTIALS_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.SESSION_SECRET ??= "live-engine-test-session-secret-123";

import { db, tradesTable, botConfigTable, tradePartialExitsTable, strategyConfigsTable, strategyDecisionsTable, tradeAnalysesTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { BotEngine } from "../src/lib/botEngine";
import { loadStrategyConfigs } from "../src/lib/strategyConfigLoader";
import type { StrategyConfig } from "../src/lib/strategies";

const USER = 990042; // isolated test user — wiped before and after

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
}
const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// Mock spot exchange — ccxt-shaped, deterministic. No OCO endpoint on
// purpose: that forces the engine down its independent-orders fallback,
// which is the richer path (per-leg cancel/replace logic).
// ---------------------------------------------------------------------------
interface MockOrder {
  id: string; market: string; type: string; side: string;
  qty: number; price?: number; stopPrice?: number;
  status: "open" | "closed" | "canceled"; average?: number;
}

class MockSpotExchange {
  price = 100;
  usdt = 10_000;
  base = 0; // BTC holdings
  orders = new Map<string, MockOrder>();
  private seq = 1;
  failNextStopPlacement = false;

  markets: Record<string, any> = {
    "BTC/USDT": {
      id: "BTCUSDT", symbol: "BTC/USDT", active: true,
      precision: { price: 2, amount: 6 }, limits: { amount: { min: 0.000001 } },
    },
  };

  market(sym: string) { return this.markets[sym]; }
  amountToPrecision(_s: string, a: number) { return a.toFixed(6); }
  priceToPrecision(_s: string, p: number) { return p.toFixed(2); }
  async loadMarkets() { return this.markets; }
  async fetchBalance() {
    return { USDT: { free: this.usdt, used: 0, total: this.usdt }, free: { USDT: this.usdt }, total: { USDT: this.usdt, BTC: this.base } };
  }
  async fetchTicker(_m: string) { return { last: this.price, close: this.price, bid: this.price, ask: this.price, timestamp: Date.now() }; }
  async fetchTickers(ms: string[]) { const out: any = {}; for (const m of ms) out[m] = await this.fetchTicker(m); return out; }
  async fetchOHLCV() { return []; }
  async fetchMyTrades() { return []; }
  async fetchOpenOrders(market?: string) {
    return [...this.orders.values()].filter((o) => o.status === "open" && (!market || o.market === market))
      .map((o) => ({ id: o.id, symbol: o.market, type: o.type, side: o.side, amount: o.qty, price: o.price, info: { stopPrice: o.stopPrice } }));
  }
  async fetchPositions() { return []; }

  async createOrder(market: string, type: string, side: string, qty: number, price?: number, _params?: any) {
    if (type === "market") {
      const fill = this.price;
      if (side === "buy") { this.base += qty; this.usdt -= qty * fill; }
      else { this.base -= qty; this.usdt += qty * fill; }
      const id = String(this.seq++);
      const o: MockOrder = { id, market, type, side, qty, status: "closed", average: fill };
      this.orders.set(id, o);
      return { id, average: fill, price: fill, filled: qty, status: "closed" };
    }
    if (type === "stop_loss_limit" && this.failNextStopPlacement) {
      this.failNextStopPlacement = false;
      throw new Error("mock: stop placement rejected (-4045 style)");
    }
    const id = String(this.seq++);
    const o: MockOrder = { id, market, type, side, qty, price, stopPrice: _params?.stopPrice, status: "open" };
    this.orders.set(id, o);
    return { id, status: "open", price };
  }

  async cancelOrder(id: string, _m?: string) {
    const o = this.orders.get(id);
    if (!o) throw new Error("mock: unknown order");
    if (o.status !== "open") throw new Error("mock: order already resolved");
    o.status = "canceled";
    return { id, status: "canceled" };
  }

  async fetchOrder(id: string, _m?: string) {
    const o = this.orders.get(id);
    if (!o) throw new Error("mock: unknown order");
    return { id, status: o.status === "closed" ? "closed" : o.status, average: o.average, price: o.average ?? o.price, amount: o.qty };
  }

  /** Move the market — resting protective orders fill like the real venue. */
  setPrice(p: number) {
    this.price = p;
    for (const o of this.orders.values()) {
      if (o.status !== "open") continue;
      if (o.type === "limit" && o.side === "sell" && p >= (o.price ?? Infinity)) {
        o.status = "closed"; o.average = o.price; this.base -= o.qty; this.usdt += o.qty * (o.price ?? p);
      } else if (o.type === "stop_loss_limit" && o.side === "sell" && o.stopPrice != null && p <= o.stopPrice) {
        o.status = "closed"; o.average = o.stopPrice; this.base -= o.qty; this.usdt += o.qty * o.stopPrice;
      }
    }
  }

  openOrdersFor(market: string) { return [...this.orders.values()].filter((o) => o.status === "open" && o.market === market); }
}

// ---------------------------------------------------------------------------
// Helpers to drive the engine's private surface deliberately (test-only).
// ---------------------------------------------------------------------------
function primeEngine(engine: BotEngine, mock: MockSpotExchange) {
  const e = engine as any;
  e.exchange = mock;
  e.activeMarketType = "spot";
  e.availableMarkets = new Set(Object.keys(mock.markets));
}

function candles(price: number, high = price, low = price): Array<[number, number, number, number, number, number]> {
  const now = Date.now();
  return Array.from({ length: 30 }, (_, i) => [now - (30 - i) * 60_000, price, high, low, price, 10]);
}

const baseRow = { confidence: 70, regime: "trend", adx: 30, macroBullish: true, votes: [] as any[] };

function plan(over: Partial<Record<string, unknown>> = {}) {
  return {
    strategyId: "trend_pullback", strategyName: "Trend Pullback", side: "long",
    entryPrice: 100, slPrice: 95, tpPrice: 110, qty: 1, leverage: 1,
    confidence: 70, expectedHoldSeconds: 1200, maxHoldSeconds: 7200,
    report: { summary: "live-engine test plan" },
    ...over,
  };
}

async function cleanup() {
  const ids = (await db.select({ id: tradesTable.id }).from(tradesTable).where(eq(tradesTable.userId, USER))).map((t) => t.id);
  if (ids.length) await db.delete(tradePartialExitsTable).where(inArray(tradePartialExitsTable.tradeId, ids));
  await db.delete(tradeAnalysesTable).where(eq(tradeAnalysesTable.userId, USER));
  await db.delete(tradesTable).where(eq(tradesTable.userId, USER));
  await db.delete(strategyDecisionsTable).where(eq(strategyDecisionsTable.userId, USER));
  await db.delete(strategyConfigsTable).where(eq(strategyConfigsTable.userId, USER));
  await db.delete(botConfigTable).where(eq(botConfigTable.userId, USER));
}

async function openTrade(engineAny: any, config: any, stratConfig: StrategyConfig, p = plan()) {
  const res = await engineAny.enterTrade("BTCUSDT", { ...baseRow }, p, config, new Date(), stratConfig);
  const [trade] = await db.select().from(tradesTable)
    .where(and(eq(tradesTable.userId, USER), eq(tradesTable.status, "open")));
  return { res, trade };
}

async function main() {
  await cleanup();

  const mock = new MockSpotExchange();
  const engine = new BotEngine(USER, "crypto");
  primeEngine(engine, mock);
  const e = engine as any;
  const config = await engine.loadConfig();

  const configs = await loadStrategyConfigs(USER, "crypto");
  // Deterministic management config: no ladder/trailing for S1/S2.
  const pure: StrategyConfig = {
    ...configs.get("trend_pullback")!,
    tp1RMultiple: 0, tp3Enabled: false, trailingStopMode: "none",
    emergencyTrailingRMultiple: 0, breakEvenRMultiple: 0, cooldownMinutes: 5,
  };

  // ── S1: entry + protection ────────────────────────────────────────────────
  console.log("\n— S1: entry places position + exchange-side TP & SL —");
  const { res: r1, trade: t1 } = await openTrade(e, config, pure);
  expect("entry reports entered", r1.entered === true, r1.reason);
  expect("trade row is open/spot/crypto", !!t1 && t1.status === "open" && t1.marketType === "spot" && t1.section === "crypto");
  expect("entry price = fill price 100", Number(t1!.entryPrice) === 100);
  expect("planned SL/TP preserved", Number(t1!.plannedStopLoss) === 95 && Number(t1!.plannedTakeProfit) === 110);
  const ids1 = e.openOrderIds.get(t1!.id);
  expect("order tracking has both legs", !!ids1?.slOrderId && !!ids1?.tpOrderId);
  expect("mock holds 2 resting orders (TP limit + SL stop)", mock.openOrdersFor("BTC/USDT").length === 2);
  expect("mock position = 1 BTC", approx(mock.base, 1, 1e-9));

  // ── S2: stop-loss fills on the venue → engine detects, closes, cleans ────
  console.log("\n— S2: SL fill detection, P&L accounting, leg cleanup —");
  mock.setPrice(94); // breaches stop 95 → mock fills the stop order at 95
  await e.checkExitCondition(t1!, candles(94), new Date(Date.now() + 60_000), 5, undefined, pure);
  const [closed1] = await db.select().from(tradesTable).where(eq(tradesTable.id, t1!.id));
  expect("trade closed", closed1!.status === "closed");
  expect("exit reason = stop_loss", closed1!.exitReason === "stop_loss", String(closed1!.exitReason));
  expect("exit price = 95", Number(closed1!.exitPrice) === 95);
  const pnl1 = Number(closed1!.pnl);
  // gross −5 minus taker fees both legs (0.1% × (100 + 95) ≈ 0.195)
  expect("pnl ≈ −5.195 (gross −5 − fees)", approx(pnl1, -5.195, 0.05), `pnl=${pnl1}`);
  expect("remaining TP leg canceled on venue", mock.openOrdersFor("BTC/USDT").length === 0);
  expect("order tracking cleared", !e.openOrderIds.get(t1!.id));
  expect("mock position flat", approx(mock.base, 0, 1e-9));
  expect("symbol on cooldown after loss", e.isOnCooldown("BTCUSDT") === true);
  e.symbolCooldowns.clear();

  // ── S3: TP1 partial close + re-protection of the remainder ───────────────
  console.log("\n— S3: TP1 partial → partial-exit row, remaining qty re-protected —");
  const ladder: StrategyConfig = { ...pure, tp1RMultiple: 1, tp1ClosePercent: 50, breakEvenRMultiple: 0 };
  mock.setPrice(100);
  const { trade: t3 } = await openTrade(e, config, ladder); // R=5 → TP1 at 105 for half
  expect("TP1 level recorded at 105 for 0.5", Number(t3!.tp1Price) === 105 && approx(Number(t3!.tp1Quantity), 0.5, 1e-6));
  mock.setPrice(105.2); // trade through TP1 (mock fills nothing itself: TP1 is tick-checked by TradeManager, final TP 110 not reached)
  await e.checkExitCondition(t3!, candles(105.2, 105.3, 104.9), new Date(Date.now() + 120_000), 5, undefined, ladder);
  const [after3] = await db.select().from(tradesTable).where(eq(tradesTable.id, t3!.id));
  const partials = await db.select().from(tradePartialExitsTable).where(eq(tradePartialExitsTable.tradeId, t3!.id));
  expect("still open after partial", after3!.status === "open");
  expect("TP1 marked filled", after3!.tp1Filled === true);
  expect("remaining quantity halved", approx(Number(after3!.remainingQuantity), 0.5, 1e-6));
  expect("one partial-exit row with profit", partials.length === 1 && Number(partials[0]!.pnl) > 0, JSON.stringify(partials.map(p => p.pnl)));
  const restingAfterTp1 = mock.openOrdersFor("BTC/USDT");
  expect("remainder re-protected on venue (SL present)", restingAfterTp1.some((o) => o.type === "stop_loss_limit"), JSON.stringify(restingAfterTp1.map(o => o.type)));
  const ids3 = e.openOrderIds.get(t3!.id);
  expect("tracking updated to new legs", !!ids3?.slOrderId);

  // close it out via the stop for cleanliness
  mock.setPrice(94);
  await e.checkExitCondition(after3!, candles(94), new Date(Date.now() + 240_000), 5, undefined, ladder);
  const [closed3] = await db.select().from(tradesTable).where(eq(tradesTable.id, t3!.id));
  expect("second leg closed via stop", closed3!.status === "closed");
  expect("mock flat after full lifecycle", approx(mock.base, 0, 1e-6), `base=${mock.base}`);
  e.symbolCooldowns.clear();

  // ── S4: restart reconciliation rebuilds order tracking ───────────────────
  console.log("\n— S4: restart reconciliation (fresh engine, same venue state) —");
  mock.setPrice(100);
  const { trade: t4 } = await openTrade(e, config, pure);
  expect("setup: open trade with resting legs", mock.openOrdersFor("BTC/USDT").length === 2);
  const engine2 = new BotEngine(USER, "crypto");
  primeEngine(engine2, mock);
  const e2 = engine2 as any;
  expect("fresh engine starts with empty tracking", !e2.openOrderIds.get(t4!.id));
  await e2.reconcileOnStartup("spot");
  const [still4] = await db.select().from(tradesTable).where(eq(tradesTable.id, t4!.id));
  expect("reconcile keeps genuinely-open trade open", still4!.status === "open");
  const rebuilt = e2.openOrderIds.get(t4!.id);
  expect("tracking rebuilt from venue orders", !!rebuilt?.slOrderId, JSON.stringify(rebuilt));
  // clean close
  mock.setPrice(94);
  await e2.checkExitCondition(still4!, candles(94), new Date(Date.now() + 300_000), 0, undefined, pure);

  // ── S5: "no stop, no position" — failed SL placement flattens ────────────
  console.log("\n— S5: SL placement failure → immediate flatten (no stop, no position) —");
  mock.setPrice(100);
  mock.failNextStopPlacement = true;
  const res5 = await (engine as any).enterTrade("BTCUSDT", { ...baseRow }, plan(), config, new Date(), pure);
  expect("entry refused overall", res5.entered === false, res5.reason);
  expect("reason explains the flatten", /stop-loss placement failed/i.test(res5.reason), res5.reason);
  const rows5 = await db.select().from(tradesTable).where(and(eq(tradesTable.userId, USER), eq(tradesTable.status, "open")));
  expect("no open trade left in DB", rows5.length === 0);
  expect("mock position flat (was flattened)", approx(mock.base, 0, 1e-6), `base=${mock.base}`);
  expect("no resting orders left behind", mock.openOrdersFor("BTC/USDT").length === 0, JSON.stringify(mock.openOrdersFor("BTC/USDT")));

  await cleanup();

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll live-engine checks passed.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
