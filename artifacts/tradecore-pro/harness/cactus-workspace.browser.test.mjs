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
const session = {
  schemaVersion: "cactus-dashboard-session-v1",
  asOf: new Date(now).toISOString(),
  context: {
    section: "crypto",
    market: "Crypto",
    broker: "binance",
    marketType: "futures",
    environment: { id: "BINANCE_LIVE", label: "Binance Live", realFunds: true },
    account: { id: "binance:configured", label: "Binance ••••ABCD", singleConnectionPerMarket: true },
    mode: { configured: "copilot", backendValue: "copilot", effectiveAuthority: "USER_APPROVAL_REQUIRED" },
  },
  metrics: {
    availableFunds: { state: "unavailable", value: null, unit: "currency", source: null, observedAt: null, reason: "Authoritative free balance is unavailable" },
    equity: { state: "unavailable", value: null, unit: "currency", source: null, observedAt: null, reason: "Persisted Live equity is stale" },
    marginUsed: { state: "unavailable", value: null, unit: "currency", source: null, observedAt: null, reason: "Authoritative margin is unavailable" },
    realizedDayPnl: { state: "available", value: -12.5, unit: "currency", source: "trades", observedAt: new Date(now).toISOString(), reason: null },
    exposure: { state: "unavailable", value: null, unit: "currency", source: null, observedAt: null, reason: "Mark prices are unavailable" },
    drawdown: { state: "unavailable", value: null, unit: "percent", source: null, observedAt: null, reason: "Equity evidence is stale" },
    risk: { state: "BLOCKED", newEntriesAllowed: false, protectiveManagementContinues: true, reason: "Live reconciliation is unknown" },
  },
  runtime: { running: true, startedAt: new Date(now - 60_000).toISOString(), lastScanAt: new Date(now - 120_000).toISOString(), circuitBreakerActive: false, openPositionCount: 1, tradesToday: 2 },
  health: {
    api: { state: "available", label: "API" },
    database: { state: "available", label: "Database" },
    broker: { state: "unavailable", label: "Binance", reason: "Connection evidence unavailable" },
    marketData: { state: "stale", label: "Market data", reason: "Last observation is stale", observedAt: new Date(now - 120_000).toISOString(), ageMs: 120000 },
    execution: { state: "unavailable", label: "Execution", reason: "Live reconciliation is unknown" },
  },
  activity: {
    positions: [{ id: 91, symbol: "BTCUSDT", side: "long", quantity: 0.1, entryPrice: 62000, stopLoss: 60000, takeProfit: 66000, strategyId: "trend", strategyName: "Trend Guard", executionTarget: "live", executionAuthority: "copilot", managementAuthority: "phase7", entryTime: new Date(now - 3600000).toISOString() }],
    pendingOrders: { state: "unavailable", orders: null, reason: "No authoritative pending-order projection exists." },
    recentTrades: [],
    recommendations: [{ id: 501, symbol: "ETHUSDT", side: "short", confidence: 0.82, entryPrice: 3400, stopLoss: 3500, takeProfit: 3200, quantity: 0.2, strategyId: "mean-reversion", strategyName: "Mean Reversion", executionTarget: "live", status: "created", expiresAt: new Date(now + 60000).toISOString(), createdAt: new Date(now).toISOString(), approvalRequired: true }],
  },
  performance: { live: { sampleSize: 4, totalPnl: -12.5, winRate: 0.5 }, demo: { sampleSize: 12, totalPnl: 84.2, winRate: 0.66 }, separatedByExecutionTarget: true },
  autopilot: null,
  alerts: [{ id: "risk", severity: "critical", source: "execution", message: "Live reconciliation is unknown. New entries are blocked; protective management continues.", occurredAt: new Date(now).toISOString(), persistent: true }],
  limitations: ["Manual entry is unavailable until its financial-path architecture gate is complete.", "Pending orders remain unknown until an authoritative projection exists."],
};

async function installRoutes(page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/auth/status") return json({ authenticated: true });
    if (url.pathname === "/api/auth/providers") return json({ google: false, apple: false, demo: false });
    if (url.pathname === "/api/me/account") return json({ id: 42, username: "cactus-browser", email: null, displayName: "Cactus Browser", createdAt: new Date(now).toISOString(), hasPassword: true, isDemo: false, providers: [] });
    if (url.pathname === "/api/sections") return json({ activated: ["crypto"] });
    if (url.pathname === "/api/config") return json({ executionTarget: "live", testnet: false, broker: "binance", mode: "copilot", marketType: "futures", coinList: ["BTCUSDT", "ETHUSDT"] });
    if (url.pathname === "/api/bot/status") return json({ running: true, dailyPnl: -12.5, openPositions: 1, totalTradesToday: 2, winRateToday: 0.5, circuitBreakerActive: false, riskPaused: false, newEntriesAllowed: false, entryBlockReason: "Live reconciliation is unknown", mode: "copilot" });
    if (url.pathname === "/api/execution-health") return json({ status: "BLOCKED", operatingMode: "PROTECTION_DEGRADED" });
    if (url.pathname === "/api/capabilities") return json({ schemaVersion: "cactus-trader-capabilities-v1", section: "crypto", financialRole: "OWNER", readOnlyDemoAccount: false, modes: { manual: { supported: false, reason: "Architecture gate incomplete" }, brain: { supported: true, backendMode: "research", canExecute: false }, copilot: { supported: true, approvalRequired: true, canApprove: true }, autopilot: { supported: true, uiSelectionGrantsAuthority: false, liveAuthorityEnabled: false } }, accounts: { multipleBrokerAccounts: false, demo: { supported: true, label: "Cactus Demo" }, broker: { provider: "binance", configured: true, maskedIdentifier: "••••ABCD", environments: ["BINANCE_TESTNET", "BINANCE_LIVE"] } }, features: { dashboardSession: true, strategyModeAssignments: true, pendingOrders: false, pendingOrdersReason: "No authoritative projection", manualEntry: false, externalAiProviders: false, multipleBrokerAccounts: false, adminConsole: true }, serverAuthoritative: true, generatedAt: new Date(now).toISOString() });
    if (url.pathname === "/api/dashboard/session") return json(session);
    if (url.pathname === "/api/notifications") return json({ notifications: [], unreadCount: 0 });
    if (url.pathname === "/api/market/candles") return json({ candles: [[now - 60000, 62000, 62500, 61800, 62300, 10], [now, 62300, 62400, 61900, 62100, 12]] });
    if (url.pathname === "/api/strategies") return json([{ strategyId: "trend", strategyName: "Trend Guard", version: "engine-v1", fingerprint: "a".repeat(64), kind: "built-in", supportedMarket: "crypto", config: { enabled: true }, assignment: { strategyId: "trend", brain: true, copilot: true, autopilot: false, revision: 1, updatedAt: new Date(now).toISOString() }, performance: { totalTrades: 12, winRate: 0.58, totalPnl: 84.2 } }]);
    return json({});
  });
}

const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await installRoutes(desktop);
await desktop.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
expect("trader navigation has exactly four primary entries", (await desktop.locator("aside nav a").allTextContents()).filter((text) => ["Dashboard", "Strategies", "Backtest Lab", "Settings"].includes(text.trim())).length === 4);
expect("Live real-funds state is textual and persistent", await desktop.getByText("BINANCE LIVE — REAL FUNDS", { exact: true }).isVisible());
expect("effective Co-Pilot approval state is explicit", await desktop.getByText("Your approval is required", { exact: false }).isVisible());
expect("unknown metrics are not rendered as zero", (await desktop.getByText("Unavailable", { exact: true }).count()) >= 3);
await desktop.getByRole("tab", { name: "Pending orders" }).click();
expect("pending-order read failure remains unavailable", await desktop.getByText("Pending orders unavailable", { exact: true }).isVisible());
expect("stale chart warning is visible", await desktop.getByText("Market data is stale", { exact: false }).first().isVisible());
expect("Admin link is profile-only, not trader navigation", (await desktop.locator("aside nav a[href='/admin']").count()) === 0);

await desktop.getByRole("button", { name: /Strategies/ }).click();
expect("strategy drawer separates requested set from active authority", await desktop.getByText("AutoPilot authority is immutable", { exact: false }).isVisible());
expect("current authorized state is not fabricated", (await desktop.getByText("Authorized now", { exact: true }).count()) === 0);

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await installRoutes(mobile);
await mobile.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
expect("mobile has no document-level horizontal overflow", await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
await mobile.getByRole("button", { name: "Open navigation" }).click();
expect("mobile drawer exposes all four trader areas", (await mobile.getByRole("link").allTextContents()).filter((text) => ["Dashboard", "Strategies", "Backtest Lab", "Settings"].includes(text.trim())).length >= 4);

await desktop.close();
await mobile.close();
await browser.close();

if (failures > 0) {
  console.error(`FAIL: ${failures} Cactus workspace browser assertion(s) failed`);
  process.exit(1);
}
console.log("PASS: Cactus trader workspace critical desktop and mobile states verified");
