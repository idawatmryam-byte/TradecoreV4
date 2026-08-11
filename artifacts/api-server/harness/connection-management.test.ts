/**
 * Credential/connection lifecycle integration checks.
 *
 * Proves both sections traverse Demo → Live → Demo with a fresh provider
 * object at every boundary, credential replacement refreshes the runtime,
 * deletion purges plaintext-bearing clients, and deleting the credential of
 * a Live section leaves it safely stopped. Provider calls are deterministic
 * fakes; credential persistence uses the real encrypted database path.
 */
if (!process.env.DATABASE_URL) {
  console.log("connection-management test SKIPPED (no DATABASE_URL)");
  process.exit(0);
}
process.env.CREDENTIALS_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.SESSION_SECRET ??= "connection-management-test-session-secret";
process.env.PORT ??= "8080";

import {
  botConfigTable,
  db,
  userBinanceCredentialsTable,
  userOandaCredentialsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { BotEngine } from "../src/lib/botEngine";
import { deleteBinanceCredentials, getBinanceCredentials, setBinanceCredentials } from "../src/lib/binanceCredentials";
import { deleteOandaCredentials, getOandaCredentials, setOandaCredentials } from "../src/lib/oandaCredentials";

const CRYPTO_USER = 990061;
const FOREX_USER = 990062;
let failures = 0;

function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(`${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`);
}

async function cleanup() {
  for (const userId of [CRYPTO_USER, FOREX_USER]) {
    await db.delete(userBinanceCredentialsTable).where(eq(userBinanceCredentialsTable.userId, userId));
    await db.delete(userOandaCredentialsTable).where(eq(userOandaCredentialsTable.userId, userId));
    await db.delete(botConfigTable).where(eq(botConfigTable.userId, userId));
  }
}

interface BuiltClient {
  id: number;
  target: "demo" | "live";
  marketType: "spot" | "futures" | "forex";
  testnet: boolean;
  markets: Record<string, any>;
  loadMarkets(): Promise<Record<string, any>>;
  fetchBalance(): Promise<any>;
}

function installProviderFakes(engine: BotEngine): BuiltClient[] {
  const built: BuiltClient[] = [];
  const e = engine as any;
  e.buildExchange = async (testnet: boolean, marketType: BuiltClient["marketType"]): Promise<BuiltClient> => {
    const target = e.executionTarget as "demo" | "live";
    const symbol = marketType === "forex" ? "EUR_USD" : marketType === "futures" ? "BTC/USDT:USDT" : "BTC/USDT";
    const client: BuiltClient = {
      id: built.length + 1,
      target,
      marketType,
      testnet,
      markets: { [symbol]: { id: marketType === "forex" ? symbol : "BTCUSDT", symbol } },
      async loadMarkets() { return this.markets; },
      async fetchBalance() {
        return { USDT: { free: 10_000, total: 10_000 }, free: { USDT: 10_000 }, total: { USDT: 10_000 } };
      },
    };
    built.push(client);
    return client;
  };
  e.reconcileOnStartup = async () => {};
  e.pollTickers = async () => {};
  e.runScan = async () => {};
  return built;
}

async function setTarget(userId: number, section: "crypto" | "forex", target: "demo" | "live") {
  await db
    .update(botConfigTable)
    .set({ executionTarget: target })
    .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)));
}

async function exerciseCrypto() {
  console.log("\n— Crypto Demo → Live → Demo —");
  await db.insert(botConfigTable).values({
    userId: CRYPTO_USER, section: "crypto", broker: "binance", marketType: "spot",
    executionTarget: "demo", mode: "research", pairs: "", testnet: true,
  });
  const engine = new BotEngine(CRYPTO_USER, "crypto");

  // The real Demo constructor must be keyless even if user credentials later
  // exist. No network call occurs until loadMarkets/fetch methods are invoked.
  const e = engine as any;
  e.executionTarget = "demo";
  const realDemoClient = await e.buildExchange(true, "spot");
  expect("Crypto Demo client has no user API key", !realDemoClient.apiKey);

  const built = installProviderFakes(engine);
  await Promise.all([engine.start(), engine.start()]);
  const demo1 = (engine as any).exchange;
  expect("Crypto starts on Demo", built.at(-1)?.target === "demo");
  expect("concurrent Crypto Start requests build only one provider client", built.length === 1, String(built.length));

  await setBinanceCredentials(CRYPTO_USER, "crypto-key-one", "crypto-secret-one");
  const [encrypted] = await db.select().from(userBinanceCredentialsTable)
    .where(eq(userBinanceCredentialsTable.userId, CRYPTO_USER));
  expect("Binance key is encrypted at rest", !!encrypted && !encrypted.encryptedApiKey.includes("crypto-key-one"));

  await setTarget(CRYPTO_USER, "crypto", "live");
  await engine.refreshConnection({ restartIfDesired: true, reason: "test: Crypto Demo to Live" });
  const live1 = (engine as any).exchange;
  expect("Crypto reconnects on Live", built.at(-1)?.target === "live");
  expect("Crypto Live does not reuse Demo client", live1 !== demo1);
  expect("successful Live reconciliation opens the entry gate", engine.getState().newEntriesAllowed);

  e.reconcileOnStartup = async () => { throw new Error("scripted provider ambiguity"); };
  await engine.refreshConnection({ restartIfDesired: true, reason: "test: fail-closed reconciliation" });
  expect("reconciliation failure keeps the Live engine running for exits", engine.isRunning());
  expect("reconciliation failure blocks only new entries",
    !engine.getState().newEntriesAllowed && engine.getState().entryBlockReason?.startsWith("Exit-only:"));
  e.reconcileOnStartup = async () => {};
  await e.attemptLiveReconciliation("integration recovery");
  expect("a later successful reconciliation re-opens the entry gate", engine.getState().newEntriesAllowed);

  await setBinanceCredentials(CRYPTO_USER, "crypto-key-two", "crypto-secret-two");
  await engine.refreshConnection({ restartIfDesired: true, reason: "test: replace Binance credentials" });
  const live2 = (engine as any).exchange;
  const replaced = await getBinanceCredentials(CRYPTO_USER);
  expect("Binance replacement is persisted", replaced?.apiKey === "crypto-key-two" && replaced.apiSecret === "crypto-secret-two");
  expect("Binance replacement creates a fresh client", live2 !== live1);

  await setTarget(CRYPTO_USER, "crypto", "demo");
  await engine.refreshConnection({ restartIfDesired: true, reason: "test: Crypto Live to Demo" });
  const demo2 = (engine as any).exchange;
  expect("Crypto returns to Demo", built.at(-1)?.target === "demo");
  expect("no stale Crypto Live client remains", demo2 !== live2 && (engine as any).exchangeIdentity?.startsWith("simulated_demo:"));

  await deleteBinanceCredentials(CRYPTO_USER);
  await engine.refreshConnection({ restartIfDesired: true, reason: "test: delete Binance credentials in Demo" });
  expect("Crypto Demo survives credential deletion", engine.isRunning() && built.at(-1)?.target === "demo");
  expect("deleted Binance credentials are unavailable", await getBinanceCredentials(CRYPTO_USER) === null);

  await setBinanceCredentials(CRYPTO_USER, "crypto-key-three", "crypto-secret-three");
  await setTarget(CRYPTO_USER, "crypto", "live");
  await engine.refreshConnection({ restartIfDesired: true, reason: "test: return Crypto to Live" });
  await deleteBinanceCredentials(CRYPTO_USER);
  await engine.refreshConnection({ restartIfDesired: false, reason: "test: delete Binance credentials in Live" });
  expect("deleting Live Binance credentials stops the engine", !engine.isRunning());
  expect("deleting Live Binance credentials purges the client", (engine as any).exchange === null && (engine as any).exchangeIdentity === null);
  expect("deleting Live Binance credentials clears auto-resume", !(await engine.isDesiredRunning()));
}

async function exerciseForex() {
  console.log("\n— Forex Demo → Live → Demo —");
  await db.insert(botConfigTable).values({
    userId: FOREX_USER, section: "forex", broker: "oanda", marketType: "forex",
    executionTarget: "demo", mode: "research", pairs: "", testnet: true,
  });
  process.env.OANDA_PLATFORM_TOKEN = "platform-practice-token";
  process.env.OANDA_PLATFORM_ACCOUNT_ID = "001-000-9999999-999";
  const engine = new BotEngine(FOREX_USER, "forex");
  const e = engine as any;
  e.executionTarget = "demo";
  const realDemoAdapter = await e.buildExchange(false, "forex");
  expect("Forex Demo uses the platform practice account", realDemoAdapter.client.accountId === "001-000-9999999-999");
  expect("Forex Demo ignores the section's Live environment flag", realDemoAdapter.client.baseUrl.includes("fxpractice"));

  const built = installProviderFakes(engine);
  await Promise.all([engine.start(), engine.start()]);
  const demo1 = (engine as any).exchange;
  expect("Forex starts on Demo", built.at(-1)?.target === "demo");
  expect("concurrent Forex Start requests build only one provider client", built.length === 1, String(built.length));

  await setOandaCredentials(FOREX_USER, "oanda-token-one", "001-000-1111111-111");
  const [encrypted] = await db.select().from(userOandaCredentialsTable)
    .where(eq(userOandaCredentialsTable.userId, FOREX_USER));
  expect("OANDA token is encrypted at rest", !!encrypted && !encrypted.encryptedToken.includes("oanda-token-one"));

  await setTarget(FOREX_USER, "forex", "live");
  await engine.refreshConnection({ restartIfDesired: true, reason: "test: Forex Demo to Live" });
  const live1 = (engine as any).exchange;
  expect("Forex reconnects on Live", built.at(-1)?.target === "live");
  expect("Forex Live does not reuse Demo client", live1 !== demo1);

  await setOandaCredentials(FOREX_USER, "oanda-token-two", "001-000-2222222-222");
  await engine.refreshConnection({ restartIfDesired: true, reason: "test: replace OANDA credentials" });
  const live2 = (engine as any).exchange;
  const replaced = await getOandaCredentials(FOREX_USER);
  expect("OANDA replacement is persisted", replaced?.token === "oanda-token-two" && replaced.accountId === "001-000-2222222-222");
  expect("OANDA replacement creates a fresh client", live2 !== live1);

  await setTarget(FOREX_USER, "forex", "demo");
  await engine.refreshConnection({ restartIfDesired: true, reason: "test: Forex Live to Demo" });
  const demo2 = (engine as any).exchange;
  expect("Forex returns to Demo", built.at(-1)?.target === "demo");
  expect("no stale Forex Live client remains", demo2 !== live2 && (engine as any).exchangeIdentity?.startsWith("simulated_demo:"));

  await deleteOandaCredentials(FOREX_USER);
  await engine.refreshConnection({ restartIfDesired: true, reason: "test: delete OANDA credentials in Demo" });
  expect("Forex Demo survives credential deletion", engine.isRunning() && built.at(-1)?.target === "demo");
  expect("deleted OANDA credentials are unavailable", await getOandaCredentials(FOREX_USER) === null);

  await setOandaCredentials(FOREX_USER, "oanda-token-three", "001-000-3333333-333");
  await setTarget(FOREX_USER, "forex", "live");
  await engine.refreshConnection({ restartIfDesired: true, reason: "test: return Forex to Live" });
  await deleteOandaCredentials(FOREX_USER);
  await engine.refreshConnection({ restartIfDesired: false, reason: "test: delete OANDA credentials in Live" });
  expect("deleting Live OANDA credentials stops the engine", !engine.isRunning());
  expect("deleting Live OANDA credentials purges the client", (engine as any).exchange === null && (engine as any).exchangeIdentity === null);
  expect("deleting Live OANDA credentials clears auto-resume", !(await engine.isDesiredRunning()));
}

async function main() {
  const oldPlatformToken = process.env.OANDA_PLATFORM_TOKEN;
  const oldPlatformAccount = process.env.OANDA_PLATFORM_ACCOUNT_ID;
  await cleanup();
  try {
    // Both sections operate independently and must survive a simultaneous
    // start/transition workload without one registry or provider state
    // suppressing the other.
    await Promise.all([exerciseCrypto(), exerciseForex()]);
  } finally {
    await cleanup();
    if (oldPlatformToken === undefined) delete process.env.OANDA_PLATFORM_TOKEN;
    else process.env.OANDA_PLATFORM_TOKEN = oldPlatformToken;
    if (oldPlatformAccount === undefined) delete process.env.OANDA_PLATFORM_ACCOUNT_ID;
    else process.env.OANDA_PLATFORM_ACCOUNT_ID = oldPlatformAccount;
  }

  console.log(failures === 0 ? "\nconnection-management: all checks passed" : `\nconnection-management: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
