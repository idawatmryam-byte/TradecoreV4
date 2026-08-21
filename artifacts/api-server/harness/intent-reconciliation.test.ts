import {
  classifyBrokerOrder,
  planExposureRecovery,
} from "../src/lib/execution/reconciliationPolicy";
import { makeRecoveryClientOrderId } from "../src/lib/execution/ids";

let failures = 0;
function expect(name: string, ok: boolean): void {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

const base = {
  brokerOrderId: "order-1",
  requestedQuantity: 10,
  averageFillPrice: 100,
  brokerTradeId: null,
} as const;

expect(
  "authoritative full fill is FILLED",
  classifyBrokerOrder({ ...base, status: "FILLED", filledQuantity: 10 })
    .state === "FILLED",
);
expect(
  "partial fill remains explicit",
  classifyBrokerOrder({ ...base, status: "OPEN", filledQuantity: 4 }).state ===
    "PARTIALLY_FILLED",
);
expect(
  "canceled after partial fill is not misclassified as failed",
  classifyBrokerOrder({ ...base, status: "CANCELED", filledQuantity: 4 })
    .state === "PARTIALLY_FILLED",
);
expect(
  "authoritative unfilled rejection is FAILED",
  classifyBrokerOrder({ ...base, status: "REJECTED", filledQuantity: 0 })
    .state === "FAILED",
);
expect(
  "authoritative unfilled cancellation is FAILED",
  classifyBrokerOrder({ ...base, status: "CANCELED", filledQuantity: 0 })
    .state === "FAILED",
);
expect(
  "pending broker state requires reconciliation",
  classifyBrokerOrder({ ...base, status: "OPEN", filledQuantity: 0 }).state ===
    "RECONCILIATION_REQUIRED",
);
expect(
  "unknown is never converted to failed or zero",
  classifyBrokerOrder({
    ...base,
    status: "UNKNOWN",
    requestedQuantity: null,
    filledQuantity: null,
    averageFillPrice: null,
  }).state === "RECONCILIATION_REQUIRED",
);

expect(
  "authoritative full fill without a local trade is reduced",
  planExposureRecovery({
    evidence: { ...base, status: "FILLED", filledQuantity: 10 },
    marketType: "futures",
    localTradeId: null,
  }).action === "REDUCE",
);
expect(
  "open partial fill cancels the remainder before reduction",
  planExposureRecovery({
    evidence: { ...base, status: "OPEN", filledQuantity: 4 },
    marketType: "spot",
    localTradeId: null,
  }).action === "CANCEL_REMAINDER_THEN_REDUCE",
);
expect(
  "canceled partial fill still reduces the authoritative exposure",
  planExposureRecovery({
    evidence: { ...base, status: "CANCELED", filledQuantity: 4 },
    marketType: "spot",
    localTradeId: null,
  }).action === "REDUCE",
);
expect(
  "missing fill price escalates instead of fabricating recovery evidence",
  planExposureRecovery({
    evidence: {
      ...base,
      status: "FILLED",
      filledQuantity: 10,
      averageFillPrice: null,
    },
    marketType: "futures",
    localTradeId: null,
  }).action === "ESCALATE",
);
expect(
  "forex recovery requires the authoritative broker trade id",
  planExposureRecovery({
    evidence: { ...base, status: "FILLED", filledQuantity: 10 },
    marketType: "forex",
    localTradeId: null,
  }).action === "ESCALATE",
);
expect(
  "an existing local trade is protected rather than compensating twice",
  planExposureRecovery({
    evidence: { ...base, status: "FILLED", filledQuantity: 10 },
    marketType: "futures",
    localTradeId: 41,
  }).action === "NONE",
);
const recoveryId = makeRecoveryClientOrderId(42, "tc-original-order");
expect(
  "recovery provider id is deterministic across restart",
  recoveryId === makeRecoveryClientOrderId(42, "tc-original-order"),
);
expect(
  "recovery provider id changes across original intents",
  recoveryId !== makeRecoveryClientOrderId(42, "tc-another-order"),
);
expect(
  "recovery provider id stays inside Binance's 36-character limit",
  recoveryId.length <= 36,
);

console.log(
  failures === 0
    ? "\nintent-reconciliation: all checks passed"
    : `\nintent-reconciliation: ${failures} FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
