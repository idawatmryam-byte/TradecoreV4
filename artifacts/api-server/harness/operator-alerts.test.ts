process.env.NODE_ENV = "test";
process.env.OPS_ALERT_WEBHOOK_URL = "https://alerts.invalid/operator";

import {
  emitCriticalOperatorAlert,
  resetOperatorAlertStateForTests,
} from "../src/lib/operatorAlerts";

let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(
    `${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`,
  );
}

const originalFetch = globalThis.fetch;
let calls = 0;
let sentBody = "";
globalThis.fetch = async (_input, init) => {
  calls++;
  sentBody = String(init?.body ?? "");
  return calls === 1
    ? new Response("retry", { status: 503 })
    : new Response("ok", { status: 200 });
};

try {
  resetOperatorAlertStateForTests();
  const first = await emitCriticalOperatorAlert({
    code: "PROTECTIVE_CLOSE_FAILED",
    summary: "Protective close failed",
    dedupeKey: "trade-42",
    userId: 7,
    section: "crypto",
    tradeId: 42,
    symbol: "BTCUSDT",
    provider: "binance",
    executionAuthority: "binance_futures_demo",
  });
  expect(
    "critical alert retries a transient delivery failure",
    first === "delivered" && calls === 2,
    `${first}/${calls}`,
  );
  expect(
    "alert payload is structured",
    sentBody.includes("tradecore-critical-alert-v1"),
    sentBody,
  );
  expect(
    "alert payload contains no credential fields",
    !/token|password|authorization|cookie/i.test(sentBody),
    sentBody,
  );

  const duplicate = await emitCriticalOperatorAlert({
    code: "PROTECTIVE_CLOSE_FAILED",
    summary: "Protective close failed again",
    dedupeKey: "trade-42",
    tradeId: 42,
    symbol: "BTCUSDT",
  });
  expect(
    "repeat financial alerts are deduplicated",
    duplicate === "deduplicated" && calls === 2,
    `${duplicate}/${calls}`,
  );
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.OPS_ALERT_WEBHOOK_URL;
}

console.log(
  failures === 0
    ? "\noperator-alerts: all checks passed"
    : `\noperator-alerts: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
