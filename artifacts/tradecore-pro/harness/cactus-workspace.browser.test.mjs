import { chromium } from "@playwright/test";

const baseUrl = process.env.CACTUS_BROWSER_URL ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
let failures = 0;

function expect(name, condition) {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failures += 1;
  }
}

const now = Date.now();
const config = {
  demoDataAvailable: true,
  broker: "binance",
  marketType: "futures",
  leverage: 10,
  marginMode: "isolated",
  positionSizeUsdt: 100,
  riskPercent: 1,
  maxOpenPositions: 5,
  maxPortfolioRiskPercent: 3,
  dailyLossLimitUsdt: 1000,
  maxSymbolConcentrationPercent: 100,
  maxNetExposurePercent: 200,
  maxCorrelatedExposurePercent: 200,
  correlationThreshold: 0.7,
  correlationUnknownPolicy: "allow",
  confidenceThreshold: 65,
  riskModel: "percent",
  stopLossPercent: 1,
  takeProfitPercent: 2,
  maxLossUsdt: 10,
  targetProfitUsdt: 20,
  cooldownMinutes: 15,
  scanIntervalSeconds: 15,
  pairs: ["BTCUSDT", "ETHUSDT"],
  executionTarget: "live",
  mode: "copilot",
  positionManagementMode: "phase7_active",
  demoStartingBalanceUsdt: 10000,
  testnet: false,
  backtestMode: false,
  highFrequencyTestMode: false,
  alertWebhookUrl: null,
};
const session = {
  schemaVersion: "cactus-dashboard-session-v1",
  asOf: new Date(now).toISOString(),
  context: {
    section: "crypto",
    market: "Crypto",
    broker: "binance",
    marketType: "futures",
    environment: { id: "BINANCE_LIVE", label: "Binance Live", realFunds: true },
    account: {
      id: "binance:configured",
      label: "Binance ••••ABCD",
      singleConnectionPerMarket: true,
    },
    mode: {
      configured: "copilot",
      backendValue: "copilot",
      effectiveAuthority: "USER_APPROVAL_REQUIRED",
    },
  },
  metrics: {
    availableFunds: {
      state: "unavailable",
      value: null,
      unit: "currency",
      source: null,
      observedAt: null,
      reason: "Authoritative free balance is unavailable",
    },
    equity: {
      state: "unavailable",
      value: null,
      unit: "currency",
      source: null,
      observedAt: null,
      reason: "Persisted Live equity is stale",
    },
    marginUsed: {
      state: "unavailable",
      value: null,
      unit: "currency",
      source: null,
      observedAt: null,
      reason: "Authoritative margin is unavailable",
    },
    realizedDayPnl: {
      state: "available",
      value: -12.5,
      unit: "currency",
      source: "trades",
      observedAt: new Date(now).toISOString(),
      reason: null,
    },
    exposure: {
      state: "unavailable",
      value: null,
      unit: "currency",
      source: null,
      observedAt: null,
      reason: "Mark prices are unavailable",
    },
    drawdown: {
      state: "unavailable",
      value: null,
      unit: "percent",
      source: null,
      observedAt: null,
      reason: "Equity evidence is stale",
    },
    risk: {
      state: "BLOCKED",
      newEntriesAllowed: false,
      protectiveManagementContinues: true,
      reason: "Live reconciliation is unknown",
    },
  },
  runtime: {
    running: true,
    startedAt: new Date(now - 60_000).toISOString(),
    lastScanAt: new Date(now - 120_000).toISOString(),
    circuitBreakerActive: false,
    openPositionCount: 1,
    tradesToday: 2,
  },
  health: {
    api: { state: "available", label: "API" },
    database: { state: "available", label: "Database" },
    broker: {
      state: "unavailable",
      label: "Binance",
      reason: "Connection evidence unavailable",
    },
    marketData: {
      state: "stale",
      label: "Market data",
      reason: "Last observation is stale",
      observedAt: new Date(now - 120_000).toISOString(),
      ageMs: 120000,
    },
    execution: {
      state: "unavailable",
      label: "Execution",
      reason: "Live reconciliation is unknown",
    },
  },
  activity: {
    positions: [
      {
        id: 91,
        symbol: "BTCUSDT",
        side: "long",
        quantity: 0.1,
        entryPrice: 62000,
        stopLoss: 60000,
        takeProfit: 66000,
        strategyId: "trend",
        strategyName: "Trend Guard",
        executionTarget: "live",
        executionAuthority: "copilot",
        managementAuthority: "phase7",
        entryTime: new Date(now - 3600000).toISOString(),
      },
    ],
    pendingOrders: {
      state: "unavailable",
      orders: null,
      reason: "No authoritative pending-order projection exists.",
    },
    recentTrades: [],
    recommendations: [
      {
        id: 501,
        symbol: "ETHUSDT",
        side: "short",
        confidence: 0.82,
        entryPrice: 3400,
        stopLoss: 3500,
        takeProfit: 3200,
        quantity: 0.2,
        strategyId: "mean-reversion",
        strategyName: "Mean Reversion",
        executionTarget: "live",
        status: "created",
        expiresAt: new Date(now + 60000).toISOString(),
        createdAt: new Date(now).toISOString(),
        approvalRequired: true,
      },
    ],
  },
  performance: {
    live: { sampleSize: 4, totalPnl: -12.5, winRate: 0.5 },
    demo: { sampleSize: 12, totalPnl: 84.2, winRate: 0.66 },
    separatedByExecutionTarget: true,
  },
  autopilot: null,
  alerts: [
    {
      id: "risk",
      severity: "critical",
      source: "execution",
      message:
        "Live reconciliation is unknown. New entries are blocked; protective management continues.",
      occurredAt: new Date(now).toISOString(),
      persistent: true,
    },
  ],
  limitations: [
    "Manual entry is unavailable until its financial-path architecture gate is complete.",
    "Pending orders remain unknown until an authoritative projection exists.",
  ],
};

async function installRoutes(page, options = {}) {
  let routeConfig = { ...config, ...(options.config ?? {}) };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (url.pathname === "/api/auth/status")
      return json({ authenticated: true });
    if (url.pathname === "/api/auth/providers")
      return json({ google: false, apple: false, demo: false });
    if (url.pathname === "/api/me/account")
      return json({
        id: 42,
        username: "cactus-browser",
        email: null,
        displayName: "Cactus Browser",
        createdAt: new Date(now).toISOString(),
        hasPassword: true,
        isDemo: false,
        providers: [],
      });
    if (url.pathname === "/api/sections")
      return json({ activated: ["crypto"] });
    if (url.pathname === "/api/config") {
      if (route.request().method() === "PUT") {
        const update = route.request().postDataJSON();
        routeConfig = { ...routeConfig, ...update };
        options.onConfigUpdate?.(update);
        return json(routeConfig);
      }
      return json(routeConfig);
    }
    if (url.pathname === "/api/bot/status")
      return json({
        running: true,
        dailyPnl: -12.5,
        openPositions: 1,
        totalTradesToday: 2,
        winRateToday: 0.5,
        circuitBreakerActive: false,
        riskPaused: false,
        newEntriesAllowed: false,
        entryBlockReason: "Live reconciliation is unknown",
        mode: "copilot",
      });
    if (url.pathname === "/api/execution-health")
      return json({ status: "BLOCKED", operatingMode: "PROTECTION_DEGRADED" });
    if (url.pathname === "/api/capabilities")
      return json({
        schemaVersion: "cactus-trader-capabilities-v1",
        section: "crypto",
        financialRole: "OWNER",
        readOnlyDemoAccount: false,
        modes: {
          manual: { supported: false, reason: "Architecture gate incomplete" },
          brain: {
            supported: true,
            backendMode: "research",
            canExecute: false,
          },
          copilot: {
            supported: true,
            approvalRequired: true,
            canApprove: true,
          },
          autopilot: {
            supported: true,
            uiSelectionGrantsAuthority: false,
            liveAuthorityEnabled: false,
          },
        },
        accounts: {
          multipleBrokerAccounts: false,
          demo: { supported: true, label: "Cactus Demo" },
          broker: {
            provider: "binance",
            configured: true,
            maskedIdentifier: "••••ABCD",
            environments: ["BINANCE_TESTNET", "BINANCE_LIVE"],
          },
        },
        features: {
          dashboardSession: true,
          strategyModeAssignments: true,
          pendingOrders: false,
          pendingOrdersReason: "No authoritative projection",
          manualEntry: false,
          externalAiProviders: false,
          multipleBrokerAccounts: false,
          adminConsole: true,
        },
        serverAuthoritative: true,
        generatedAt: new Date(now).toISOString(),
      });
    if (url.pathname === "/api/dashboard/session")
      return json(options.session ?? session);
    if (url.pathname === "/api/copilot/recommendations/501")
      return json(options.workspace ?? {});
    if (url.pathname === "/api/copilot/recommendations/501/execute") {
      options.onExecute?.(route.request().postDataJSON());
      return json({
        ok: true,
        status: "executed",
        reason: "One controlled Demo attempt executed",
        tradeId: 991,
      });
    }
    if (url.pathname === "/api/autopilot/control")
      return json(
        options.autopilotControl ?? {
          globalSuspended: false,
          versions: [],
          mandates: [],
          events: [],
          snapshot: {},
        },
      );
    if (url.pathname === "/api/autopilot/brain-versions/7/transition")
      return json({
        id: 7,
        version: "brain-v0",
        implementation: "brain-v0-control",
        state: "DEMO_APPROVED",
        fingerprint: "c".repeat(64),
      });
    if (url.pathname === "/api/autopilot/mandates") {
      options.onMandate?.(route.request().postDataJSON());
      return json({ id: 77 }, 201);
    }
    if (url.pathname === "/api/autopilot/activate") {
      options.onActivate?.(route.request().postDataJSON());
      return json({
        state: "AUTOPILOT_ENABLED",
        reason: "Enabled from shared setup",
      });
    }
    if (url.pathname === "/api/notifications")
      return json({ notifications: [], unreadCount: 0 });
    if (url.pathname === "/api/market/candles")
      return json({
        candles: [
          [now - 60000, 62000, 62500, 61800, 62300, 10],
          [now, 62300, 62400, 61900, 62100, 12],
        ],
      });
    if (url.pathname === "/api/strategies")
      return json(
        options.strategies ?? [
          {
            strategyId: "trend",
            strategyName: "Trend Guard",
            version: "engine-v1",
            fingerprint: "a".repeat(64),
            kind: "built-in",
            supportedMarket: "crypto",
            config: { enabled: true },
            assignment: {
              strategyId: "trend",
              brain: true,
              copilot: true,
              autopilot: false,
              revision: 1,
              updatedAt: new Date(now).toISOString(),
            },
            performance: { totalTrades: 12, winRate: 0.58, totalPnl: 84.2 },
          },
        ],
      );
    return json({});
  });
}

const desktop = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
});
await installRoutes(desktop);
await desktop.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
expect(
  "trader navigation has exactly four primary entries",
  (await desktop.locator("aside nav a").allTextContents()).filter((text) =>
    ["Dashboard", "Strategies", "Backtest Lab", "Settings"].includes(
      text.trim(),
    ),
  ).length === 4,
);
expect(
  "Live real-funds state is textual and persistent",
  await desktop
    .getByText("BINANCE LIVE — REAL FUNDS", { exact: true })
    .isVisible(),
);
expect(
  "effective Co-Pilot approval state is explicit",
  await desktop
    .getByText("Your approval is required", { exact: false })
    .isVisible(),
);
expect(
  "unknown metrics are not rendered as zero",
  (await desktop.getByText("Unavailable", { exact: true }).count()) >= 3,
);
await desktop.getByRole("tab", { name: "Pending orders" }).click();
expect(
  "pending-order read failure remains unavailable",
  await desktop
    .getByText("Pending orders unavailable", { exact: true })
    .isVisible(),
);
expect(
  "stale chart warning is visible",
  await desktop
    .getByText("Market data is stale", { exact: false })
    .first()
    .isVisible(),
);
expect(
  "Admin link is profile-only, not trader navigation",
  (await desktop.locator("aside nav a[href='/admin/']").count()) === 0,
);
expect(
  "profile Admin link uses the canonical Admin directory URL",
  (await desktop.getByRole("link", { name: "Open Admin Console" }).getAttribute("href")) === "/admin/",
);

let savedSetup = null;
await desktop.unrouteAll({ behavior: "wait" });
await installRoutes(desktop, {
  onConfigUpdate: (body) => {
    savedSetup = body;
  },
});
await desktop.reload({ waitUntil: "networkidle" });
await desktop.getByRole("button", { name: "Trade setup" }).click();
expect(
  "Dashboard exposes one shared Co-Pilot and AutoPilot setup",
  await desktop
    .getByText("Co-Pilot & AutoPilot trade setup", { exact: true })
    .isVisible(),
);
await desktop.getByRole("button", { name: /Fast/ }).click();
await desktop.getByRole("button", { name: "Save shared setup" }).click();
await desktop.waitForFunction(
  () => !document.body.innerText.includes("Co-Pilot & AutoPilot trade setup"),
);
expect(
  "Fast cadence saves a five-second scan",
  savedSetup?.scanIntervalSeconds === 5,
);
expect(
  "Fast cadence saves a five-minute symbol cooldown",
  savedSetup?.cooldownMinutes === 5,
);

await desktop.getByRole("button", { name: "Trade setup" }).click();
await desktop.getByRole("button", { name: "Dollar model" }).click();
expect(
  "Dollar Model hides the irrelevant percentage-risk field",
  (await desktop.getByLabel("Account risk per trade (%)").count()) === 0,
);
expect(
  "Dollar Model explains which protection values are active",
  await desktop
    .getByText("Dollar Model uses Maximum loss and Target profit", {
      exact: false,
    })
    .isVisible(),
);
await desktop.getByLabel("Maximum loss (USDT)").fill("20");
await desktop.getByRole("button", { name: "Save shared setup" }).click();
await desktop.waitForFunction(
  () => !document.body.innerText.includes("Co-Pilot & AutoPilot trade setup"),
);
expect(
  "Dollar Model saves its maximum loss without percentage-risk validation",
  savedSetup?.riskModel === "dollar" &&
    savedSetup?.maxLossUsdt === 20 &&
    savedSetup?.riskPercent === 1,
);

await desktop.getByRole("button", { name: /Strategies/ }).click();
expect(
  "strategy drawer separates requested set from active authority",
  await desktop
    .getByText("AutoPilot authority is immutable", { exact: false })
    .isVisible(),
);
expect(
  "current authorized state is not fabricated",
  (await desktop.getByText("Authorized now", { exact: true }).count()) === 0,
);

const demoSession = structuredClone(session);
demoSession.context.environment = {
  id: "CACTUS_DEMO",
  label: "Cactus Demo",
  realFunds: false,
};
demoSession.context.account = {
  id: "cactus:demo",
  label: "Cactus Demo",
  singleConnectionPerMarket: true,
};
demoSession.activity.recommendations[0].executionTarget = "demo";
demoSession.alerts = [];
let executedApproval = null;
let createdMandate = null;
let activationRequest = null;
const workspace = {
  recommendation: {
    id: 501,
    status: "created",
    authoredBy: "engine",
    symbol: "ETHUSDT",
    strategyId: "mean-reversion",
    strategyName: "Mean Reversion",
    side: "short",
    confidence: 0.82,
    entryPrice: 3400,
    slPrice: 3500,
    tpPrice: 3200,
    qty: 0.2,
    leverage: 10,
    planFingerprint: "a".repeat(64),
    expiresAt: new Date(now + 60000).toISOString(),
    createdAt: new Date(now).toISOString(),
    executionTarget: "demo",
    decisionBundleFingerprint: "b".repeat(64),
    approvalState: "APPROVABLE",
  },
  decisionTrace: [],
  portfolioImpact: {},
  similarTrades: {},
  decisionBundle: null,
  decisionBundleFingerprint: "b".repeat(64),
  executionTarget: "demo",
  approvalChallenge: "11111111-1111-4111-8111-111111111111",
  approvalState: "APPROVABLE",
  approvalReadiness: { approvable: true, reason: "Ready", checks: [] },
  auditEvents: [],
};
const demo = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await installRoutes(demo, {
  session: demoSession,
  config: { executionTarget: "demo", testnet: false },
  workspace,
  onExecute: (body) => {
    executedApproval = body;
  },
  strategies: [
    {
      strategyId: "trend",
      strategyName: "Trend Guard",
      version: "engine-v1",
      fingerprint: "a".repeat(64),
      kind: "built-in",
      supportedMarket: "crypto",
      config: { enabled: true },
      assignment: {
        strategyId: "trend",
        brain: true,
        copilot: true,
        autopilot: true,
        revision: 2,
        updatedAt: new Date(now).toISOString(),
      },
      performance: { totalTrades: 12, winRate: 0.58, totalPnl: 84.2 },
    },
  ],
  autopilotControl: {
    globalSuspended: false,
    versions: [
      {
        id: 7,
        version: "brain-v0",
        implementation: "brain-v0-control",
        state: "COPILOT",
        fingerprint: "c".repeat(64),
      },
    ],
    mandates: [],
    events: [],
    snapshot: {},
  },
  onMandate: (body) => {
    createdMandate = body;
  },
  onActivate: (body) => {
    activationRequest = body;
  },
});
await demo.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
await demo.getByRole("button", { name: "Approve", exact: true }).click();
await demo.waitForFunction(() =>
  document.body.innerText.includes("Trade executed"),
);
expect(
  "Demo Co-Pilot Approve submits immediately without opening the review page",
  new URL(demo.url()).pathname.endsWith("/dashboard"),
);
expect(
  "Demo approval preserves the immutable plan fingerprint",
  executedApproval?.expectedPlanFingerprint === "a".repeat(64),
);
expect(
  "Demo approval sends the exact server challenge",
  executedApproval?.approvalChallenge ===
    "11111111-1111-4111-8111-111111111111",
);
expect(
  "Demo approval declares the Demo target",
  executedApproval?.executionTarget === "demo",
);
await demo
  .getByRole("button", { name: /AutoPilot/ })
  .first()
  .click();
expect(
  "AutoPilot opens one bounded review instead of the legacy control center",
  await demo
    .getByRole("heading", { name: "Enable AutoPilot with this setup" })
    .isVisible(),
);
await demo.getByRole("button", { name: "Enable Demo AutoPilot" }).click();
await demo.getByText("Demo AutoPilot enabled", { exact: true }).waitFor();
expect(
  "simple AutoPilot enable freezes the shared market set",
  createdMandate?.instruments?.join(",") === "BTCUSDT,ETHUSDT",
);
expect(
  "futures AutoPilot mandate caps the configured plan notional",
  createdMandate?.maximumPositionSizeUsdt === 1000,
);
expect(
  "simple AutoPilot enable still requires an immutable mandate id",
  activationRequest?.mandateId === 77,
);

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await installRoutes(mobile);
await mobile.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
expect(
  "mobile has no document-level horizontal overflow",
  await mobile.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  ),
);
await mobile.getByRole("button", { name: "Open navigation" }).click();
expect(
  "mobile drawer exposes all four trader areas",
  (await mobile.getByRole("link").allTextContents()).filter((text) =>
    ["Dashboard", "Strategies", "Backtest Lab", "Settings"].includes(
      text.trim(),
    ),
  ).length >= 4,
);

await desktop.close();
await demo.close();
await mobile.close();
await browser.close();

if (failures > 0) {
  console.error(
    `FAIL: ${failures} Cactus workspace browser assertion(s) failed`,
  );
  process.exit(1);
}
console.log(
  "PASS: Cactus trader workspace critical desktop and mobile states verified",
);
