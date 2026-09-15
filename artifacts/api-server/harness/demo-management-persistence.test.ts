/**
 * Regression: normal Demo management must persist the complete projection.
 *
 * Trade 959 exposed a split-brain state: the fill model had activated
 * break-even and trailing in memory, but the trades row retained false flags.
 * After a reload the exit audit therefore treated the managed stop as
 * unexplained planned-vs-actual drift.
 *
 * This harness uses the real Demo fill model and real ExitManager audit with a
 * tiny in-memory stand-in for the persistence boundary. No provider, broker,
 * historical trade row, or external database is touched.
 */
process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:5432/unused";

const { db } = await import("@workspace/db");
const { simulateDemoExit } = await import("../src/lib/execution/demoExit");
const { ExitManager } = await import("../src/lib/exitManager");
const { logger } = await import("../src/lib/logger");

let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(
    `${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`,
  );
}

const T0 = new Date("2026-08-12T08:00:00.000Z");
const costs = { feeRate: 0.001, makerFeeRate: 0.001, slippageRate: 0 };
const strategyConfig = {
  strategyId: "trend_pullback",
  enabled: true,
  tradeAmountUsdt: null,
  maxLossUsdt: null,
  targetProfitUsdt: null,
  riskPercent: 1,
  confidenceThreshold: 70,
  stopLossPercent: 5,
  takeProfitPercent: 10,
  maxHoldingSeconds: 7_200,
  maxConcurrentPositions: 1,
  cooldownMinutes: 5,
  breakEvenRMultiple: 0,
  tp1RMultiple: 1,
  tp1ClosePercent: 50,
  tp3Enabled: false,
  tp2RMultiple: 0,
  tp2ClosePercent: 0,
  tp3RMultiple: 0,
  trailingStopMode: "percent",
  trailingStopAtrMultiplier: 2,
  trailingStopPercent: 1,
  trailingAfterTp1Only: true,
  emergencyTrailingRMultiple: 0,
  emergencyTrailingPercent: 0.5,
  exitPriority: ["stop_loss", "take_profit", "trailing_stop", "timeout"],
} as const;

let persistedTrade: Record<string, any> = {
  id: 959,
  userId: 959,
  section: "crypto",
  executionTarget: "demo",
  executionAuthority: "simulated_demo",
  managementAuthority: "fixed",
  managementMode: "fixed",
  managementPolicyVersion: "brain-v0-fixed-sltp",
  symbol: "BTCUSDT",
  side: "buy",
  marketType: "spot",
  entryPrice: "100.05000000",
  stopLoss: "95.05000000",
  takeProfit: "110.05000000",
  plannedStopLoss: "95.00000000",
  plannedTakeProfit: "110.00000000",
  quantity: "1.00000000",
  plannedQuantity: "1.00000000",
  remainingQuantity: "1.00000000",
  status: "open",
  confidence: "70.00",
  entryTime: T0,
  leverage: 1,
  mfeUsdt: "0.00000000",
  maeUsdt: "0.00000000",
  tp1Price: "105.05000000",
  tp1Quantity: "0.50000000",
  tp1Filled: false,
  tp1FillPrice: null,
  tp1FillTime: null,
  tp2Price: null,
  tp2Quantity: null,
  tp2Filled: false,
  tp2FillPrice: null,
  tp2FillTime: null,
  breakEvenActive: false,
  trailingStopActive: false,
  trailingStopMode: null,
  trailingStopArmedPrice: null,
  phase7ReductionApplied: false,
};
const partialExits: Array<Record<string, any>> = [];

function reloadTrade(): Record<string, any> {
  return {
    ...persistedTrade,
    entryTime: new Date(persistedTrade.entryTime),
    ...(persistedTrade.tp1FillTime && {
      tp1FillTime: new Date(persistedTrade.tp1FillTime),
    }),
    ...(persistedTrade.tp2FillTime && {
      tp2FillTime: new Date(persistedTrade.tp2FillTime),
    }),
  };
}

const mutableDb = db as any;
const originalDb = {
  insert: mutableDb.insert,
  update: mutableDb.update,
  select: mutableDb.select,
  transaction: mutableDb.transaction,
};
const originalWarn = logger.warn;
let validationMismatchWarnings = 0;
let failPartialWrite = false;
let failProjectionWrite = false;

mutableDb.insert = () => ({
  values: async (values: Record<string, any>) => {
    if (failPartialWrite) throw new Error("injected partial insert failure");
    partialExits.push({ ...values });
  },
});
mutableDb.update = () => ({
  set: (values: Record<string, any>) => ({
    where: async () => {
      if (failProjectionWrite)
        throw new Error("injected projection update failure");
      persistedTrade = { ...persistedTrade, ...values };
    },
  }),
});
mutableDb.transaction = async (callback: (tx: any) => Promise<unknown>) => {
  const before = { ...persistedTrade };
  const partialCount = partialExits.length;
  try {
    return await callback({
      update: mutableDb.update,
      insert: mutableDb.insert,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [{ ...persistedTrade }],
            }),
          }),
        }),
      }),
    });
  } catch (error) {
    persistedTrade = before;
    partialExits.length = partialCount;
    throw error;
  }
};
mutableDb.select = () => ({
  from: () => ({
    where: async () => partialExits.map((partial) => ({ ...partial })),
  }),
});
logger.warn = ((...args: unknown[]) => {
  if (args.some((arg) => String(arg).includes("TRADE_VALIDATION_MISMATCH"))) {
    validationMismatchWarnings++;
  }
}) as typeof logger.warn;

const exitManager = new ExitManager({
  takerFee: () => costs.feeRate,
  async sendAlert() {},
  sendCriticalAlert() {},
  setCooldown() {},
  async recordHourlyStat() {},
  recordRiskViolation() {},
  recordCleanClose() {},
  onTradeClosed() {},
});

try {
  console.log("\n— Entry-minute timing —");
  let earlyCloses = 0;
  const entryMinuteTrade = {
    ...reloadTrade(),
    entryTime: new Date(T0.getTime() + 30_000),
  };
  const entryMinuteArgs = {
    trade: entryMinuteTrade as any,
    now: new Date(T0.getTime() + 40_000),
    cooldownMinutes: 5,
    stratConfig: strategyConfig as any,
    costs,
    exitManager: {
      async closeSimulated() {
        earlyCloses++;
        return { closed: true };
      },
    } as unknown as typeof exitManager,
  };
  await simulateDemoExit({
    ...entryMinuteArgs,
    candles1m: [[T0.getTime() - 60_000, 100.05, 120, 90, 94, 10]],
  });
  expect(
    "a bar closed before entry cannot close a new trade",
    earlyCloses === 0,
  );
  await simulateDemoExit({
    ...entryMinuteArgs,
    candles1m: [[T0.getTime(), 100.05, 120, 90, 100.05, 10]],
  });
  expect(
    "pre-entry wicks cannot trigger a stop or partial",
    earlyCloses === 0 && partialExits.length === 0,
  );
  await simulateDemoExit({
    ...entryMinuteArgs,
    candles1m: [[T0.getTime(), 100.05, 120, 90, 94, 10]],
  });
  expect(
    "an observed post-entry price still triggers the stop",
    Number(earlyCloses) === 1,
  );

  console.log("\n— Demo entry projection —");
  expect(
    "entry is entirely simulated",
    persistedTrade.executionTarget === "demo",
  );
  expect(
    "entry carries simulated execution authority",
    persistedTrade.executionAuthority === "simulated_demo",
  );
  expect(
    "planned quantity matches the original quantity",
    persistedTrade.plannedQuantity === persistedTrade.quantity,
  );
  expect(
    "entry preserves management policy metadata",
    persistedTrade.managementPolicyVersion === "brain-v0-fixed-sltp",
  );

  console.log("\n— TP1 and break-even persist —");
  const beforeTp1 = reloadTrade();
  const tp1Args = {
    candles1m: [[T0.getTime() + 60_000, 100.05, 105.1, 100.1, 100.5, 10]] as [
      number,
      number,
      number,
      number,
      number,
      number,
    ][],
    now: new Date(T0.getTime() + 60_000),
    cooldownMinutes: 5,
    stratConfig: strategyConfig as any,
    costs,
    exitManager,
  };
  for (const failurePoint of ["partial", "projection"] as const) {
    const attemptedTrade = reloadTrade();
    const before = JSON.stringify(attemptedTrade);
    failPartialWrite = failurePoint === "partial";
    failProjectionWrite = failurePoint === "projection";
    let refused = false;
    try {
      await simulateDemoExit({ ...tp1Args, trade: attemptedTrade as any });
    } catch {
      refused = true;
    }
    expect(`${failurePoint} write failure is surfaced`, refused);
    expect(
      `${failurePoint} write failure rolls back the trade and partial`,
      JSON.stringify(reloadTrade()) === before && partialExits.length === 0,
    );
    expect(
      `${failurePoint} write failure leaves caller state unchanged`,
      JSON.stringify(attemptedTrade) === before,
    );
    failPartialWrite = false;
    failProjectionWrite = false;
  }
  const tp1Closed = await simulateDemoExit({
    trade: reloadTrade() as any,
    candles1m: [[T0.getTime() + 60_000, 100.05, 105.1, 100.1, 100.5, 10]],
    now: new Date(T0.getTime() + 60_000),
    cooldownMinutes: 5,
    stratConfig: strategyConfig as any,
    costs,
    exitManager,
  });
  expect("TP1 management leaves the remainder open", tp1Closed === false);
  expect(
    "TP1 partial exit is persisted",
    partialExits.length === 1 && partialExits[0]?.reason === "tp1",
  );
  expect(
    "TP1 includes its share of both entry and exit fees",
    Math.abs(
      Number(partialExits[0]?.fees) - (100.05 + 105.05) * 0.5 * costs.feeRate,
    ) < 1e-8,
  );
  let staleRefused = false;
  try {
    await simulateDemoExit({ ...tp1Args, trade: beforeTp1 as any });
  } catch (error) {
    staleRefused =
      error instanceof Error && error.name === "DemoManagementConflictError";
  }
  expect(
    "stale management is refused before a second partial can be recorded",
    staleRefused && partialExits.length === 1,
  );
  expect(
    "remaining quantity reflects the TP1 reduction",
    Number(persistedTrade.remainingQuantity) === 0.5,
  );
  expect(
    "TP1 includes its share of the entry fee",
    Math.abs(Number(partialExits[0]?.fees) - (100.05 + 105.05) * 0.5 * costs.feeRate) < 1e-8,
    String(partialExits[0]?.fees),
  );
  expect("TP1 state is persisted", persistedTrade.tp1Filled === true);
  expect(
    "TP1 fill price is persisted",
    Number(persistedTrade.tp1FillPrice) === 105.05,
  );
  expect(
    "TP1 fill time is persisted",
    new Date(persistedTrade.tp1FillTime).getTime() === T0.getTime() + 60_000,
  );
  expect(
    "break-even activation is persisted",
    persistedTrade.breakEvenActive === true,
  );
  expect(
    "managed stop is persisted at break-even",
    Number(persistedTrade.stopLoss) === 100.05,
  );

  console.log("\n— restart/reload and trailing activation —");
  const afterTp1Reload = reloadTrade();
  expect(
    "reload restores TP1 state",
    afterTp1Reload.tp1Filled === true &&
      Number(afterTp1Reload.remainingQuantity) === 0.5,
  );
  expect(
    "reload restores break-even state",
    afterTp1Reload.breakEvenActive === true,
  );

  const trailingClosed = await simulateDemoExit({
    trade: afterTp1Reload as any,
    candles1m: [[T0.getTime() + 120_000, 105.5, 106.2, 105.1, 106, 10]],
    now: new Date(T0.getTime() + 120_000),
    cooldownMinutes: 5,
    stratConfig: strategyConfig as any,
    costs,
    exitManager,
  });
  expect(
    "trailing activation leaves the managed position open",
    trailingClosed === false,
  );
  expect(
    "trailing activation is persisted",
    persistedTrade.trailingStopActive === true,
  );
  expect(
    "trailing mode is persisted",
    persistedTrade.trailingStopMode === "percent",
  );
  expect(
    "trailing reference price is persisted",
    Number(persistedTrade.trailingStopArmedPrice) === 106,
  );
  expect(
    "current managed stop is persisted",
    Number(persistedTrade.stopLoss) === 104.94,
  );
  expect(
    "management policy metadata survives updates",
    persistedTrade.managementPolicyVersion === "brain-v0-fixed-sltp",
  );

  console.log("\n— second restart/reload and exit audit —");
  const afterTrailingReload = reloadTrade();
  expect(
    "reload restores the complete management projection",
    afterTrailingReload.tp1Filled === true &&
      afterTrailingReload.breakEvenActive === true &&
      afterTrailingReload.trailingStopActive === true &&
      afterTrailingReload.trailingStopMode === "percent" &&
      Number(afterTrailingReload.stopLoss) === 104.94,
  );

  const closed = await simulateDemoExit({
    trade: afterTrailingReload as any,
    candles1m: [[T0.getTime() + 180_000, 105, 105.3, 104.8, 104.9, 10]],
    now: new Date(T0.getTime() + 180_000),
    cooldownMinutes: 5,
    stratConfig: strategyConfig as any,
    costs,
    exitManager,
  });
  expect(
    "reloaded trailing stop closes through the shared accounting path",
    closed === true,
  );
  expect(
    "legitimate managed drift emits no validation mismatch",
    validationMismatchWarnings === 0,
    String(validationMismatchWarnings),
  );
  expect(
    "historical entry quantities remain immutable",
    persistedTrade.quantity === "1.00000000" &&
      persistedTrade.plannedQuantity === "1.00000000",
  );
  const expectedFees = 100.05 * costs.feeRate + (105.05 + 104.94) * 0.5 * costs.feeRate;
  expect("reloaded Demo charges the full entry fee exactly once", Math.abs(Number(persistedTrade.feesUsdt) - expectedFees) < 1e-8, String(persistedTrade.feesUsdt));
  expect("reloaded Demo net profit includes all slice costs", Math.abs(Number(persistedTrade.pnl) - (4.945 - expectedFees)) < 1e-8, String(persistedTrade.pnl));
} finally {
  mutableDb.insert = originalDb.insert;
  mutableDb.update = originalDb.update;
  mutableDb.select = originalDb.select;
  mutableDb.transaction = originalDb.transaction;
  logger.warn = originalWarn;
}

console.log(
  failures === 0
    ? "\ndemo-management-persistence: all checks passed"
    : `\ndemo-management-persistence: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
