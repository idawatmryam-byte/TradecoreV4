import { createExposureRecoveryExecutor } from "../src/lib/execution/exposureRecovery";

let failures = 0;
function expect(name: string, ok: boolean): void {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

const intent = {
  id: 91,
  userId: 7,
  section: "crypto",
  symbol: "BTCUSDT",
  side: "buy",
  marketType: "futures",
  clientOrderId: "entry-91",
} as any;
const evidence = {
  status: "FILLED",
  brokerOrderId: "entry-broker-91",
  brokerTradeId: null,
  requestedQuantity: 2,
  filledQuantity: 2,
  averageFillPrice: 60_000,
} as const;
const recoveryId = "tc-rec-fixed-91";

async function run(): Promise<void> {
  {
    let lookups = 0;
    let creates = 0;
    const executor = createExposureRecoveryExecutor({
      exchange: {
        amountToPrecision: (_market: string, value: number) => String(value),
        fetchOrder: async () => {
          lookups++;
          if (lookups === 1) throw new Error("not found before submission");
          return { id: "reduce-91", status: "closed", filled: 2 };
        },
        createOrder: async (...args: any[]) => {
          creates++;
          expect("futures close is reduce-only", args[5]?.reduceOnly === true);
          expect(
            "futures close uses the durable recovery id",
            args[5]?.newClientOrderId === recoveryId,
          );
          throw new Error("response lost after provider accepted order");
        },
      },
      toMarket: () => "BTC/USDT:USDT",
      resolveOrder: async () => evidence,
    });
    const result = await executor({
      intent,
      evidence,
      plan: { action: "REDUCE", reasonCode: "TEST", quantity: 2 },
      recoveryClientOrderId: recoveryId,
    });
    expect(
      "timeout after possible futures submission resolves by provider id",
      result.outcome === "FLATTENED" && creates === 1 && lookups === 2,
    );
  }

  {
    let creates = 0;
    const executor = createExposureRecoveryExecutor({
      exchange: {
        amountToPrecision: (_market: string, value: number) => String(value),
        fetchOrder: async () => ({
          id: "reduce-existing",
          status: "filled",
          filled: 2,
        }),
        createOrder: async () => {
          creates++;
        },
      },
      toMarket: () => "BTC/USDT:USDT",
      resolveOrder: async () => evidence,
    });
    const result = await executor({
      intent,
      evidence,
      plan: { action: "REDUCE", reasonCode: "TEST", quantity: 2 },
      recoveryClientOrderId: recoveryId,
    });
    expect(
      "restart replay discovers prior reduction without duplicating it",
      result.outcome === "FLATTENED" && creates === 0,
    );
  }

  {
    let cancels = 0;
    let closeQuantity = 0;
    const executor = createExposureRecoveryExecutor({
      exchange: {
        cancelOrder: async (id: string) => {
          if (id === "partial-order") cancels++;
        },
        amountToPrecision: (_market: string, value: number) => String(value),
        fetchOrder: async () => {
          throw new Error("no prior reduction");
        },
        createOrder: async (
          _market: string,
          _type: string,
          _side: string,
          quantity: number,
        ) => {
          closeQuantity = quantity;
          return { id: "partial-reduce", status: "closed", filled: quantity };
        },
      },
      toMarket: () => "BTC/USDT:USDT",
      resolveOrder: async () => ({
        ...evidence,
        status: "CANCELED",
        brokerOrderId: "partial-order",
        filledQuantity: 0.7,
      }),
    });
    const result = await executor({
      intent,
      evidence: {
        ...evidence,
        status: "OPEN",
        brokerOrderId: "partial-order",
        filledQuantity: 0.4,
      },
      plan: {
        action: "CANCEL_REMAINDER_THEN_REDUCE",
        reasonCode: "TEST",
        quantity: 0.4,
      },
      recoveryClientOrderId: recoveryId,
    });
    expect(
      "partial fill cancels and re-reads final quantity before reduction",
      result.outcome === "FLATTENED" && cancels === 1 && closeQuantity === 0.7,
    );
  }

  {
    let creates = 0;
    const executor = createExposureRecoveryExecutor({
      exchange: {
        amountToPrecision: (_market: string, value: number) => String(value),
        fetchOrder: async () => {
          throw new Error("unknown order");
        },
        fetchBalance: async () => ({ total: { BTC: 0 } }),
        createOrder: async () => {
          creates++;
        },
      },
      toMarket: () => "BTC/USDT",
      resolveOrder: async () => evidence,
    });
    const result = await executor({
      intent: { ...intent, marketType: "spot" },
      evidence,
      plan: { action: "REDUCE", reasonCode: "TEST", quantity: 2 },
      recoveryClientOrderId: recoveryId,
    });
    expect(
      "provider-side spot closure is proven by zero balance without another sale",
      result.outcome === "FLATTENED" &&
        result.filledQuantity === 0 &&
        creates === 0,
    );
  }

  {
    let creates = 0;
    const executor = createExposureRecoveryExecutor({
      exchange: {
        amountToPrecision: (_market: string, value: number) => String(value),
        fetchOrder: async () => {
          throw new Error("unknown order");
        },
        fetchBalance: async () => ({ total: { BTC: 0.5 } }),
        createOrder: async () => {
          creates++;
        },
      },
      toMarket: () => "BTC/USDT",
      resolveOrder: async () => evidence,
    });
    const result = await executor({
      intent: { ...intent, marketType: "spot" },
      evidence,
      plan: { action: "REDUCE", reasonCode: "TEST", quantity: 2 },
      recoveryClientOrderId: recoveryId,
    });
    expect(
      "manual spot balance change escalates without selling an invented amount",
      result.outcome === "ESCALATE" && creates === 0,
    );
  }

  {
    const executor = createExposureRecoveryExecutor({
      exchange: {
        amountToPrecision: (_market: string, value: number) => String(value),
        fetchOrder: async () => {
          throw new Error("unknown order");
        },
        createOrder: async () => ({ id: "pending", status: "open", filled: 0 }),
      },
      toMarket: () => "BTC/USDT:USDT",
      resolveOrder: async () => evidence,
    });
    const result = await executor({
      intent,
      evidence,
      plan: { action: "REDUCE", reasonCode: "TEST", quantity: 2 },
      recoveryClientOrderId: recoveryId,
    });
    expect(
      "unknown provider reduction remains retryable and blocked",
      result.outcome === "RETRY",
    );
  }

  {
    const executor = createExposureRecoveryExecutor({
      exchange: {
        closeTradeById: async () => ({
          id: "oanda-trade-closed",
          filled: 0,
          info: { alreadyClosed: true },
        }),
      },
      toMarket: () => "EUR/USD",
      resolveOrder: async () => evidence,
    });
    const result = await executor({
      intent: { ...intent, marketType: "forex", symbol: "EUR_USD" },
      evidence: { ...evidence, brokerTradeId: "oanda-trade-7" },
      plan: { action: "REDUCE", reasonCode: "TEST", quantity: 2 },
      recoveryClientOrderId: recoveryId,
    });
    expect(
      "OANDA trade absence is idempotent closure evidence, not a fabricated fill",
      result.outcome === "FLATTENED" && result.filledQuantity === 0,
    );
  }
}

await run();
console.log(
  failures === 0
    ? "\nexposure-recovery: all checks passed"
    : `\nexposure-recovery: ${failures} FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
