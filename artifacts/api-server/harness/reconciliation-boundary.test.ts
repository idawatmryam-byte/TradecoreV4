import { sweepBinanceFuturesOrphans } from "../src/lib/execution/orphanReconciliation";

let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(
    `${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`,
  );
}

const requested: Array<string | undefined> = [];
const cancelled: string[] = [];
const exchange = {
  async fetchPositions() {
    return [{ symbol: "BTC/USDT:USDT", contracts: 1 }];
  },
  async fetchOpenOrders(symbol?: string) {
    requested.push(symbol);
    if (!symbol) throw new Error("symbol required");
    if (symbol === "ETH/USDT:USDT") {
      return [
        { id: "orphan-sl", symbol, type: "STOP_MARKET", reduceOnly: true },
      ];
    }
    return [{ id: "active-sl", symbol, type: "STOP_MARKET", reduceOnly: true }];
  },
  async cancelOrder(id: string, symbol: string) {
    cancelled.push(`${symbol}:${id}`);
  },
};

const verified = await sweepBinanceFuturesOrphans({
  exchange,
  configuredMarkets: ["BTC/USDT:USDT", "ETH/USDT:USDT"],
  trackedMarkets: ["BTC/USDT:USDT"],
});
expect(
  "open-order reads always carry an explicit symbol",
  requested.every(Boolean),
  JSON.stringify(requested),
);
expect(
  "active-position protection is preserved",
  !cancelled.some((item) => item.includes("active-sl")),
  JSON.stringify(cancelled),
);
expect(
  "verified orphan is cancelled",
  cancelled.includes("ETH/USDT:USDT:orphan-sl"),
  JSON.stringify(cancelled),
);
expect("successful sweep is VERIFIED", verified.state === "verified");

let cancellationAttempted = false;
const failed = await sweepBinanceFuturesOrphans({
  exchange: {
    async fetchPositions() {
      return [];
    },
    async fetchOpenOrders(symbol: string) {
      if (symbol.startsWith("ETH")) throw new Error("provider unavailable");
      return [
        {
          id: "must-not-cancel",
          symbol,
          type: "STOP_MARKET",
          reduceOnly: true,
        },
      ];
    },
    async cancelOrder() {
      cancellationAttempted = true;
    },
  },
  configuredMarkets: ["BTC/USDT:USDT", "ETH/USDT:USDT"],
  trackedMarkets: [],
});
expect(
  "provider failure produces UNVERIFIED",
  failed.state === "unverified",
  JSON.stringify(failed),
);
expect("partial reads never cause cancellation", !cancellationAttempted);

console.log(
  failures === 0
    ? "\nreconciliation-boundary: all checks passed"
    : `\nreconciliation-boundary: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
