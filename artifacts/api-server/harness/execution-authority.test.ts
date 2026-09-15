import {
  DemoExecutionIsolationError,
  restrictToDemoMarketData,
} from "../src/lib/execution/demoMarketData";
import {
  authorityFromTrade,
  assertAuthorityMatchesMarket,
  resolveExecutionAuthority,
} from "../src/lib/execution/authority";

let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(
    `${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`,
  );
}

expect(
  "local Demo resolves to simulated authority",
  resolveExecutionAuthority({
    section: "crypto",
    marketType: "spot",
    executionTarget: "demo",
    testnet: false,
  }) === "simulated_demo",
);
expect(
  "Binance Spot sandbox stays broker-backed",
  resolveExecutionAuthority({
    section: "crypto",
    marketType: "spot",
    executionTarget: "live",
    testnet: true,
  }) === "binance_spot_testnet",
);
expect(
  "Binance Futures Demo stays broker-backed",
  resolveExecutionAuthority({
    section: "crypto",
    marketType: "futures",
    executionTarget: "live",
    testnet: true,
  }) === "binance_futures_demo",
);
expect(
  "OANDA practice stays broker-backed",
  resolveExecutionAuthority({
    section: "forex",
    marketType: "forex",
    executionTarget: "live",
    testnet: true,
  }) === "oanda_practice",
);
expect(
  "legacy Demo rows are safely classifiable",
  authorityFromTrade({
    executionTarget: "demo",
    executionAuthority: "legacy_unverified",
  }) === "simulated_demo",
);
expect(
  "legacy broker rows remain ambiguous",
  authorityFromTrade({
    executionTarget: "live",
    executionAuthority: "legacy_unverified",
  }) === "legacy_unverified",
);

const persistedSpotAuthority = authorityFromTrade({
  executionTarget: "live",
  executionAuthority: "binance_spot_testnet",
});
let persistedAuthorityRefusedFutures = false;
try { assertAuthorityMatchesMarket(persistedSpotAuthority, "futures"); } catch { persistedAuthorityRefusedFutures = true; }
expect(
  "reconciliation follows persisted execution authority rather than mutable Futures config",
  persistedAuthorityRefusedFutures,
);

let legacyAuthorityRefused = false;
try { assertAuthorityMatchesMarket("legacy_unverified", "spot"); } catch { legacyAuthorityRefused = true; }
expect("legacy_unverified broker records remain fail-closed", legacyAuthorityRefused);

process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:5432/unused";
const { closeDemoManually, simulateDemoExit } =
  await import("../src/lib/execution/demoExit");

let sourceOrderCalls = 0;
const marketData = restrictToDemoMarketData({
  markets: {},
  async loadMarkets() {
    return {};
  },
  async fetchTicker() {
    return { last: 100 };
  },
  async createOrder() {
    sourceOrderCalls++;
    return {};
  },
});
let isolationError = false;
try {
  await marketData.createOrder();
} catch (error) {
  isolationError = error instanceof DemoExecutionIsolationError;
}
expect(
  "Demo market-data capability refuses external execution",
  isolationError && sourceOrderCalls === 0,
);

let simulatedSettlements = 0;
const manual = await closeDemoManually({
  trade: { executionTarget: "demo", side: "buy" } as any,
  markPrice: 100,
  now: new Date("2026-08-11T00:00:00.000Z"),
  cooldownMinutes: 15,
  costs: { feeRate: 0.001, makerFeeRate: 0.001, slippageRate: 0.0005 },
  exitManager: {
    async closeSimulated(_trade: unknown, reason: string, price: number) {
      simulatedSettlements++;
      return {
        closed: reason === "manual",
        exitReason: reason,
        exitPrice: price,
        pnl: 0,
      };
    },
  } as any,
});
expect(
  "Demo manual close settles locally",
  manual.closed && simulatedSettlements === 1,
);
expect(
  "Demo manual close uses adverse simulated slippage",
  manual.exitPrice === 99.95,
  String(manual.exitPrice),
);

let protectiveSettlements = 0;
const protectiveClosed = await simulateDemoExit({
  trade: {
    id: 941,
    executionTarget: "demo",
    symbol: "BTCUSDT",
    side: "buy",
    entryPrice: "100",
    stopLoss: "99.5",
    takeProfit: "110",
    plannedStopLoss: "99.5",
    quantity: "1",
    remainingQuantity: "1",
    entryTime: new Date("2026-08-11T00:00:00.000Z"),
    confidence: "70",
    leverage: 1,
    mfeUsdt: "0",
    maeUsdt: "-1",
    tp1Filled: false,
    tp2Filled: false,
    breakEvenActive: false,
    trailingStopActive: false,
    trailingStopMode: null,
    trailingStopArmedPrice: null,
    phase7ReductionApplied: false,
  } as any,
  candles1m: [[Date.parse("2026-08-11T00:01:00.000Z"), 100, 100, 99, 99, 1]],
  now: new Date("2026-08-11T00:01:00.000Z"),
  cooldownMinutes: 15,
  stratConfig: undefined,
  costs: { feeRate: 0.001, makerFeeRate: 0.001, slippageRate: 0.0005 },
  exitManager: {
    async closeSimulated(_trade: unknown, reason: string) {
      protectiveSettlements++;
      return {
        closed: reason === "stop_loss",
        exitReason: reason,
        exitPrice: 99.45025,
        pnl: -1,
      };
    },
  } as any,
});
expect(
  "Demo protective close settles only through the simulated accounting path",
  protectiveClosed && protectiveSettlements === 1 && sourceOrderCalls === 0,
);

console.log(
  failures === 0
    ? "\nexecution-authority: all checks passed"
    : `\nexecution-authority: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
