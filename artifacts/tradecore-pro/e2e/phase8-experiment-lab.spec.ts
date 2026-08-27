import { expect, test, type Page, type Route } from "@playwright/test";

const baseExperiment = {
  id: 18,
  section: "crypto",
  experimentId: "11111111-1111-5111-8111-111111111118",
  name: "Full-brain validation",
  status: "completed",
  stage: "report",
  progress: 100,
  cancelRequested: false,
  decisionEventCount: 240,
  managementEventCount: 40,
  manifestFingerprint: "a".repeat(64),
  goldenStreamFingerprint: "b".repeat(64),
  mode: "research",
  cannotExecute: true,
  request: { symbols: ["BTCUSDT", "ETHUSDT"] },
  manifest: { mode: "research", cannotExecute: true },
  error: null,
  createdAt: "2026-08-09T10:00:00.000Z",
  startedAt: "2026-08-09T10:00:01.000Z",
  completedAt: "2026-08-09T10:05:00.000Z",
};

const metrics = {
  eligibleDecisions: 240,
  closedTrades: 64,
  calendarDays: 90,
  grossPnl: 180,
  costs: 35,
  netPnl: 145,
  netExpectancyR: 0.22,
  profitFactor: 1.4,
  maxDrawdown: 0.07,
  expectedShortfallR: -0.8,
  abstentionRate: 0.55,
  regimeMix: { strong_trend: 40, range: 24 },
  uncertainty: {
    method: "bootstrap-percentile",
    confidenceLevel: 0.95,
    lowerNetExpectancyR: 0.04,
    upperNetExpectancyR: 0.38,
    samples: 1000,
  },
};

const report = {
  schemaVersion: "phase8-promotion-report-v1",
  experimentId: baseExperiment.experimentId,
  manifestFingerprint: baseExperiment.manifestFingerprint,
  generatedAt: "2026-08-09T10:05:00.000Z",
  control: { ...metrics, netPnl: 110, costs: 30, maxDrawdown: 0.06 },
  candidate: metrics,
  attribution: {
    perception: 0,
    selection: 20,
    evidence: 0,
    allocation: 8,
    executionCosts: -5,
    management: 12,
    residual: 0,
    unit: "net-pnl",
  },
  goldenStream: {
    expectedFingerprint: "b".repeat(64),
    actualFingerprint: "b".repeat(64),
    reproducible: true,
  },
  leakageChecks: [{ check: "full-replay-point-in-time", passed: true, detail: "all passed" }],
  multipleTesting: { procedure: "benjamini-hochberg", hypotheses: 1, discoveries: 1 },
  gateChecks: [
    { key: "golden-stream", passed: true, actual: "reproduced", required: "reproduced" },
    { key: "closed-trades", passed: false, actual: "64", required: "500" },
  ],
  recommendation: "REMAIN_RESEARCH",
  humanApprovalRequired: true,
  limitations: ["Research evidence only"],
  fingerprint: "c".repeat(64),
};

async function mockApi(page: Page, experiment = { ...baseExperiment, report }) {
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let status = 200;
    let json: unknown = {};
    if (path === "/api/auth/status") json = { authenticated: true };
    else if (path === "/api/auth/providers") json = { google: false, apple: false, demo: false };
    else if (path === "/api/config") json = { executionTarget: "demo", mode: "autopilot" };
    else if (path === "/api/sections") json = { activated: ["crypto"] };
    else if (path === "/api/bot/status") json = { running: false, newEntriesAllowed: true };
    else if (path === "/api/notifications") json = [];
    else if (path === "/api/healthz") json = { status: "healthy" };
    else if (path === "/api/backtests") json = [];
    else if (path === "/api/research/experiments" && request.method() === "POST") {
      status = 202;
      json = { id: 18, status: "preparing", mode: "research", cannotExecute: true };
    } else if (path === "/api/research/experiments") json = [experiment];
    else if (path === "/api/research/experiments/18") json = experiment;
    else if (path === "/api/research/experiments/18/events") json = {
      events: [{
        sequence: 0,
        kind: "decision",
        partitionId: "untouched-holdout",
        observedAt: "2026-07-15T12:00:00.000Z",
        symbol: "BTCUSDT",
        tradeId: null,
        eventFingerprint: "d".repeat(64),
        event: { outcome: "WAITING", cannotExecute: true },
      }],
      nextAfterSequence: 0,
      hasMore: true,
    };
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
  });
}

test("Backtest Lab makes Research authority and overfitting controls prominent", async ({ page }) => {
  await mockApi(page);
  await page.goto("/backtest");
  await expect(page.getByRole("heading", { name: "Backtest Lab" })).toBeVisible();
  await expect(page.getByText("Research has zero execution authority")).toBeVisible();
  await expect(page.getByText(/Synthetic fallback is refused/)).toBeVisible();
  await expect(page.getByText(/Purged walk-forward validation/)).toBeVisible();
});

test("completed experiment shows comparison, promotion gates, attribution, and replay", async ({ page }) => {
  await mockApi(page);
  await page.goto("/backtest");
  await page.getByRole("button", { name: /Full-brain validation/ }).last().click();
  await expect(page.getByText("REMAIN RESEARCH")).toBeVisible();
  await expect(page.getByText(/Human approval remains mandatory/)).toBeVisible();
  await expect(page.getByText("Control / candidate")).toBeVisible();
  await expect(page.getByText("Predetermined gates")).toBeVisible();
  await expect(page.getByText("Attribution")).toBeVisible();
  await expect(page.getByText("untouched-holdout")).toBeVisible();
  await expect(page.getByText("WAITING")).toBeVisible();
});

test("experiment creation submits bounded point-in-time inputs and exposes error state", async ({ page }) => {
  let submitted: Record<string, unknown> | null = null;
  await mockApi(page, { ...baseExperiment, status: "failed", stage: "failed", progress: 12, report: null, error: "Provider candle history was incomplete" });
  await page.route("**/api/research/experiments", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: 18, status: "preparing", mode: "research", cannotExecute: true }) });
  });
  await page.goto("/backtest");
  await page.getByRole("button", { name: "Run full-brain experiment" }).click();
  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted?.timeframe).toBe("1m");
  expect(submitted?.deterministicSeed).toBe(42);
  expect(submitted?.folds).toBe(3);
  await page.getByRole("button", { name: /Full-brain validation/ }).last().click();
  await expect(page.getByRole("alert")).toContainText("Provider candle history was incomplete");
});
