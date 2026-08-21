import { chromium } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const baseUrl =
  process.env.EXECUTION_HEALTH_BROWSER_URL ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let failures = 0;
let healthMode = "blocked";

function expect(name, condition) {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

const now = new Date();
const future = new Date(now.getTime() + 60_000).toISOString();
const blockedHealth = {
  status: "BLOCKED",
  operatingMode: "PROTECTION_DEGRADED",
  operatingModeSource: "SYSTEM",
  reconciliationState: "ESCALATED",
  protectionState: "DEGRADED",
  globalDrawdownState: "UNKNOWN",
  accountDrawdownState: "UNKNOWN",
  entryBlockReason:
    "Authoritative protection and drawdown evidence are unavailable",
  ownershipGeneration: 7,
  ownerClaimedAt: now.toISOString(),
  lastReconciledAt: null,
  lastIncidentAt: now.toISOString(),
  currentEquityMinor: null,
  peakEquityMinor: null,
  equitySource: null,
  equityObservedAt: null,
  equityFreshUntil: null,
  globalCurrentEquityMinor: null,
  globalPeakEquityMinor: null,
  globalEquityObservedAt: null,
  globalEquityFreshUntil: null,
  globalEquitySourceCount: 0,
  accountDrawdownLimitBps: 2000,
  globalDrawdownLimitBps: 2500,
  runtime: {
    running: false,
    newEntriesAllowed: false,
    entryBlockReason: "Engine is stopped",
    openPositions: 1,
    lastScanAt: null,
  },
  activeSwitches: [
    {
      scope: "USER",
      scopeKey: "42",
      reason: "Operator stopped new entries",
      activatedAt: now.toISOString(),
      source: "USER",
    },
  ],
  unresolvedIntents: [
    {
      id: 91,
      symbol: "BTCUSDT",
      state: "ESCALATED",
      clientOrderId: "phase11-entry-91",
      resolutionCode: "RECOVERY_CLOSE_UNCONFIRMED",
      filledQuantity: "0.20000000",
      averageFillPrice: "60000.00000000",
      brokerOrderId: "broker-entry-91",
      brokerTradeId: null,
      recoveryClientOrderId: "tc-rec-fixed-91",
      recoveryState: "UNKNOWN",
      recoveryBrokerOrderId: null,
      recoveryAttemptedAt: now.toISOString(),
      createdAt: now.toISOString(),
      lastReconciledAt: now.toISOString(),
    },
  ],
  metrics: {
    unresolvedIntents: 1,
    reconciliationFailures: 1,
    recoveredExposure: 0,
    protectionFailures: 1,
    activeKillSwitches: 1,
    operatingModeChanges: 1,
    drawdownBreaches: 0,
    ownershipChanges: 2,
    criticalAlerts: 1,
  },
  incidents: [
    {
      id: 501,
      eventType: "CRITICAL_OPERATOR_ALERT",
      reasonCode: "LIVE_RECONCILIATION_BLOCKED",
      reason: "Recovered exposure protection remains unconfirmed",
      actorType: "system",
      occurredAt: now.toISOString(),
      source: "USER",
    },
  ],
};

const emptyHealth = {
  ...blockedHealth,
  status: "HEALTHY",
  operatingMode: "NORMAL",
  reconciliationState: "HEALTHY",
  protectionState: "HEALTHY",
  globalDrawdownState: "HEALTHY",
  accountDrawdownState: "HEALTHY",
  entryBlockReason: null,
  currentEquityMinor: "100000",
  peakEquityMinor: "100000",
  equitySource: "BINANCE_FUTURES_TOTAL_MARGIN_BALANCE",
  equityObservedAt: now.toISOString(),
  equityFreshUntil: future,
  globalCurrentEquityMinor: "100000",
  globalPeakEquityMinor: "100000",
  globalEquityObservedAt: now.toISOString(),
  globalEquityFreshUntil: future,
  globalEquitySourceCount: 1,
  runtime: {
    ...blockedHealth.runtime,
    running: true,
    newEntriesAllowed: true,
    openPositions: 0,
  },
  activeSwitches: [],
  unresolvedIntents: [],
  metrics: {
    unresolvedIntents: 0,
    reconciliationFailures: 0,
    recoveredExposure: 0,
    protectionFailures: 0,
    activeKillSwitches: 0,
    operatingModeChanges: 0,
    drawdownBreaches: 0,
    ownershipChanges: 0,
    criticalAlerts: 0,
  },
  incidents: [],
};

await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  const method = route.request().method();
  const json = (body, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  if (url.pathname === "/api/auth/status") return json({ authenticated: true });
  if (url.pathname === "/api/auth/providers")
    return json({ google: false, apple: false, demo: false });
  if (url.pathname === "/api/me/account") {
    return json({
      id: 42,
      username: "phase11-browser",
      email: null,
      displayName: "Phase 11 Browser",
      createdAt: now.toISOString(),
      hasPassword: true,
      isDemo: false,
      providers: [],
    });
  }
  if (url.pathname === "/api/config") {
    return json({
      executionTarget: "live",
      mode: "copilot",
      marketType: "futures",
      broker: "binance",
    });
  }
  if (url.pathname === "/api/sections") return json({ activated: ["crypto"] });
  if (url.pathname === "/api/healthz") return json({ status: "ok" });
  if (url.pathname === "/api/bot/status") {
    return json({
      running: false,
      dailyPnl: 0,
      openPositions: 1,
      totalTradesToday: 0,
      winRateToday: 0,
      circuitBreakerActive: false,
      riskPaused: false,
      newEntriesAllowed: false,
      entryBlockReason: "Engine is stopped",
      mode: "copilot",
    });
  }
  if (url.pathname === "/api/execution-health" && method === "GET") {
    if (healthMode === "loading") {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return json(blockedHealth);
    }
    if (healthMode === "error") return json({ error: "unavailable" }, 503);
    return json(healthMode === "empty" ? emptyHealth : blockedHealth);
  }
  if (url.pathname.startsWith("/api/execution-health/") && method === "POST") {
    return json(
      { error: "Current password is incorrect", code: "STEP_UP_REQUIRED" },
      403,
    );
  }
  return json({});
});

try {
  healthMode = "loading";
  await page.goto(`${baseUrl}/execution-health`, {
    waitUntil: "domcontentloaded",
  });
  let loadingVisible = true;
  try {
    await page
      .getByText("Loading authoritative execution health…")
      .waitFor({ timeout: 1_000 });
  } catch {
    loadingVisible = false;
  }
  expect("loading state is explicit", loadingVisible);
  await page.getByText("LIVE ENTRY AUTHORITY · BLOCKED").waitFor();

  expect(
    "persistent Live strip exposes blocked authority",
    await page
      .getByText(/Live BLOCKED · authority PROTECTION_DEGRADED\/SYSTEM/)
      .isVisible(),
  );
  expect(
    "UNKNOWN is rendered rather than zero",
    await page.getByText("UNKNOWN").first().isVisible(),
  );
  expect(
    "active kill switch is visible",
    await page.getByText("Operator stopped new entries").isVisible(),
  );
  expect(
    "unresolved recovery is visible",
    await page.getByText("phase11-entry-91").isVisible(),
  );
  expect(
    "durable incident history is visible",
    await page
      .getByText("Recovered exposure protection remains unconfirmed")
      .isVisible(),
  );
  expect(
    "Stop New Trades control is visible",
    await page.getByRole("button", { name: "Stop new trades" }).isVisible(),
  );
  expect(
    "Exit-Only control is visible",
    await page.getByRole("button", { name: "Exit-only mode" }).isVisible(),
  );

  await page.getByRole("button", { name: "Stop new trades" }).click();
  await page
    .locator("#execution-health-reason")
    .fill("Browser verification of step-up refusal");
  await page.locator("#execution-health-password").fill("wrong-password");
  const confirmAction = page.getByRole("button", {
    name: "Stop new Live trades",
  });
  expect(
    "dangerous action remains disabled for an incorrect phrase",
    await confirmAction.isDisabled(),
  );
  await page.locator("#execution-health-confirmation").fill("STOP NEW TRADES");
  expect(
    "exact confirmation enables the step-up attempt",
    await confirmAction.isEnabled(),
  );
  await confirmAction.click();
  await page.getByText("Safety action refused").waitFor();
  expect(
    "incorrect password is surfaced as an explicit refusal",
    await page.getByText("Current password is incorrect").isVisible(),
  );
  await page.getByRole("button", { name: "Cancel" }).click();

  healthMode = "empty";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("LIVE ENTRY AUTHORITY · HEALTHY").waitFor();
  expect(
    "empty unresolved state is explicit",
    await page
      .getByText("No unresolved durable intent is recorded.")
      .isVisible(),
  );
  expect(
    "empty incident state is explicit",
    await page
      .getByText("No durable safety incident is recorded for this section.")
      .isVisible(),
  );

  healthMode = "error";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByText("Execution health unavailable", { exact: true })
    .waitFor();
  expect(
    "API failure is shown as unavailable and blocked",
    await page
      .getByText(/Treat Live entry authority as unknown and blocked/)
      .isVisible(),
  );

  healthMode = "blocked";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("LIVE ENTRY AUTHORITY · BLOCKED").waitFor();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect("mobile layout has no document-level horizontal overflow", !overflow);
  await page.screenshot({
    path: path.join(os.tmpdir(), "tradecore-phase11-execution-health.png"),
    fullPage: true,
  });
} finally {
  await browser.close();
}

console.log(
  failures === 0
    ? "\nexecution-health browser: all checks passed"
    : `\nexecution-health browser: ${failures} FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
