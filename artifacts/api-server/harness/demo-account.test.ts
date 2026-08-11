/**
 * DEMO-ACCOUNT integration test — trading with no broker, no keys, no money.
 *
 * The headline assertion is what is ABSENT: there is no mock exchange in this
 * file. A live-path test needs one because the engine talks to a venue; the
 * demo path must not, and if a future change makes it reach for an exchange
 * handle this test fails by throwing rather than by silently passing.
 *
 * What it proves:
 *   1. Mode/target selection picks the right executor — the intelligence
 *      pipeline above the fork point is untouched.
 *   2. A demo entry produces a real `trades` row (so the whole product works
 *      on demo accounts) tagged executionTarget="demo" (so analytics can never
 *      present paper results as live ones).
 *   3. A demo position resolves through the SHARED fill model and settles
 *      through the SAME ExitManager accounting a live close uses.
 *   4. The virtual balance is derived from closed trades, so it cannot drift
 *      out of step with the trade log.
 *
 * REQUIRES a database. Part of `pnpm test:integration`.
 *
 * Run:  DATABASE_URL=... tsx harness/demo-account.test.ts   (exit 0 = pass)
 */
process.env.CREDENTIALS_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.SESSION_SECRET ??= "demo-account-test-session-secret-123";

import {
  db, tradesTable, botConfigTable, tradePartialExitsTable, strategyConfigsTable,
  strategyDecisionsTable, tradeAnalysesTable, executionIntentsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { BotEngine } from "../src/lib/botEngine";
import { simulateDemoExit } from "../src/lib/execution/demoExit";
import { loadStrategyConfigs } from "../src/lib/strategyConfigLoader";
import type { StrategyConfig } from "../src/lib/strategies";

const USER = 990044; // isolated test user — wiped before and after

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
}
const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

const T0 = new Date("2025-06-01T12:00:00Z");
const candles = (high: number, low: number, close: number, tMs = T0.getTime()) =>
  [[tMs, 100, high, low, close, 100]] as Array<[number, number, number, number, number, number]>;

function plan(over: Record<string, unknown> = {}) {
  return {
    strategyId: "trend_pullback", strategyName: "Trend Pullback", symbol: "BTCUSDT",
    side: "long", entryPrice: 100, slPrice: 95, tpPrice: 110, qty: 1, leverage: 1,
    confidence: 70, expectedHoldSeconds: 1200, maxHoldSeconds: 7200, regime: "trend",
    report: { summary: "demo test plan", marketView: [], entryLogic: [], riskLogic: [], exitLogic: [], checks: [] },
    ...over,
  } as any;
}

async function cleanup() {
  const ids = (await db.select({ id: tradesTable.id }).from(tradesTable).where(eq(tradesTable.userId, USER))).map((t) => t.id);
  if (ids.length) await db.delete(tradePartialExitsTable).where(inArray(tradePartialExitsTable.tradeId, ids));
  await db.execute(sql`SELECT capture.purge_user_data(${USER})`);
  await db.delete(executionIntentsTable).where(eq(executionIntentsTable.userId, USER));
  await db.delete(tradeAnalysesTable).where(eq(tradeAnalysesTable.userId, USER));
  await db.delete(tradesTable).where(eq(tradesTable.userId, USER));
  await db.delete(strategyDecisionsTable).where(eq(strategyDecisionsTable.userId, USER));
  await db.delete(strategyConfigsTable).where(eq(strategyConfigsTable.userId, USER));
  await db.delete(botConfigTable).where(eq(botConfigTable.userId, USER));
}

async function main() {
  await cleanup();

  const engine = new BotEngine(USER, "crypto");
  const e = engine as any;
  // NOTE: e.exchange is deliberately left undefined for this whole test.
  const config = await engine.loadConfig();
  await db.update(botConfigTable)
    .set({ executionTarget: "demo", demoStartingBalanceUsdt: "10000" })
    .where(and(eq(botConfigTable.userId, USER), eq(botConfigTable.section, "crypto")));
  const demoConfig = { ...config, executionTarget: "demo", mode: "autopilot" };
  e.executionTarget = "demo";

  const configs = await loadStrategyConfigs(USER, "crypto");
  const pure: StrategyConfig = {
    ...configs.get("trend_pullback")!,
    tp1RMultiple: 0, tp3Enabled: false, trailingStopMode: "none",
    emergencyTrailingRMultiple: 0, breakEvenRMultiple: 0, cooldownMinutes: 5,
  };

  // ── 1. Executor selection ────────────────────────────────────────────────
  console.log("\n— the fork point picks the executor from config —");
  expect("demo target selects the demo executor", e.resolveExecutor(demoConfig).kind === "demo");
  expect("live target selects the live executor", e.resolveExecutor({ ...demoConfig, executionTarget: "live" }).kind === "live");
  expect("research mode overrides the target entirely",
    e.resolveExecutor({ ...demoConfig, mode: "research" }).kind === "recommend");

  const researchResult = await e.resolveExecutor({ ...demoConfig, mode: "research" })
    .execute({ symbol: "BTCUSDT", plan: plan(), row: { confidence: 70 }, config: demoConfig, now: T0 });
  expect("research mode opens nothing", researchResult.entered === false);
  expect("research mode still explains itself", /Research mode/.test(researchResult.reason));

  // ── 2. Demo entry — no exchange involved ─────────────────────────────────
  console.log("\n— a demo entry fills without touching a venue —");
  const startBalance = await e.getDemoBalance();
  expect("virtual balance starts at the configured amount", approx(startBalance, 10_000, 1e-6), String(startBalance));

  const res = await e.resolveExecutor(demoConfig).execute({
    symbol: "BTCUSDT", plan: plan(), row: { confidence: 70 }, config: demoConfig, now: T0, stratConfig: pure,
  });
  expect("demo entry reports entered", res.entered === true, res.reason);
  expect("reason makes clear no real order was placed", /no real order/.test(res.reason), res.reason);
  expect("engine still has NO exchange handle", e.exchange === undefined || e.exchange === null);

  const [t1] = await db.select().from(tradesTable).where(eq(tradesTable.userId, USER));
  expect("a real trades row exists", !!t1);
  expect("tagged as a demo execution", t1!.executionTarget === "demo", String(t1!.executionTarget));
  expect("status open, section crypto", t1!.status === "open" && t1!.section === "crypto");
  expect("planned SL/TP preserved from the plan", Number(t1!.plannedStopLoss) === 95 && Number(t1!.plannedTakeProfit) === 110);
  // Entry slippage is adverse for a buy: filled at or above the signal price.
  expect("entry filled at or above the signal price (adverse slippage)", Number(t1!.entryPrice) >= 100, String(t1!.entryPrice));

  const [intent] = await db.select().from(executionIntentsTable).where(eq(executionIntentsTable.tradeId, t1!.id));
  expect("demo entries are recorded in the intent log too", !!intent);
  expect("demo intent reaches PROTECTED (fill model enforces SL/TP)", intent?.state === "PROTECTED", String(intent?.state));
  expect("correlation id links intent → demo trade", !!t1!.correlationId && t1!.correlationId === intent!.correlationId);

  // ── 3. Exit resolves through the shared fill model ───────────────────────
  console.log("\n— the position resolves through the shared fill model —");
  const stillOpen = await simulateDemoExit({
    trade: t1!, candles1m: candles(102, 99, 101), now: new Date(T0.getTime() + 60_000),
    cooldownMinutes: 5, stratConfig: pure, costs: e.fillCosts(), exitManager: e.exitManager,
  });
  expect("a quiet bar leaves the demo position open", stillOpen === false);

  const [reread] = await db.select().from(tradesTable).where(eq(tradesTable.id, t1!.id));
  expect("still open after the quiet bar", reread!.status === "open");
  expect("excursion tracked while open", Number(reread!.mfeUsdt ?? 0) > 0 || Number(reread!.maeUsdt ?? 0) < 0);

  const closed = await simulateDemoExit({
    trade: reread!, candles1m: candles(111, 100, 110, T0.getTime() + 120_000),
    now: new Date(T0.getTime() + 120_000),
    cooldownMinutes: 5, stratConfig: pure, costs: e.fillCosts(), exitManager: e.exitManager,
  });
  expect("a bar through the target closes the position", closed === true);

  const [final] = await db.select().from(tradesTable).where(eq(tradesTable.id, t1!.id));
  expect("trade is closed", final!.status === "closed", String(final!.status));
  expect("exit reason is take_profit", final!.exitReason === "take_profit", String(final!.exitReason));
  expect("exit price is at/below the target (adverse slippage on exit)", Number(final!.exitPrice) <= 110);
  expect("P&L recorded", final!.pnl != null);
  expect("net P&L is positive on a winner", Number(final!.pnl) > 0, String(final!.pnl));
  expect("fees were charged", Number(final!.feesUsdt ?? 0) > 0, String(final!.feesUsdt));

  // Settled through the same path a live close uses ⇒ the post-trade analysis
  // exists without demo needing its own.
  const [analysis] = await db.select().from(tradeAnalysesTable).where(eq(tradeAnalysesTable.tradeId, t1!.id));
  expect("post-trade analysis produced for the demo trade", !!analysis);
  expect("analysis graded it a win", analysis?.outcome === "win", String(analysis?.outcome));

  // ── 4. Virtual balance follows the trade log ─────────────────────────────
  console.log("\n— the virtual balance is derived, not stored —");
  const endBalance = await e.getDemoBalance();
  expect("balance moved by exactly the realised P&L",
    approx(endBalance, 10_000 + Number(final!.pnl), 1e-6),
    `${endBalance} vs ${10_000 + Number(final!.pnl)}`);

  await cleanup();
  console.log(failures === 0 ? "\nAll demo-account checks passed." : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
