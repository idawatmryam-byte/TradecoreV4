/** Pure connection diagnostics: no database and no provider network calls. */
import { AuthenticationError, InvalidNonce } from "ccxt";
import { buildBinanceClient } from "../src/lib/brokers/binanceClient";
import { actionableConnectionError } from "../src/lib/brokers/connectionTest";
import { OandaClient } from "../src/lib/brokers/oandaClient";

let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(`${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`);
}

const accountId = "001-000-1234567-890";
const oanda = actionableConnectionError(
  "oanda",
  new AuthenticationError(`OANDA GET /v3/accounts/${accountId}/summary failed: HTTP 401`),
);
expect("OANDA auth guidance is actionable", /Practice\/Live/.test(oanda.message), oanda.message);
expect("OANDA auth guidance never returns the account id", !oanda.message.includes(accountId), oanda.message);

const oandaMissingAccount = actionableConnectionError(
  "oanda",
  new Error(`OANDA GET /v3/accounts/[account]/summary failed: HTTP 404 — NO_SUCH_ACCOUNT`),
);
expect("OANDA missing-account failures identify account/environment compatibility", oandaMissingAccount.code === "AUTH_OR_ENVIRONMENT_REJECTED", oandaMissingAccount.message);

const oandaTimeout = actionableConnectionError("oanda", { name: "TimeoutError" });
expect("OANDA native fetch timeouts receive connectivity guidance", oandaTimeout.code === "PROVIDER_TIMEOUT", oandaTimeout.message);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(
  JSON.stringify({ errorMessage: `Account ${accountId} is unavailable` }),
  { status: 401, headers: { "content-type": "application/json" } },
);
try {
  const client = new OandaClient({ token: "not-a-real-token", accountId, practice: true });
  await client.acct("GET", "/summary");
  expect("OANDA client rejects failed requests", false);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  expect("OANDA client redacts account ids from paths and provider details", !message.includes(accountId), message);
} finally {
  globalThis.fetch = originalFetch;
}

const binanceAuth = actionableConnectionError(
  "binance",
  new AuthenticationError('binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions"}'),
);
expect("Binance -2015 names key, environment, permission and IP checks", /environment/.test(binanceAuth.message) && /trading/.test(binanceAuth.message) && /IP/.test(binanceAuth.message), binanceAuth.message);
expect("Binance error does not require withdrawals", !/enable withdrawal/i.test(binanceAuth.message), binanceAuth.message);

const clock = actionableConnectionError("binance", new InvalidNonce("binance -1021 timestamp outside recvWindow"));
expect("Binance timestamp errors prescribe NTP", clock.code === "CLOCK_OUT_OF_SYNC" && /NTP/.test(clock.message), clock.message);

const spotTest = buildBinanceClient({
  apiKey: "not-a-real-key",
  apiSecret: "not-a-real-secret",
  marketType: "spot",
  testnet: true,
});
expect("Spot Test Connection selects testnet.binance.vision", JSON.stringify(spotTest.urls).includes("testnet.binance.vision"));

const futuresDemo = buildBinanceClient({
  apiKey: "not-a-real-key",
  apiSecret: "not-a-real-secret",
  marketType: "futures",
  testnet: true,
});
expect("Futures Test Connection selects demo-fapi.binance.com", JSON.stringify(futuresDemo.urls).includes("demo-fapi.binance.com"));

console.log(failures === 0 ? "\nconnection-errors: all checks passed" : `\nconnection-errors: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
