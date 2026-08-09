import { expect, test, type Page, type Route } from "@playwright/test";

const config = {
  demoDataAvailable: true,
  broker: "binance",
  marketType: "spot",
  leverage: 1,
  marginMode: "isolated",
  positionSizeUsdt: 100,
  riskPercent: 1,
  maxOpenPositions: 5,
  maxPortfolioRiskPercent: 10,
  dailyLossLimitUsdt: 100,
  maxSymbolConcentrationPercent: 100,
  maxNetExposurePercent: 200,
  maxCorrelatedExposurePercent: 200,
  correlationThreshold: 0.7,
  correlationUnknownPolicy: "allow",
  confidenceThreshold: 55,
  riskModel: "percent",
  stopLossPercent: 1,
  takeProfitPercent: 2,
  maxLossUsdt: 10,
  targetProfitUsdt: 20,
  cooldownMinutes: 15,
  scanIntervalSeconds: 15,
  pairs: ["BTCUSDT"],
  executionTarget: "live",
  mode: "autopilot",
  positionManagementMode: "phase7_shadow",
  demoStartingBalanceUsdt: 10_000,
  testnet: false,
  backtestMode: false,
  highFrequencyTestMode: false,
  alertWebhookUrl: null,
};

const trade = {
  id: 7,
  symbol: "BTCUSDT",
  side: "buy",
  entryPrice: 100,
  exitPrice: null,
  quantity: 2,
  pnl: null,
  status: "open",
  confidence: 75,
  stopLoss: 100,
  takeProfit: 104,
  entryTime: "2026-08-09T11:50:00.000Z",
  exitTime: null,
  exitReason: null,
  isBacktest: false,
  plannedStopLoss: 98,
  plannedTakeProfit: 104,
  plannedQuantity: 2,
  feesUsdt: null,
  slippageUsdt: null,
  holdingSeconds: null,
  grossPnl: null,
  remainingQuantity: 2,
  tp1Price: null,
  tp1Quantity: null,
  tp1Filled: false,
  tp1FillPrice: null,
  tp2Price: null,
  tp2Quantity: null,
  tp2Filled: false,
  tp2FillPrice: null,
  breakEvenActive: true,
  trailingStopActive: false,
  trailingStopMode: null,
  managementAuthority: "phase7",
  managementMode: "phase7_active",
  managementPolicyVersion: "phase7-bounded-management-v1",
  thesisId: "00000000-0000-4000-8000-000000000701",
  phase7ReductionApplied: false,
};

function thesisView(
  state: "VALID" | "DATA_UNCERTAIN",
  action: "TIGHTEN_STOP" | "FREEZE",
) {
  return {
    thesis: {
      schemaVersion: "position-thesis-v1",
      thesisId: trade.thesisId,
      symbol: "BTCUSDT",
      side: "long",
      context: "Trend is aligned.",
      trigger: "Closed breakout.",
      invalidationConditions: [
        "Price violates the protected stop at 98",
        "Three timeframes align against the thesis",
      ],
      targetRationale: "Target at two R.",
      expectedPath: ["Price progresses toward 104"],
      expectedDurationSeconds: 1800,
      maximumDurationSeconds: 3600,
      managementPolicyVersion: "phase7-bounded-management-v1",
      permittedActions: [
        "HOLD",
        "REDUCE",
        "TIGHTEN_STOP",
        "APPLY_TRAILING",
        "EXIT",
        "FREEZE",
      ],
      entry: {
        price: 100,
        initialStopPrice: 98,
        targetPrice: 104,
        regime: "strong_trend",
        dominantDirection: "bullish",
        marketStateFingerprint: "a".repeat(64),
        marketStateVersion: "market-state-v1",
        dataTimestamp: "2026-08-09T11:49:00.000Z",
      },
      createdAt: "2026-08-09T11:50:00.000Z",
      fingerprint: "b".repeat(64),
    },
    events: [
      {
        eventId: "00000000-0000-4000-8000-000000000799",
        stage: "APPLIED",
        thesisState: state,
        actionType: action,
        policyVersion: "phase7-bounded-management-v1",
        marketStateFingerprint: state === "VALID" ? "c".repeat(64) : null,
        validationPassed: true,
        evaluation: {
          schemaVersion: "position-thesis-evaluation-v1",
          thesisId: trade.thesisId,
          tradeId: 7,
          state,
          marketStateFingerprint: state === "VALID" ? "c".repeat(64) : null,
          evaluatedAt: "2026-08-09T12:00:00.000Z",
          progressR: state === "VALID" ? 0.5 : 0,
          elapsedFraction: 0.3,
          supportingEvidence: state === "VALID" ? ["Thesis remains valid"] : [],
          contraryEvidence:
            state === "DATA_UNCERTAIN" ? ["Market data is stale"] : [],
          reasonCodes: [
            state === "VALID"
              ? "THESIS_REMAINS_VALID"
              : "MARKET_STATE_UNCERTAIN",
          ],
          fingerprint: "d".repeat(64),
        },
        action: {
          schemaVersion: "position-management-action-v1",
          actionId: "00000000-0000-4000-8000-000000000798",
          thesisId: trade.thesisId,
          tradeId: 7,
          type: action,
          state,
          policyVersion: "phase7-bounded-management-v1",
          proposedStopPrice: action === "TIGHTEN_STOP" ? 100 : null,
          reductionFraction: null,
          trailingMode: null,
          reasonCodes: [
            state === "VALID"
              ? "THESIS_REMAINS_VALID"
              : "MARKET_STATE_UNCERTAIN",
          ],
          marketStateFingerprint: state === "VALID" ? "c".repeat(64) : null,
          proposedAt: "2026-08-09T12:00:00.000Z",
          fingerprint: "e".repeat(64),
        },
        validation: {
          schemaVersion: "position-action-validation-v1",
          actionFingerprint: "e".repeat(64),
          valid: true,
          currentMaximumLoss: 4,
          proposedMaximumLoss: action === "FREEZE" ? 4 : 0,
          reasonCodes: ["DETERMINISTIC_POLICY_VALIDATED"],
          validatedAt: "2026-08-09T12:00:00.000Z",
          fingerprint: "f".repeat(64),
        },
        result: { mutated: action !== "FREEZE" },
        observedAt: "2026-08-09T12:00:00.000Z",
        createdAt: "2026-08-09T12:00:00.000Z",
      },
    ],
  };
}

async function mockApi(
  page: Page,
  thesisState: "VALID" | "DATA_UNCERTAIN" = "VALID",
) {
  await page.route("**/api/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const json =
      path === "/api/auth/status"
        ? { authenticated: true }
        : path === "/api/auth/providers"
          ? { google: false, apple: false, demo: false }
          : path === "/api/config"
            ? config
            : path === "/api/sections"
              ? { activated: ["crypto"] }
              : path === "/api/trades"
                ? [trade]
                : path === "/api/trades/7/thesis"
                  ? thesisView(
                      thesisState,
                      thesisState === "VALID" ? "TIGHTEN_STOP" : "FREEZE",
                    )
                  : path === "/api/bot/status"
                    ? { running: false, state: "stopped" }
                    : path === "/api/notifications"
                      ? []
                      : path === "/api/healthz"
                        ? { ok: true }
                        : path.includes("credentials")
                          ? {
                              configured: false,
                              apiKeyPreview: null,
                              updatedAt: null,
                            }
                          : {};
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
  });
}

test("real Live visibly disables active Phase 7 authority", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/settings");
  const authority = page.getByTestId("position-management-authority");
  await expect(authority).toContainText("Phase 7 Shadow");
  await authority.getByRole("combobox").click();
  await expect(
    page.getByRole("option", { name: /Phase 7 Active/ }),
  ).toBeDisabled();
});

test("active position exposes a keyboard-accessible, non-color-only audit timeline", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/trades");
  await expect(page.getByText("Phase 7 active")).toBeVisible();
  const button = page.getByRole("button", { name: "View thesis for trade 7" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("position-thesis-card")).toBeVisible();
  await expect(page.getByTestId("position-thesis-timeline")).toContainText(
    "APPLIED",
  );
  await expect(page.getByTestId("position-thesis-timeline")).toContainText(
    "TIGHTEN_STOP",
  );
  await expect(page.getByTestId("position-thesis-timeline")).toContainText(
    "VALID",
  );
});

test("uncertain data is labeled and freezes adaptive changes", async ({
  page,
}) => {
  await mockApi(page, "DATA_UNCERTAIN");
  await page.goto("/trades");
  await page.getByRole("button", { name: "View thesis for trade 7" }).click();
  await expect(page.getByTestId("position-thesis-card")).toContainText(
    "DATA_UNCERTAIN",
  );
  await expect(page.getByTestId("position-thesis-timeline")).toContainText(
    "FREEZE",
  );
  await expect(page.getByTestId("position-thesis-timeline")).toContainText(
    "MARKET_STATE_UNCERTAIN",
  );
});
