/** Exercise the real manager with isolated persistence/provider test doubles. */
import { strict as assert } from "node:assert";
import { DEFAULT_STRATEGY_CONFIGS } from "../src/lib/strategies/base";
process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:5432/unused";
const { db } = await import("@workspace/db");
const { TradeManager } = await import("../src/lib/tradeManager");
const mutableDb = db as any;
const original = {
  insert: mutableDb.insert,
  update: mutableDb.update,
  select: mutableDb.select,
};
let persisted: Record<string, any>;
mutableDb.insert = () => ({ values: async () => {} });
mutableDb.update = () => ({
  set: (updates: Record<string, unknown>) => ({
    where: async () => {
      Object.assign(persisted, updates);
    },
  }),
});
mutableDb.select = () => ({
  from: () => ({ where: async () => [{ ...persisted }] }),
});
try {
  for (const short of [false, true]) {
    const protectedStop = short ? 98 : 102;
    persisted = {
      id: 1,
      symbol: "FIXTURE",
      side: short ? "sell" : "buy",
      entryPrice: "100",
      plannedStopLoss: short ? "105" : "95",
      stopLoss: String(protectedStop),
      takeProfit: short ? "90" : "110",
      quantity: "1",
      remainingQuantity: "1",
      tp1Filled: false,
      tp1Price: short ? "95" : "105",
      tp1Quantity: "0.5",
      breakEvenActive: false,
      trailingStopActive: true,
    };
    const replacementStops: number[] = [];
    const manager = new TradeManager({
      takerFee: () => 0.001,
      sendAlert: async (message) => {
        throw new Error(message);
      },
      cancelProtection: async () => {},
      cancelOrder: async () => {},
      executePartialClose: async () => (short ? 95 : 105),
      replaceStopOrder: async (_ex, _trade, _market, stop) => {
        replacementStops.push(stop);
        return {
          slOrderId: "replacement-stop",
          tpOrderId: "replacement-target",
        };
      },
    });
    const config = {
      ...DEFAULT_STRATEGY_CONFIGS.micro_scalping!,
      tp1RMultiple: 1,
      tp3Enabled: false,
      breakEvenRMultiple: 0,
      trailingStopMode: "none" as const,
      emergencyTrailingRMultiple: 0,
    };
    await manager.manage(
      {},
      persisted as any,
      "FIXTURE",
      [
        [
          0,
          short ? 97 : 103,
          short ? 97 : 106,
          short ? 94 : 103,
          short ? 95 : 105,
          1,
        ],
      ],
      config,
      { slOrderId: "old-stop", tpOrderId: "old-target" },
    );
    assert.equal(Number(persisted.remainingQuantity), 0.5);
    assert.equal(persisted.tp1Filled, true);
    assert.equal(Number(persisted.stopLoss), protectedStop);
    assert.deepEqual(
      replacementStops,
      [protectedStop],
      "broker replacement must preserve the tighter stop",
    );
  }
  console.log(
    "trade-manager-stop-regressions: long and short TP1 preserve stored and replacement stops",
  );
} finally {
  Object.assign(mutableDb, original);
}
