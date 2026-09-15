/** Real PostgreSQL rollback and concurrent-writer regression; no broker calls. */
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { and, eq } from "drizzle-orm";

if (!process.env.DATABASE_URL) {
  console.log("demo-management-atomicity SKIPPED (no DATABASE_URL)");
  process.exit(0);
}

const { db, pool, tradesTable, tradePartialExitsTable } =
  await import("@workspace/db");
const { simulateDemoExit, DemoManagementConflictError } =
  await import("../src/lib/execution/demoExit");
const { DEFAULT_STRATEGY_CONFIGS } = await import("../src/lib/strategies");
type Trade = typeof tradesTable.$inferSelect;

const userId = randomInt(1_500_000_000, 2_000_000_000);
const [existing] = await db
  .select({ id: tradesTable.id })
  .from(tradesTable)
  .where(eq(tradesTable.userId, userId))
  .limit(1);
assert.equal(existing, undefined, "fixture identity must be unused");
const time = new Date("2026-08-01T12:00:00Z");
const [trade] = await db
  .insert(tradesTable)
  .values({
    userId,
    section: "crypto",
    symbol: "BTCUSDT",
    side: "buy",
    status: "open",
    executionTarget: "demo",
    executionAuthority: "simulated_demo",
    marketType: "spot",
    entryTime: time,
    entryPrice: "100",
    stopLoss: "95",
    plannedStopLoss: "95",
    takeProfit: "110",
    quantity: "1",
    remainingQuantity: "1",
    plannedQuantity: "1",
    confidence: "70",
    tp1Price: "105",
    tp1Quantity: "0.5",
  })
  .returning();
assert.ok(trade);
const mutableDb = db as any;
const originalTransaction = mutableDb.transaction;
let failInsert = false;
let settlements = 0;
mutableDb.transaction = (callback: (tx: any) => Promise<unknown>) =>
  originalTransaction.call(db, async (tx: any) =>
    callback(
      new Proxy(tx, {
        get(target, property) {
          if (property === "insert" && failInsert)
            return () => ({
              values: async () => {
                throw new Error(
                  "injected insert failure after projection update",
                );
              },
            });
          const member = Reflect.get(target, property);
          return typeof member === "function" ? member.bind(target) : member;
        },
      }),
    ),
  );
const config = {
  ...DEFAULT_STRATEGY_CONFIGS.trend_pullback!,
  strategyId: "trend_pullback",
  tp1RMultiple: 1,
  tp3Enabled: false,
  breakEvenRMultiple: 0,
  trailingStopMode: "none" as const,
  emergencyTrailingRMultiple: 0,
};
const args = {
  candles1m: [[time.getTime() + 60_000, 100.1, 106, 100.1, 105.5, 10]] as [
    number,
    number,
    number,
    number,
    number,
    number,
  ][],
  now: new Date(time.getTime() + 120_000),
  cooldownMinutes: 5,
  stratConfig: config,
  costs: { feeRate: 0.001, makerFeeRate: 0.001, slippageRate: 0 },
  exitManager: {
    async closeSimulated() {
      settlements++;
      throw new Error("Unexpected settlement");
    },
  } as any,
};
const reload = async () =>
  (await db.select().from(tradesTable).where(eq(tradesTable.id, trade.id)))[0]!;
const partials = () =>
  db
    .select()
    .from(tradePartialExitsTable)
    .where(eq(tradePartialExitsTable.tradeId, trade.id));

try {
  failInsert = true;
  const attempted = { ...trade };
  await assert.rejects(
    simulateDemoExit({ ...args, trade: attempted }),
    /injected insert failure/,
  );
  assert.deepEqual(
    await reload(),
    trade,
    "PostgreSQL must roll back the projection when the ledger insert fails",
  );
  assert.deepEqual(await partials(), []);
  assert.deepEqual(
    attempted,
    trade,
    "uncommitted state must not be published to the caller",
  );
  assert.equal(
    settlements,
    0,
    "failed persistence must not continue into settlement",
  );
  console.log(
    "PASS: real transaction rolls back projection and partial together",
  );

  failInsert = false;
  const competing = await Promise.allSettled([
    simulateDemoExit({ ...args, trade: { ...trade } }),
    simulateDemoExit({ ...args, trade: { ...trade } }),
  ]);
  assert.equal(
    competing.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.ok(
    competing.some(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof DemoManagementConflictError,
    ),
  );
  assert.equal(
    (await partials()).length,
    1,
    "concurrent scans must not duplicate the partial",
  );
  assert.equal(Number((await reload()).remainingQuantity), 0.5);
  console.log(
    "PASS: concurrent stale projections produce exactly one partial fill",
  );

  await simulateDemoExit({ ...args, trade: await reload() });
  assert.equal(
    (await partials()).length,
    1,
    "retry with committed state is idempotent",
  );
  await assert.rejects(
    simulateDemoExit({
      ...args,
      trade: { ...trade, executionTarget: "live" } as Trade,
    }),
    /non-Demo/,
  );
  await assert.rejects(
    simulateDemoExit({ ...args, trade: { ...trade, userId: userId + 1 } }),
    DemoManagementConflictError,
  );
  assert.equal(
    (await partials()).length,
    1,
    "a mismatched account cannot append to another account's ledger",
  );
  assert.equal(settlements, 0);
  console.log(
    "PASS: fresh retry preserves the ledger and Live management is refused",
  );
} finally {
  mutableDb.transaction = originalTransaction;
  // Remove only the exact row this invocation inserted, never a shared user.
  await db
    .delete(tradePartialExitsTable)
    .where(eq(tradePartialExitsTable.tradeId, trade.id));
  await db
    .delete(tradesTable)
    .where(and(eq(tradesTable.id, trade.id), eq(tradesTable.userId, userId)));
  await pool.end();
}
