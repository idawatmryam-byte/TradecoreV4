/**
 * OANDA BACKTEST CREDENTIALS integration test.
 *
 * A demo-mode forex user reported the platform's shared OANDA practice
 * token — already configured so demo users can trade — didn't help
 * backtesting: clientForUser() in oandaHistoricalData.ts always required
 * the REQUESTING USER's own stored OANDA credentials, with no awareness of
 * the forex section's executionTarget at all. A demo user (by definition,
 * no personal broker account) could never backtest, while the live engine's
 * buildExchange() had already solved this exact problem for live/demo
 * trading via the platform token in execution/demoMarketData.ts.
 *
 * clientForUser() now branches on executionTarget the same way
 * buildExchange() does. These checks lock in both directions: a demo
 * section uses the platform token (and ignores any personal credentials the
 * user happens to also have on file — demo must never touch a live
 * account), and a live section still requires — and uses — the user's own.
 *
 * REQUIRES a database. Part of `pnpm test:integration`.
 *
 * Run:  DATABASE_URL=... tsx harness/oanda-backtest-credentials.test.ts   (exit 0 = pass)
 */
process.env.CREDENTIALS_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.SESSION_SECRET ??= "oanda-backtest-credentials-test-session-secret";
process.env.PORT ??= "8080";

import { db, botConfigTable, userOandaCredentialsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { clientForUser } from "../src/lib/oandaHistoricalData";
import { setOandaCredentials, deleteOandaCredentials } from "../src/lib/oandaCredentials";
import { DemoDataUnavailableError } from "../src/lib/execution/demoMarketData";

const USER = 990055; // isolated test user — wiped before and after

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
  if (!cond) failures++;
}

async function cleanup() {
  await db.delete(userOandaCredentialsTable).where(eq(userOandaCredentialsTable.userId, USER));
  await db.delete(botConfigTable).where(eq(botConfigTable.userId, USER));
}

async function setExecutionTarget(target: "demo" | "live") {
  await db
    .insert(botConfigTable)
    .values({ userId: USER, section: "forex", executionTarget: target })
    .onConflictDoUpdate({
      target: [botConfigTable.userId, botConfigTable.section],
      set: { executionTarget: target },
    });
}

async function main() {
  await cleanup();
  const savedToken = process.env["OANDA_PLATFORM_TOKEN"];
  const savedAccount = process.env["OANDA_PLATFORM_ACCOUNT_ID"];

  try {
    // ── No forex config row at all: falls through to the live/default path ──
    console.log("\n— no botConfig row for this section yet —");
    let err: unknown;
    try {
      await clientForUser(USER);
    } catch (e) {
      err = e;
    }
    expect(
      "with no config row and no personal credentials, refuses with the Settings-page message",
      err instanceof Error && /Settings page/.test(err.message),
      String(err),
    );

    // ── Demo section, no platform token ──────────────────────────────────────
    console.log("\n— demo section, platform token not configured —");
    delete process.env["OANDA_PLATFORM_TOKEN"];
    delete process.env["OANDA_PLATFORM_ACCOUNT_ID"];
    await setExecutionTarget("demo");

    err = undefined;
    try {
      await clientForUser(USER);
    } catch (e) {
      err = e;
    }
    expect(
      "a demo section refuses with a typed, actionable error rather than the generic credentials message",
      err instanceof DemoDataUnavailableError,
      String(err),
    );

    // ── Demo section, platform token configured ──────────────────────────────
    console.log("\n— demo section, platform token configured —");
    process.env["OANDA_PLATFORM_TOKEN"] = "platform-demo-token";
    process.env["OANDA_PLATFORM_ACCOUNT_ID"] = "001-000-9999999-999";

    const demoClient = await clientForUser(USER);
    expect(
      "a demo section downloads with the PLATFORM account, needing no personal credentials",
      demoClient.accountId === "001-000-9999999-999",
      demoClient.accountId,
    );

    // A demo user might still have personal credentials on file (e.g. they
    // used to run live). Demo must ignore them, not silently use them.
    await setOandaCredentials(USER, "personal-token", "001-000-1111111-111");
    const demoClientStillPlatform = await clientForUser(USER);
    expect(
      "...and keeps using the platform account even when personal credentials exist",
      demoClientStillPlatform.accountId === "001-000-9999999-999",
      demoClientStillPlatform.accountId,
    );
    await deleteOandaCredentials(USER);

    // ── Live section: falls back to this exact bug's original behaviour ──────
    console.log("\n— live section —");
    await setExecutionTarget("live");

    err = undefined;
    try {
      await clientForUser(USER);
    } catch (e) {
      err = e;
    }
    expect(
      "a live section with no personal credentials still refuses, unchanged from before this fix",
      err instanceof Error && !(err instanceof DemoDataUnavailableError) && /Settings page/.test((err as Error).message),
      String(err),
    );

    await setOandaCredentials(USER, "personal-token", "001-000-1111111-111");
    const liveClient = await clientForUser(USER);
    expect(
      "a live section with personal credentials downloads with THEIR account, not the platform's",
      liveClient.accountId === "001-000-1111111-111",
      liveClient.accountId,
    );
  } finally {
    if (savedToken === undefined) delete process.env["OANDA_PLATFORM_TOKEN"];
    else process.env["OANDA_PLATFORM_TOKEN"] = savedToken;
    if (savedAccount === undefined) delete process.env["OANDA_PLATFORM_ACCOUNT_ID"];
    else process.env["OANDA_PLATFORM_ACCOUNT_ID"] = savedAccount;
    await cleanup();
  }

  console.log(failures === 0 ? "\noanda-backtest-credentials: all checks passed" : `\noanda-backtest-credentials: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
