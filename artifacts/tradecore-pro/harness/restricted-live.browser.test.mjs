import { chromium } from "@playwright/test";

const baseUrl =
  process.env.RESTRICTED_LIVE_BROWSER_URL ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.on("pageerror", (error) =>
  console.error(`  PAGE ERROR  ${error.stack ?? error.message}`),
);
page.on("console", (message) => {
  if (message.type() === "error") console.error(`  BROWSER ERROR  ${message.text()}`);
});
let failures = 0;
let role = "OWNER";
let degraded = [];
let mandate = null;
let previous = null;
let nextId = 12;
const now = new Date();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function expect(name, condition) {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}
function view(body, state) {
  return {
    id: body?.id ?? nextId,
    mandateKey: body?.mandateKey ?? "00000000-0000-4000-8000-000000000012",
    revision: body?.revision ?? 1,
    replacesMandateId: body?.replacesMandateId ?? null,
    userId: 42,
    tenantId: "user:42",
    section: "crypto",
    lifecycleState: state,
    fingerprint: body?.fingerprint ?? "e".repeat(64),
    terms: body.terms,
    changeReason: body.changeReason,
    approvingHumanId: state === "ACTIVE" ? 42 : null,
    authorizationMethod: state === "ACTIVE" ? "PASSWORD_STEP_UP" : null,
    authorizedAt: state === "ACTIVE" ? new Date().toISOString() : null,
    createdByUserId: 42,
    createdAt: now.toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
const brain = {
  id: 7,
  userId: 42,
  section: "crypto",
  version: "brain-v0",
  implementation: "brain-v0-control",
  state: "DEMO_APPROVED",
  fingerprint: "a".repeat(64),
  sourceCommit: "1234567",
  evidenceReferences: [],
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};
const demoMandate = {
  id: 4,
  schemaVersion: "phase10-demo-autopilot-v1",
  userId: 42,
  section: "crypto",
  version: 1,
  botConfigId: 1,
  configFingerprint: "b".repeat(64),
  brainVersionId: 7,
  brainVersion: "brain-v0",
  executionAuthority: "simulated_demo",
  marketType: "futures",
  instruments: ["BTCUSDT", "ETHUSDT"],
  strategyVersions: { momentum: "strategy-v3" },
  maximumPositionSizeUsdt: 100,
  maximumLeverage: 5,
  maximumPortfolioRiskPercent: 5,
  maximumSymbolExposurePercent: 20,
  maximumNetExposurePercent: 50,
  maximumCorrelatedExposurePercent: 50,
  dailyLossLimitUsdt: 25,
  maximumDrawdownPercent: 5,
  maximumConcurrentPositions: 2,
  maximumMarketDataAgeSeconds: 30,
  allowedTradingHoursUtc: [],
  permittedPhase7Actions: ["HOLD", "EXIT"],
  validFrom: now.toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  fingerprint: "c".repeat(64),
  createdAt: now.toISOString(),
};
const config = {
  demoDataAvailable: true,
  broker: "binance",
  marketType: "futures",
  leverage: 5,
  marginMode: "isolated",
  positionSizeUsdt: 100,
  riskPercent: 1,
  maxOpenPositions: 2,
  maxPortfolioRiskPercent: 5,
  dailyLossLimitUsdt: 25,
  maxSymbolConcentrationPercent: 20,
  maxNetExposurePercent: 50,
  maxCorrelatedExposurePercent: 50,
  correlationThreshold: 0.7,
  correlationUnknownPolicy: "block",
  confidenceThreshold: 70,
  riskModel: "percent",
  stopLossPercent: 1,
  takeProfitPercent: 2,
  maxLossUsdt: 10,
  targetProfitUsdt: 20,
  cooldownMinutes: 15,
  scanIntervalSeconds: 15,
  pairs: ["BTCUSDT", "ETHUSDT"],
  executionTarget: "live",
  mode: "autopilot",
  positionManagementMode: "fixed",
  demoStartingBalanceUsdt: 10000,
  testnet: false,
  backtestMode: false,
  highFrequencyTestMode: false,
  alertWebhookUrl: null,
};

function control() {
  const mandates = [mandate, previous].filter(Boolean);
  const active =
    mandates.find((item) => item.lifecycleState === "ACTIVE") ?? null;
  return {
    authorityLabel: "RESTRICTED_LIVE",
    productionActivationRequired: true,
    role,
    eligibleAccounts: [
      {
        accountId: "account-fingerprint-123",
        authorities: ["binance_futures_live"],
      },
    ],
    activeMandate: active,
    mandates,
    usage: active
      ? {
          status: "CURRENT",
          calculatedAt: now.toISOString(),
          currency: "USDT",
          monetaryScale: 8,
          openPositionCount: 0,
          openOrderCount: 0,
          aggregateExposure: "0",
          remainingExposure: "25000000000",
          canaryUsed: "0",
          canaryRemaining: "10000000000",
          dailyLoss: "0",
          weeklyLoss: "0",
          monthlyLoss: "0",
          drawdownBps: 0,
          maximumPossibleExposure: "10000000000",
          staleReasons: [],
        }
      : null,
    events: mandates.map((item, index) => ({
      id: index + 1,
      mandateId: item.id,
      eventType: `MANDATE_${item.lifecycleState}`,
      actorType: "HUMAN",
      actorUserId: 42,
      reasonCode: `MANDATE_${item.lifecycleState}`,
      reason: item.changeReason,
      fromState: null,
      toState: item.lifecycleState,
      fingerprint: item.fingerprint,
      occurredAt: now.toISOString(),
    })),
    decisions: active
      ? [
          {
            id: 1,
            mandateId: active.id,
            decisionFingerprint: "d".repeat(64),
            riskFingerprint: "f".repeat(64),
            status: "REFUSED",
            reasonCode: "SYMBOL_SCOPE_MISMATCH",
            reason: "SOLUSDT is outside scope",
            intentId: null,
            tradeId: null,
            createdAt: now.toISOString(),
          },
        ]
      : [],
    degradedReasons: degraded,
  };
}

await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  const method = route.request().method();
  const json = (body, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  if (method === "POST" && url.pathname.startsWith("/api/trading-mandates")) {
    const body = route.request().postDataJSON();
    if (!UUID.test(body.clientRequestId)) {
      return json({ error: "clientRequestId must be a UUID" }, 400);
    }
    if (url.pathname.endsWith("/approve") && !UUID.test(body.authorizationId)) {
      return json({ error: "authorizationId must be a UUID" }, 400);
    }
  }
  if (url.pathname === "/api/auth/status") return json({ authenticated: true });
  if (url.pathname === "/api/auth/providers")
    return json({ google: false, apple: false, demo: false });
  if (url.pathname === "/api/me/account")
    return json({
      id: 42,
      username: "phase12-browser",
      email: null,
      displayName: "Phase 12 Browser",
      createdAt: now.toISOString(),
      hasPassword: true,
      isDemo: false,
      providers: [],
    });
  if (url.pathname === "/api/config") return json(config);
  if (url.pathname === "/api/sections") return json({ activated: ["crypto"] });
  if (url.pathname === "/api/healthz") return json({ status: "ok" });
  if (url.pathname === "/api/bot/status")
    return json({
      running: false,
      dailyPnl: 0,
      openPositions: 0,
      totalTradesToday: 0,
      winRateToday: 0,
      circuitBreakerActive: false,
      riskPaused: false,
      newEntriesAllowed: false,
      entryBlockReason: "Engine stopped",
      mode: "autopilot",
    });
  if (url.pathname === "/api/execution-health")
    return json({
      status: "BLOCKED",
      operatingMode: "EXIT_ONLY",
      operatingModeSource: "SYSTEM",
      entryBlockReason: "Production activation not performed",
    });
  if (url.pathname === "/api/autopilot/control")
    return json({
      globalSuspended: true,
      liveAuthorityEnabled: false,
      authorityBoundary: ["simulated_demo"],
      snapshot: {},
      versions: [brain],
      mandates: [demoMandate],
      events: [],
    });
  if (url.pathname === "/api/trading-mandates" && method === "GET")
    return json(control());
  if (url.pathname === "/api/trading-mandates" && method === "POST") {
    const body = route.request().postDataJSON();
    previous = mandate;
    mandate = view(
      {
        ...body,
        id: nextId++,
        revision: body.expectedNextRevision,
        replacesMandateId: body.replacesMandateId,
        mandateKey: previous?.mandateKey,
      },
      "DRAFT",
    );
    return json(mandate, 201);
  }
  const match = url.pathname.match(
    /^\/api\/trading-mandates\/(\d+)\/(submit|approve|suspend|revoke)$/,
  );
  if (match && method === "POST") {
    const action = match[2];
    const target = [mandate, previous].find(
      (item) => item?.id === Number(match[1]),
    );
    if (!target) return json({ error: "not found" }, 404);
    const state =
      action === "submit"
        ? "PENDING_APPROVAL"
        : action === "approve"
          ? "ACTIVE"
          : action === "suspend"
            ? "SUSPENDED"
            : "REVOKED";
    Object.assign(target, {
      lifecycleState: state,
      approvingHumanId: state === "ACTIVE" ? 42 : target.approvingHumanId,
      authorizationMethod:
        state === "ACTIVE" ? "PASSWORD_STEP_UP" : target.authorizationMethod,
      authorizedAt:
        state === "ACTIVE" ? new Date().toISOString() : target.authorizedAt,
    });
    if (action === "approve" && previous?.lifecycleState === "ACTIVE")
      previous.lifecycleState = "REPLACED";
    return json(target);
  }
  return json({});
});

try {
  await page.goto(`${baseUrl}/restricted-live`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByText("REAL-MONEY CAPABLE · EXPLICIT ACTIVATION REQUIRED")
    .waitFor();
  expect(
    "Restricted Live is unmistakable from Demo",
    await page.getByRole("heading", { name: "Restricted Live" }).isVisible(),
  );
  expect(
    "empty authority is explicit",
    await page
      .getByText("No active mandate. Autonomous Live entry has no authority.")
      .isVisible(),
  );
  expect(
    "maximum exposure explanation is visible",
    await page.getByText("Maximum possible financial exposure").isVisible(),
  );
  expect(
    "server-derived account is shown without credentials",
    (await page.getByText(/account-fingerprint/).count()) === 0,
  );

  await page.getByRole("button", { name: "Create immutable draft" }).click();
  await page.getByRole("button", { name: "Submit exact revision" }).waitFor();
  expect(
    "draft creation workflow is visible",
    await page.getByText("DRAFT", { exact: true }).first().isVisible(),
  );
  await page.getByRole("button", { name: "Submit exact revision" }).click();
  await page.getByLabel("Current password").waitFor();
  expect(
    "pending approval exposes step-up and no authority",
    await page
      .getByText("PENDING_APPROVAL", { exact: true })
      .first()
      .isVisible(),
  );
  await page.getByLabel("Current password").fill("browser-only-fixture");
  await page.getByRole("button", { name: "Authorize exact revision" }).click();
  await page.getByRole("button", { name: "Suspend entries" }).waitFor();
  expect(
    "approval identity and audit are visible",
    await page.getByText("User 42").isVisible(),
  );
  expect(
    "recent refusal is clearly non-executable",
    await page.getByText("SYMBOL_SCOPE_MISMATCH").isVisible(),
  );

  await page.getByRole("button", { name: "Create immutable draft" }).click();
  await page.getByText("Old versus new").waitFor();
  expect(
    "replacement revision comparison is visible",
    await page.getByText(/replaces mandate/).isVisible(),
  );

  mandate = previous;
  previous = null;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Suspend entries" }).click();
  await page.getByText("SUSPENDED", { exact: true }).first().waitFor();
  expect(
    "suspension is persistent and revocable",
    await page.getByText("SUSPENDED", { exact: true }).first().isVisible(),
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Revoke permanently" }).click();
  await page.getByText("REVOKED", { exact: true }).first().waitFor();
  expect(
    "revocation state is explicit",
    await page.getByText("REVOKED", { exact: true }).first().isVisible(),
  );

  mandate.lifecycleState = "EXPIRED";
  degraded = [
    "Active mandate usage is unavailable or stale; entry fails closed",
  ];
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("EXPIRED", { exact: true }).first().waitFor();
  await page
    .getByText("Entry authority is degraded and fails closed")
    .waitFor();
  expect(
    "expired state is explicit",
    await page.getByText("EXPIRED", { exact: true }).first().isVisible(),
  );
  expect(
    "degraded state names fail-closed behavior",
    await page
      .getByText("Entry authority is degraded and fails closed")
      .isVisible(),
  );

  role = "VIEWER";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("View-only access").waitFor();
  expect(
    "permission-denied state is explicit",
    await page.getByText("View-only access").isVisible(),
  );
  expect(
    "viewer cannot create authority",
    await page
      .getByRole("button", { name: "Create immutable draft" })
      .isDisabled(),
  );
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n${failures} Restricted Live browser check(s) failed`);
  process.exit(1);
}
console.log("\nAll Restricted Live browser workflows passed");
