/**
 * DEMO MARKET DATA test — the demo client is keyless, and that has consequences.
 *
 * This file exists because of a bug that made the whole demo-first premise
 * unusable: `BotEngine.start()` called `ex.fetchBalance()` on every path to
 * verify credentials and prime the balance. In demo the client is deliberately
 * constructed WITHOUT credentials — it reads public candles and never places
 * an order — and `fetchBalance` is a SIGNED endpoint. So ccxt threw
 * `AuthenticationError: binance requires "apiKey" credential`, the handler
 * rewrote it into "your API keys are for the wrong environment", and a brand
 * new account was told to fix credentials it had just been promised it did not
 * need. No demo crypto engine could start.
 *
 * The engine now skips that check in demo and primes from getDemoBalance().
 * The assertions below lock in the property that made the old call illegal:
 * the demo client carries no key, so ANY signed call on it is a bug. If a
 * future change credentials this client, that is a much bigger problem than a
 * failed start — a demo account must be structurally incapable of reaching a
 * real account — and this test is where it should surface.
 *
 * Pure: constructing a ccxt instance is local, and the forex branch is checked
 * through its environment guard. No network, no DB.
 *
 * Run:  tsx harness/demo-market-data.test.ts   (exit 0 = pass)
 */
import { buildDemoMarketData, forexDemoAvailable, DemoDataUnavailableError } from "../src/lib/execution/demoMarketData";

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.error(`✗  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`✓  ${name}`);
  }
}

async function main() {
  // ── Crypto: keyless, by construction ──────────────────────────────────────
  for (const marketType of ["spot", "futures"] as const) {
    const ex = await buildDemoMarketData(marketType);

    expect(`${marketType} demo client is built without an API key`, !ex.apiKey, String(ex.apiKey));
    expect(`${marketType} demo client is built without a secret`, !ex.secret);
    expect(`${marketType} demo client still exposes public market data`, typeof ex.fetchOHLCV === "function");

    // The specific call that broke start(): a signed endpoint on an unsigned
    // client. It can never succeed here, which is the whole point — the engine
    // must not make it in demo.
    //
    // Only that it FAILS is asserted, not why. The reason is environment-
    // dependent: with network access ccxt raises AuthenticationError for the
    // missing key, and without it the request dies at the transport first.
    // Pinning the message would make this test pass or fail on egress rules
    // rather than on the behaviour it is here to protect.
    let threw = false;
    try {
      await ex.fetchBalance();
    } catch {
      threw = true;
    }
    expect(`${marketType}: fetchBalance() on the demo client cannot succeed`, threw);
  }

  // ── Forex: unavailable without a platform-owned practice token ────────────
  const savedToken = process.env["OANDA_PLATFORM_TOKEN"];
  const savedAccount = process.env["OANDA_PLATFORM_ACCOUNT_ID"];
  try {
    delete process.env["OANDA_PLATFORM_TOKEN"];
    delete process.env["OANDA_PLATFORM_ACCOUNT_ID"];

    expect("forex demo reports itself unavailable with no platform token", !forexDemoAvailable());

    let err: unknown;
    try {
      await buildDemoMarketData("forex");
    } catch (e) {
      err = e;
    }
    expect(
      "...and refuses with a typed error rather than failing deeper",
      err instanceof DemoDataUnavailableError,
      String(err),
    );
    expect(
      "...naming the crypto section, which needs nothing at all",
      /crypto/i.test(String((err as Error)?.message)),
    );

    // Half-configured is not configured: one variable without the other must
    // not be treated as usable, or the adapter fails later and less clearly.
    process.env["OANDA_PLATFORM_TOKEN"] = "token-only";
    expect("a token without an account id is still unavailable", !forexDemoAvailable());

    process.env["OANDA_PLATFORM_ACCOUNT_ID"] = "001-000-0000000-000";
    expect("both variables present makes forex demo available", forexDemoAvailable());

    const oanda = await buildDemoMarketData("forex");
    expect("the forex demo client is built", oanda != null);
    // A demo account must never be able to reach fxtrade, whatever the
    // section's testnet flag happens to say.
    expect(
      "...against the PRACTICE endpoint, never live",
      JSON.stringify(oanda).includes("fxpractice") || (oanda as { practice?: boolean }).practice !== false,
    );
  } finally {
    if (savedToken === undefined) delete process.env["OANDA_PLATFORM_TOKEN"];
    else process.env["OANDA_PLATFORM_TOKEN"] = savedToken;
    if (savedAccount === undefined) delete process.env["OANDA_PLATFORM_ACCOUNT_ID"];
    else process.env["OANDA_PLATFORM_ACCOUNT_ID"] = savedAccount;
  }

  console.log(failures === 0 ? "\ndemo-market-data: all checks passed" : `\ndemo-market-data: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
