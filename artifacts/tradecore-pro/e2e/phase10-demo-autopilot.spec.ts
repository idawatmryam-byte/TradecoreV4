import { expect, test, type Page, type Route } from "@playwright/test";

const fingerprint = "a".repeat(64);
const mandate = {
  id: 41, schemaVersion: "phase10-demo-autopilot-v1", userId: 7, section: "crypto", version: 1,
  botConfigId: 9, configFingerprint: "b".repeat(64), brainVersionId: 3, brainVersion: "brain-v0",
  executionAuthority: "binance_spot_testnet", marketType: "spot", instruments: ["BTCUSDT"],
  strategyVersions: { trend_pullback: "strategy-config:test" }, maximumPositionSizeUsdt: 100,
  maximumLeverage: 1, maximumPortfolioRiskPercent: 5, maximumSymbolExposurePercent: 50,
  maximumNetExposurePercent: 100, maximumCorrelatedExposurePercent: 100, dailyLossLimitUsdt: 50,
  maximumDrawdownPercent: 10, maximumConcurrentPositions: 2, maximumMarketDataAgeSeconds: 30,
  allowedTradingHoursUtc: [], permittedPhase7Actions: ["HOLD", "FREEZE", "REDUCE", "TIGHTEN_STOP", "APPLY_TRAILING", "EXIT"],
  validFrom: "2026-08-12T00:00:00.000Z", expiresAt: "2099-08-12T00:00:00.000Z",
  fingerprint, createdAt: "2026-08-12T00:00:00.000Z",
};
const brain = {
  id: 3, userId: 7, section: "crypto", version: "brain-v0", implementation: "brain-v0-control",
  state: "DEMO_APPROVED", fingerprint: "c".repeat(64), sourceCommit: "993969d",
  evidenceReferences: ["BRAIN_V0_BASELINE"], createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z",
};

async function mockApi(page: Page, executionTarget: "demo" | "live" = "live") {
  let paused = false;
  await page.route("**/api/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let json: unknown = {};
    if (path === "/api/auth/status") json = { authenticated: true };
    else if (path === "/api/auth/providers") json = { google: false, apple: false, demo: false };
    else if (path === "/api/sections") json = { activated: ["crypto"] };
    else if (path === "/api/notifications") json = [];
    else if (path === "/api/healthz") json = { status: "healthy" };
    else if (path === "/api/bot/status") json = { running: true, newEntriesAllowed: true };
    else if (path === "/api/config") json = {
      demoDataAvailable: true, broker: "binance", marketType: "spot", leverage: 1, marginMode: "isolated",
      positionSizeUsdt: 100, riskPercent: 1, maxOpenPositions: 2, maxPortfolioRiskPercent: 5,
      dailyLossLimitUsdt: 50, maxSymbolConcentrationPercent: 50, maxNetExposurePercent: 100,
      maxCorrelatedExposurePercent: 100, correlationThreshold: 0.7, correlationUnknownPolicy: "block",
      confidenceThreshold: 65, riskModel: "percent", stopLossPercent: 2, takeProfitPercent: 4,
      maxLossUsdt: 10, targetProfitUsdt: 20, cooldownMinutes: 15, scanIntervalSeconds: 30,
      pairs: ["BTCUSDT"], executionTarget, mode: "autopilot", positionManagementMode: "phase7_active",
      demoStartingBalanceUsdt: 10000, testnet: executionTarget !== "demo", backtestMode: false, highFrequencyTestMode: false,
    };
    else if (path === "/api/strategies") json = [{
      strategyId: "trend_pullback", strategyName: "Trend Pullback", supportedRegimes: ["strong_trend"],
      indicators: ["EMA"], decisionMaker: true, config: { enabled: true, riskPercent: 1, confidenceThreshold: 65, stopLossPercent: 2, takeProfitPercent: 4, maxHoldingSeconds: 3600, maxConcurrentPositions: 2, cooldownMinutes: 15 },
      performance: { totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: null, totalPnl: 0, avgWin: 0, avgLoss: 0, avgDurationSeconds: 0 },
    }];
    else if (path === "/api/autopilot/pause" && method === "POST") {
      paused = true;
      json = { id: 1, userId: 7, section: "crypto", mandateId: 41, state: "AUTOPILOT_PAUSED", reasonCode: "HUMAN_PAUSE", reason: "Operator requested entry halt", globalSuspended: false, configSuspended: true, updatedAt: new Date().toISOString() };
    } else if (path === "/api/autopilot/control") {
      const control = { id: 1, userId: 7, section: "crypto", mandateId: 41, state: paused ? "AUTOPILOT_PAUSED" : "AUTOPILOT_ENABLED", reasonCode: paused ? "HUMAN_PAUSE" : "HUMAN_ACTIVATION_APPROVED", reason: paused ? "Operator requested entry halt" : "Exact Demo mandate and safety checks passed", globalSuspended: false, configSuspended: paused, updatedAt: "2026-08-12T12:00:00.000Z" };
      json = { globalSuspended: false, liveAuthorityEnabled: false, authorityBoundary: ["simulated_demo", "binance_spot_testnet", "binance_futures_demo", "oanda_practice"], snapshot: { control, mandate, brainVersion: brain, mandateState: { state: paused ? "SUSPENDED" : "ACTIVE" } }, versions: [brain], mandates: [mandate], events: [{ id: 1, eventType: "MANDATE_CREATED", reasonCode: "MANDATE_CREATED", reason: "Immutable Demo mandate created", fingerprint, occurredAt: "2026-08-12T00:00:00.000Z" }] };
    } else if (path === "/api/autopilot/forward-soak") json = { status: "AVAILABLE", generatedAt: "2026-08-12T12:00:00.000Z", reportFingerprint: "d".repeat(64), authority: "binance_spot_testnet", metrics: { autonomousDecisions: 12, executed: 4, refused: 8, failed: 0, protectionCoveragePercent: 100, realizedPnlUsdt: 7.5 } };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  });
}

test("Control Center makes broker sandbox authority, mandate, evidence, and audit visible", async ({ page }) => {
  await mockApi(page);
  await page.goto("/autopilot");
  await expect(page.getByRole("heading", { name: "Brain Control Center" })).toBeVisible();
  await expect(page.getByText("BROKER SANDBOX AUTOPILOT · NO REAL-MONEY AUTHORITY")).toBeVisible();
  await expect(page.getByText("AUTOPILOT_ENABLED")).toBeVisible();
  await expect(page.getByText("binance_spot_testnet")).toBeVisible();
  await expect(page.getByText("MANDATE_CREATED", { exact: true })).toBeVisible();
  await expect(page.getByText("Brain confidence remains uncalibrated")).toBeVisible();
  await expect(page.getByText("100.0%")).toBeVisible();
});

test("entry halt becomes visible without removing protective-management messaging", async ({ page }) => {
  await mockApi(page);
  await page.goto("/autopilot");
  await page.getByRole("button", { name: "Halt new entries" }).click();
  await expect(page.getByText("AUTOPILOT_PAUSED")).toBeVisible();
  await expect(page.getByText("Operator requested entry halt")).toBeVisible();
  await expect(page.getByText(/Pausing entries does not disable protective position management or exits/)).toBeVisible();
});

test("internal Demo shows immediate AutoPilot access without an authority workflow", async ({ page }) => {
  await mockApi(page, "demo");
  await page.goto("/autopilot");
  await expect(page.getByRole("heading", { name: "Demo AutoPilot" })).toBeVisible();
  await expect(page.getByText("Ready without administrator approval")).toBeVisible();
  await expect(page.getByText(/does not require broker credentials, a mandate, or an activation workflow/)).toBeVisible();
});
