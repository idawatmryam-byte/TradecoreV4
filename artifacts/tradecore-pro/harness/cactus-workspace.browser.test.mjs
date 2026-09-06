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
  const routeSession = structuredClone(options.session ?? session);
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
        options.onConfigUpdate?.(update);
        if (options.configError)
          return json({ error: options.configError }, 409);
        routeConfig = { ...routeConfig, ...update };
        if (update.mode) {
          routeSession.context.mode = {
            configured: update.mode === "research" ? "brain" : update.mode,
            backendValue: update.mode,
            effectiveAuthority:
              update.mode === "research"
                ? "ANALYSIS_ONLY"
                : update.mode === "copilot"
                  ? "USER_APPROVAL_REQUIRED"
                  : "NOT_AUTHORIZED",
          };
        }
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
        newEntriesAllowed: routeSession.metrics.risk.newEntriesAllowed,
        entryBlockReason: routeSession.metrics.risk.reason,
        mode: "copilot",
      });
    if (
      url.pathname === "/api/bot/start" &&
      route.request().method() === "POST"
    ) {
      options.onStart?.();
      if (options.startError) return json({ error: options.startError }, 409);
      routeSession.runtime.running = true;
      return json({
        running: true,
        startedAt: new Date(now).toISOString(),
        lastScanAt: new Date(now).toISOString(),
        circuitBreakerActive: false,
        openPositionCount: 0,
        tradesToday: 0,
      });
    }
    if (
      url.pathname === "/api/bot/stop" &&
      route.request().method() === "POST"
    ) {
      options.onStop?.();
      if (options.stopError) return json({ error: options.stopError }, 409);
      routeSession.runtime.running = false;
      return json({ running: false });
    }
    if (url.pathname === "/api/execution-health")
      return json({ status: "BLOCKED", operatingMode: "PROTECTION_DEGRADED" });
    if (url.pathname === "/api/capabilities")
      return json({
        schemaVersion: "cactus-trader-capabilities-v1",
        section: "crypto",
        financialRole: "OWNER",
        readOnlyDemoAccount: options.readOnly === true,
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
    if (url.pathname === "/api/dashboard/session") {
      if (options.sessionError)
        return json({ error: options.sessionError }, 503);
      return json(routeSession);
    }
    if (url.pathname === "/api/copilot/recommendations/501")
      return json(options.workspace ?? {});
    if (url.pathname === "/api/copilot/inbox")
      return json(options.copilotInbox ?? { recommendations: [] });
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
    if (url.pathname === "/api/trades") return json(options.trades ?? []);
    if (
      /^\/api\/trades\/\d+\/close$/.test(url.pathname) &&
      route.request().method() === "POST"
    ) {
      const tradeId = Number(url.pathname.split("/")[3]);
      options.onClose?.(tradeId);
      if (options.closeError) return json({ error: options.closeError }, 409);
      routeSession.activity.positions = routeSession.activity.positions.filter(
        (position) => position.id !== tradeId,
      );
      routeSession.runtime.openPositionCount =
        routeSession.activity.positions.length;
      return json({ ok: true });
    }
    if (url.pathname === "/api/market/state") return json([]);
    if (url.pathname === "/api/market/candles") {
      options.onCandles?.(Object.fromEntries(url.searchParams));
      return json({
        candles: options.candles ?? [
          [now - 60000, 62000, 62500, 61800, 62300, 10],
          [now, 62300, 62400, 61900, 62100, 12],
        ],
      });
    }
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
  "trader navigation has all five primary entries",
  (await desktop.locator("aside nav a").allTextContents()).filter((text) =>
    [
      "Dashboard",
      "Strategies",
      "Backtest Lab",
      "Activity",
      "Settings",
    ].includes(text.trim()),
  ).length === 5,
);
expect(
  "Live real-funds state is textual and persistent",
  await desktop
    .getByText("Binance Live — real funds", { exact: true })
    .isVisible(),
);
expect(
  "effective Co-Pilot approval state is explicit",
  await desktop
    .getByText("Your approval is required", { exact: false })
    .isVisible(),
);
expect(
  "dashboard has one clear trading overview heading",
  await desktop
    .getByRole("heading", { name: "Trading overview", exact: true })
    .isVisible(),
);
await desktop
  .getByRole("button", { name: "View details", exact: true })
  .click();
const metricsDialog = desktop.getByRole("dialog", { name: "Account metrics" });
expect(
  "metric details preserve unavailable values and their evidence reasons",
  (await metricsDialog.getByText(/Unavailable/).count()) >= 3 &&
    (await metricsDialog
      .getByText("Authoritative free balance is unavailable", { exact: true })
      .isVisible()),
);
await desktop.keyboard.press("Escape");
await desktop.waitForFunction(
  () => document.activeElement?.textContent?.trim() === "View details",
);
expect(
  "metric details restore keyboard focus to their opener",
  await desktop
    .getByRole("button", { name: "View details", exact: true })
    .evaluate((element) => document.activeElement === element),
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
  (await desktop
    .getByRole("link", { name: "Open Admin Console" })
    .getAttribute("href")) === "/admin/",
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
  id: "BINANCE_TESTNET",
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
let runtimeStartRequests = 0;
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
  config: { executionTarget: "live", testnet: true },
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
  onStart: () => {
    runtimeStartRequests += 1;
  },
});
await demo.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
expect(
  "sandbox environment never claims to contain real funds",
  (await demo.getByText("Binance Testnet", { exact: true }).isVisible()) &&
    !(await demo.locator("body").innerText()).includes("REAL FUNDS"),
);
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
    .getByRole("heading", { name: "Enable broker sandbox AutoPilot" })
    .isVisible(),
);
await demo.getByRole("button", { name: "Enable sandbox AutoPilot" }).click();
await demo
  .getByText("Broker sandbox AutoPilot enabled", { exact: true })
  .waitFor();
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
expect(
  "simple AutoPilot enable starts the existing runtime",
  runtimeStartRequests === 1,
);

const tradePage = await browser.newPage({
  viewport: { width: 1280, height: 900 },
});
await installRoutes(tradePage, {
  trades: [
    {
      id: 991,
      symbol: "BTCUSDT",
      side: "buy",
      entryPrice: 62000,
      exitPrice: 63000,
      quantity: 0.25,
      pnl: 242.5,
      status: "closed",
      confidence: 82,
      stopLoss: 61000,
      takeProfit: 64000,
      entryTime: new Date(now - 3600000).toISOString(),
      exitTime: new Date(now).toISOString(),
      exitReason: "take_profit",
      feesUsdt: 7.5,
      slippageUsdt: 0,
      grossPnl: 250,
      remainingQuantity: 0,
      managementAuthority: "fixed",
      managementMode: "fixed",
      managementPolicyVersion: "brain-v0-fixed-sltp",
      thesisId: null,
      phase7ReductionApplied: false,
      strategyId: "trend_pullback",
      strategyName: "Trend Pullback",
      marketType: "futures",
      leverage: 10,
      marginMode: "isolated",
    },
  ],
});
await tradePage.goto(`${baseUrl}/trades`, { waitUntil: "networkidle" });
expect(
  "trade quantity identifies its asset unit",
  await tradePage.getByText("0.2500 BTC", { exact: true }).isVisible(),
);
expect(
  "a recent trade exposes a details control",
  (await tradePage
    .getByRole("button", { name: "View BTCUSDT trade details" })
    .count()) === 1,
);
await tradePage
  .getByRole("button", { name: "View BTCUSDT trade details" })
  .click();
expect(
  "recent-trade drill-down shows execution and strategy details",
  (await tradePage
    .getByRole("heading", { name: "Trade #991 details" })
    .isVisible()) &&
    (await tradePage
      .getByText("15,500.00 USDT", { exact: true })
      .isVisible()) &&
    (await tradePage
      .getByText("Trend Pullback", { exact: true })
      .isVisible()) &&
    (await tradePage.getByText("10×", { exact: true }).isVisible()),
);

const copilotCleanupPage = await browser.newPage({
  viewport: { width: 1280, height: 900 },
});
await installRoutes(copilotCleanupPage, {
  copilotInbox: {
    recommendations: [
      {
        id: 700,
        status: "executed",
        authoredBy: "engine",
        derivedFromId: null,
        symbol: "ETHUSDT",
        strategyId: "mean_reversion",
        strategyName: "Mean Reversion",
        side: "short",
        confidence: 82,
        entryPrice: 3400,
        slPrice: 3500,
        tpPrice: 3200,
        qty: 0.2,
        leverage: 10,
        planFingerprint: "d".repeat(64),
        entryReason: "Completed proposal",
        expiresAt: new Date(now - 60000).toISOString(),
        createdAt: new Date(now - 3600000).toISOString(),
        actedAt: new Date(now - 3000000).toISOString(),
        tradeId: 991,
        resolutionReason: "Position opened",
        executionTarget: "demo",
        decisionBundleFingerprint: "e".repeat(64),
        approvalState: "APPROVED",
      },
    ],
  },
});
await copilotCleanupPage.goto(`${baseUrl}/copilot`, {
  waitUntil: "networkidle",
});
expect(
  "a completed Co-Pilot card has a UI-only dismiss action",
  (await copilotCleanupPage
    .getByRole("button", { name: "Dismiss ETHUSDT message" })
    .count()) === 1,
);
await copilotCleanupPage
  .getByRole("button", { name: "Dismiss ETHUSDT message" })
  .click();
expect(
  "dismissing a completed Co-Pilot card removes only its UI projection",
  (await copilotCleanupPage
    .getByText("Position opened", { exact: true })
    .count()) === 0,
);

const controls = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
});
let modeUpdate = null;
let closeRequests = 0;
let stopRequests = 0;
await installRoutes(controls, {
  onConfigUpdate: (body) => {
    modeUpdate = body;
  },
  onClose: () => {
    closeRequests += 1;
  },
  onStop: () => {
    stopRequests += 1;
  },
  closeError: "Position close requires fresh reconciliation",
});
await controls.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
const modeControls = controls.locator(
  '[aria-label="Trading intelligence mode"]',
);
await modeControls.getByRole("button", { name: /^Brain/ }).click();
await controls.waitForFunction(() =>
  document
    .querySelector(
      '[aria-label="Trading intelligence mode"] button[aria-pressed="true"]',
    )
    ?.textContent?.includes("Brain"),
);
expect(
  "Brain mode sends the research backend value and refreshes the selected mode",
  modeUpdate?.mode === "research" &&
    (await modeControls
      .getByRole("button", { name: /^Brain/ })
      .getAttribute("aria-pressed")) === "true",
);
await modeControls.getByRole("button", { name: /^Co-Pilot/ }).click();
await controls.waitForFunction(() =>
  document
    .querySelector(
      '[aria-label="Trading intelligence mode"] button[aria-pressed="true"]',
    )
    ?.textContent?.includes("Co-Pilot"),
);
expect(
  "Co-Pilot mode returns to the server-confirmed approval workflow",
  modeUpdate?.mode === "copilot" &&
    (await controls
      .getByRole("button", { name: "Approve", exact: true })
      .isVisible()),
);
await controls
  .getByRole("button", { name: "Close position", exact: true })
  .click();
expect(
  "opening position close confirmation does not submit an external action",
  closeRequests === 0 &&
    (await controls
      .getByRole("button", { name: "Confirm close", exact: true })
      .isVisible()),
);
await controls.getByRole("button", { name: "Cancel", exact: true }).click();
expect("canceling position close submits no request", closeRequests === 0);
await controls
  .getByRole("button", { name: "Close position", exact: true })
  .click();
await controls
  .getByRole("button", { name: "Confirm close", exact: true })
  .click();
await controls
  .getByText(/Position close requires fresh reconciliation/)
  .waitFor();
expect(
  "rejected close remains visible and retains the open position",
  closeRequests === 1 &&
    (await controls
      .getByRole("row")
      .filter({ hasText: "BTCUSDT" })
      .isVisible()),
);
await controls
  .getByRole("button", { name: "Emergency controls", exact: true })
  .click();
expect(
  "emergency review does not stop runtime until confirmation",
  stopRequests === 0,
);
await controls
  .getByRole("dialog", { name: "Stop the trading runtime?" })
  .getByRole("button", { name: "Stop runtime", exact: true })
  .click();
await controls
  .getByRole("button", { name: "Start runtime", exact: true })
  .waitFor();
expect(
  "runtime stop refreshes its control only after server confirmation",
  stopRequests === 1 &&
    (await controls
      .getByRole("button", { name: "Start runtime", exact: true })
      .isVisible()),
);

const rejectedMode = await browser.newPage({
  viewport: { width: 1280, height: 900 },
});
await installRoutes(rejectedMode, {
  configError: "Mode change was refused by the server",
});
await rejectedMode.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
const rejectedModeControls = rejectedMode.locator(
  '[aria-label="Trading intelligence mode"]',
);
await rejectedModeControls.getByRole("button", { name: /^Brain/ }).click();
await rejectedMode
  .getByText("Mode change was refused by the server", { exact: true })
  .waitFor();
expect(
  "failed mode change keeps the confirmed Co-Pilot selection and shows the refusal",
  (await rejectedModeControls
    .getByRole("button", { name: /^Co-Pilot/ })
    .getAttribute("aria-pressed")) === "true" &&
    (await rejectedModeControls
      .getByRole("button", { name: /^Brain/ })
      .isEnabled()),
);

const chartPage = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
});
const chartErrors = [];
chartPage.on("pageerror", (error) => chartErrors.push(error.message));
const chartRequests = [];
await installRoutes(chartPage, {
  onCandles: (parameters) => chartRequests.push(parameters),
});
await chartPage.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
await chartPage.getByRole("button", { name: "15m", exact: true }).click();
await chartPage
  .getByRole("button", { name: "15m", exact: true })
  .getAttribute("aria-pressed");
await chartPage.waitForResponse((response) =>
  response.url().includes("timeframe=15m"),
);
expect(
  "chart timeframe requests the chosen supported interval",
  chartRequests.at(-1)?.timeframe === "15m",
);
await chartPage
  .getByRole("combobox", { name: "Chart symbol" })
  .selectOption("ETHUSDT");
await chartPage.waitForResponse((response) =>
  response.url().includes("symbol=ETHUSDT"),
);
expect(
  "configured markets remain available in the chart selector",
  chartRequests.at(-1)?.symbol === "ETHUSDT",
);
await chartPage
  .getByRole("button", { name: "View BTCUSDT position details" })
  .click();
const positionDialog = chartPage.getByRole("dialog", {
  name: "BTCUSDT position details",
});
expect(
  "position details retain full ledger quantity and levels",
  (await positionDialog.getByText("62000", { exact: true }).isVisible()) &&
    (await positionDialog
      .getByRole("link", { name: "View trade history and thesis" })
      .isVisible()),
);
await chartPage.keyboard.press("Escape");
await chartPage.getByRole("button", { name: "Dark theme" }).click();
expect(
  "dark appearance applies to the workspace",
  await chartPage
    .locator("html")
    .evaluate((element) => element.classList.contains("dark")),
);
await chartPage.getByRole("button", { name: "Light theme" }).click();
expect(
  "chart survives symbol, interval, and theme changes",
  chartErrors.length === 0,
);
const readOnlyPage = await browser.newPage({
  viewport: { width: 1280, height: 900 },
});
await installRoutes(readOnlyPage, { readOnly: true });
await readOnlyPage.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
expect(
  "read-only account cannot change modes or submit trade actions",
  (await readOnlyPage
    .locator('[aria-label="Trading intelligence mode"]')
    .getByRole("button", { name: /^Brain/ })
    .isDisabled()) &&
    (await readOnlyPage
      .getByRole("button", { name: "Approve", exact: true })
      .isDisabled()) &&
    (await readOnlyPage
      .getByRole("button", { name: "Close position", exact: true })
      .isDisabled()),
);
const emptySession = structuredClone(session);
emptySession.activity.positions = [];
emptySession.activity.recommendations = [];
emptySession.runtime.openPositionCount = 0;
await chartPage.unrouteAll({ behavior: "wait" });
await installRoutes(chartPage, { session: emptySession });
await chartPage.reload({ waitUntil: "networkidle" });
expect(
  "empty account still has its saved chart markets",
  (await chartPage
    .getByRole("combobox", { name: "Chart symbol" })
    .inputValue()) === "BTCUSDT",
);
expect(
  "empty positions are distinguished from unavailable account metrics",
  await chartPage.getByText("No open positions", { exact: true }).isVisible(),
);
await chartPage.close();
await readOnlyPage.close();
if (process.env.CACTUS_SCREENSHOT_DIR) {
  const { mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(process.env.CACTUS_SCREENSHOT_DIR, { recursive: true });
  const visualSession = structuredClone(session);
  visualSession.context.environment = {
    id: "CACTUS_DEMO",
    label: "Cactus Demo",
    realFunds: false,
  };
  visualSession.context.account.label = "Cactus Demo";
  visualSession.context.mode = {
    configured: "autopilot",
    backendValue: "autopilot",
    effectiveAuthority: "DEMO_AUTOPILOT",
  };
  visualSession.runtime.openPositionCount = 2;
  visualSession.runtime.lastScanAt = new Date(now).toISOString();
  visualSession.activity.recommendations = [];
  visualSession.activity.positions.push({
    ...visualSession.activity.positions[0],
    id: 92,
    symbol: "ETHUSDT",
    quantity: 1.817408,
    entryPrice: 2477.288025,
    stopLoss: 2457.75471467,
    takeProfit: 2523.78274167,
    strategyName: "Momentum Breakout",
  });
  visualSession.activity.positions.forEach((position) => {
    position.executionTarget = "demo";
  });
  visualSession.metrics.availableFunds = {
    state: "available",
    value: 10446.96,
    unit: "currency",
    source: "Test demo ledger",
    observedAt: new Date(now).toISOString(),
    reason: null,
  };
  visualSession.metrics.realizedDayPnl.value = 457.66;
  visualSession.metrics.risk = {
    state: "CLEAR",
    newEntriesAllowed: true,
    protectiveManagementContinues: true,
    reason: null,
  };
  visualSession.health = {
    api: { state: "available", label: "Connected" },
    database: { state: "available", label: "Connected" },
    broker: { state: "available", label: "Demo runtime" },
    marketData: { state: "available", label: "Connected" },
    execution: { state: "available", label: "Simulated" },
  };
  visualSession.alerts = [];
  const visualPage = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  await installRoutes(visualPage, {
    session: visualSession,
    config: { executionTarget: "demo", mode: "autopilot" },
    candles: Array.from({ length: 120 }, (_, index) => {
      const open = 62000 + index * 10 + Math.sin(index / 5) * 100;
      const close = open + Math.sin(index * 3) * 30 + 8;
      return [
        now - (120 - index) * 300000,
        open,
        Math.max(open, close) + 25,
        Math.min(open, close) - 20,
        close,
        10 + (index % 13),
      ];
    }),
  });
  await visualPage.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
  await visualPage.screenshot({
    path: join(process.env.CACTUS_SCREENSHOT_DIR, "dashboard-desktop.png"),
    fullPage: true,
  });
  await visualPage.getByRole("button", { name: "Dark theme" }).click();
  await visualPage.screenshot({
    path: join(process.env.CACTUS_SCREENSHOT_DIR, "dashboard-dark.png"),
    fullPage: true,
  });
  await visualPage.getByRole("button", { name: "Light theme" }).click();
  await visualPage.setViewportSize({ width: 390, height: 844 });
  await visualPage.screenshot({
    path: join(process.env.CACTUS_SCREENSHOT_DIR, "dashboard-mobile.png"),
    fullPage: true,
  });
  expect(
    "Demo visual fixture has no mobile document overflow",
    await visualPage.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await visualPage.close();
}
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
for (const width of [360, 768]) {
  await mobile.setViewportSize({ width, height: 900 });
  expect(
    `dashboard fits the ${width}px viewport`,
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
}
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.getByRole("button", { name: "Open navigation" }).click();
expect(
  "mobile drawer exposes all five trader areas",
  (await mobile.getByRole("link").allTextContents()).filter((text) =>
    [
      "Dashboard",
      "Strategies",
      "Backtest Lab",
      "Activity",
      "Settings",
    ].includes(text.trim()),
  ).length >= 5,
);

await desktop.close();
await demo.close();
await tradePage.close();
await copilotCleanupPage.close();
await controls.close();
await rejectedMode.close();
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
