import { expect, test, type Page, type Route } from "@playwright/test";

const planFingerprint = "a".repeat(64);
const bundleFingerprint = "b".repeat(64);
const approvalChallenge = "11111111-1111-4111-8111-111111111111";
const future = "2099-08-10T12:10:00.000Z";

const recommendation = {
  id: 91,
  status: "created",
  authoredBy: "engine",
  derivedFromId: null,
  symbol: "BTCUSDT",
  strategyId: "trend-v1",
  strategyName: "Trend continuation",
  side: "long",
  confidence: 72,
  entryPrice: 100,
  slPrice: 96,
  tpPrice: 110,
  qty: 0.5,
  leverage: 2,
  planFingerprint,
  entryReason: "Breakout held with supporting volume and acceptable cost.",
  expiresAt: future,
  createdAt: "2026-08-10T12:00:00.000Z",
  actedAt: null,
  tradeId: null,
  resolutionReason: null,
  executionTarget: "demo",
  decisionBundleFingerprint: bundleFingerprint,
  approvalState: "APPROVABLE",
};

const passedChecks = [
  {
    name: "Market data freshness",
    passed: true,
    detail: "latest ticker is 2 seconds old",
  },
  {
    name: "Portfolio risk",
    passed: true,
    detail: "$14 after approval / $100 maximum",
  },
  {
    name: "Reconciliation",
    passed: true,
    detail: "broker and local state agree",
  },
];

const decisionBundle = {
  schemaVersion: "phase9-copilot-bundle-v1",
  createdAt: "2026-08-10T12:00:00.000Z",
  planFingerprint,
  executionTarget: "demo",
  tradingMode: "copilot",
  authorizationScope: "single-controlled-execution-attempt",
  approvalPolicyVersion: "phase9-approval-v1",
  revalidationPolicyVersion: "phase9-revalidation-v1",
  decisionAuthority: "brain-v0",
  unifiedBrain: {
    status: "shadow_context",
    reason:
      "Phase 8 council remains Shadow evidence; Brain V0 owns this proposal.",
    run: {
      decision: {
        action: "ENTER",
        reasonCode: "SUPPORTED_CONTINUATION",
        uncertainty: {
          score: 0.28,
          reasons: ["Macro specialist confidence is limited"],
        },
        supportingEvidence: [
          {
            evidenceId: "ev-1",
            summary: "Breakout held above resistance",
            source: "technical",
            strength: 0.82,
          },
        ],
        opposingEvidence: [
          {
            evidenceId: "ev-2",
            summary: "Funding is elevated",
            source: "risk",
            strength: 0.35,
          },
        ],
        thesis: {
          context: "Strong-trend regime with orderly liquidity.",
          trigger: "One-minute close above 100 with volume confirmation.",
          invalidationConditions: [
            "Price trades through the 96 protective stop",
            "Regime leaves strong trend",
          ],
          targetRationale: "Prior measured move and liquidity pocket near 110.",
          expectedDurationSeconds: 3600,
          expectedPath: [
            "Hold above breakout",
            "Retest 104",
            "Extend toward 110",
          ],
        },
      },
    },
  },
  marketState: {
    dataTimestamp: "2026-08-10T12:00:00.000Z",
    dataQuality: { status: "healthy" },
    inferences: { regime: "strong_trend" },
  },
  specialistCouncil: { consensus: { stance: "support" } },
  portfolio: {},
  risk: {
    verdict: "PASSED",
    checks: passedChecks,
    candidateMaximumLoss: 2,
    candidateNotional: 50,
    policyVersion: "risk-v3",
  },
  managementAuthority: null,
  versions: {
    plan: "brain-v0-plan-v1",
    brain: "brain-v0",
    council: "decision-council-v1",
    marketState: "market-state-v1",
    portfolio: "shadow-portfolio-intelligence-v1",
    riskPolicy: "risk-v3",
    managementPolicy: null,
  },
  limitations: [
    "Council evidence is Shadow context and has no execution authority.",
  ],
};

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    recommendation,
    decisionTrace: [],
    portfolioImpact: {
      currentOpenPositions: 1,
      maxOpenPositions: 5,
      candidateRiskUsdt: 2,
      currentPortfolioRiskUsdt: 12,
      afterPortfolioRiskUsdt: 14,
      maxPortfolioRiskUsdt: 100,
    },
    similarTrades: {
      available: false,
      reason: "Not enough comparable closed trades yet.",
      poolSize: 2,
      minPoolSize: 20,
      similarityFloor: 0.8,
      matches: [],
      stats: null,
      featuresUsed: [],
    },
    decisionBundle,
    decisionBundleFingerprint: bundleFingerprint,
    executionTarget: "demo",
    approvalChallenge,
    approvalState: "APPROVABLE",
    approvalReadiness: {
      approvable: true,
      reason:
        "All current deterministic checks permit one controlled execution attempt",
      checks: passedChecks,
    },
    auditEvents: [
      {
        id: 1,
        eventType: "PROPOSED",
        actorType: "engine",
        actorUserId: null,
        fromStatus: null,
        toStatus: "created",
        reasonCode: "BRAIN_V0_PROPOSAL",
        reason: "Immutable proposal recorded",
        occurredAt: "2026-08-10T12:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

async function mockApi(page: Page, response = workspace()) {
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json: unknown = {};
    if (path === "/api/auth/status") json = { authenticated: true };
    else if (path === "/api/auth/providers")
      json = { google: false, apple: false, demo: false };
    else if (path === "/api/config")
      json = {
        executionTarget: response.executionTarget,
        mode: "copilot",
        marketType: "spot",
      };
    else if (path === "/api/sections") json = { activated: ["crypto"] };
    else if (path === "/api/bot/status")
      json = { running: true, newEntriesAllowed: true };
    else if (path === "/api/notifications") json = [];
    else if (path === "/api/healthz") json = { status: "healthy" };
    else if (path === "/api/market/candles") json = { candles: [] };
    else if (path === "/api/copilot/inbox")
      json = { recommendations: [response.recommendation] };
    else if (path === "/api/copilot/recommendations/91/execute") {
      json = {
        ok: true,
        status: "executed",
        reason: "Demo execution entered",
        code: "EXECUTION_SUCCEEDED",
        tradeId: 701,
      };
    } else if (path === "/api/copilot/recommendations/91") json = response;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
  });
}

test("full workspace makes thesis, uncertainty, impact, authority, and audit evidence visible", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/copilot/91");
  await expect(page.getByText("APPROVABLE")).toBeVisible();
  await expect(page.getByText("DEMO TARGET")).toBeVisible();
  await expect(page.getByText(/Created .*Valid until/)).toBeVisible();
  await expect(
    page.getByText("Strong-trend regime with orderly liquidity."),
  ).toBeVisible();
  await expect(
    page.getByText("Macro specialist confidence is limited"),
  ).toBeVisible();
  await expect(page.getByText("Breakout held above resistance")).toBeVisible();
  await expect(page.getByText("If This Executes")).toBeVisible();
  await expect(
    page.getByText(
      "Council evidence is Shadow context and has no execution authority.",
    ),
  ).toBeVisible();
  await expect(page.getByText("BRAIN_V0_PROPOSAL")).toBeVisible();
});

test("approval is high-friction and submits immutable bindings plus one-attempt idempotency", async ({
  page,
}) => {
  let submitted: Record<string, unknown> | null = null;
  await mockApi(page);
  await page.route(
    "**/api/copilot/recommendations/91/execute",
    async (route) => {
      submitted = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status: "executed",
          reason: "Demo execution entered",
          code: "EXECUTION_SUCCEEDED",
          tradeId: 701,
        }),
      });
    },
  );
  await page.goto("/copilot/91");
  await page
    .getByRole("button", { name: "Approve one controlled attempt" })
    .click();
  await expect(
    page.getByText("Authorize one DEMO execution attempt"),
  ).toBeVisible();
  const authorize = page.getByRole("button", { name: "Authorize one attempt" });
  await expect(authorize).toBeDisabled();
  await page
    .getByLabel("Type the exact authorization phrase")
    .fill("APPROVE BTCUSDT LONG FOR DEMO");
  await expect(authorize).toBeEnabled();
  await authorize.click();
  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted?.expectedPlanFingerprint).toBe(planFingerprint);
  expect(submitted?.expectedDecisionBundleFingerprint).toBe(bundleFingerprint);
  expect(submitted?.executionTarget).toBe("demo");
  expect(submitted?.approvalChallenge).toBe(approvalChallenge);
  expect(submitted?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(submitted?.password).toBeUndefined();
});

test("changed safety conditions remain visibly blocked and cannot open approval", async ({
  page,
}) => {
  const blocked = workspace({
    approvalState: "EXECUTION_BLOCKED",
    approvalReadiness: {
      approvable: false,
      reason:
        "Reconciliation is unhealthy; request a new proposal after recovery",
      checks: [
        {
          name: "Reconciliation",
          passed: false,
          detail: "broker state does not agree",
        },
      ],
    },
  });
  await mockApi(page, blocked);
  await page.goto("/copilot/91");
  await expect(page.getByText("EXECUTION_BLOCKED")).toBeVisible();
  await expect(
    page.getByText(
      "Reconciliation is unhealthy; request a new proposal after recovery",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve one controlled attempt" }),
  ).toBeDisabled();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("Live approval is unmistakable and requires current-password step-up", async ({
  page,
}) => {
  const live = workspace({
    recommendation: { ...recommendation, executionTarget: "live" },
    executionTarget: "live",
    decisionBundle: { ...decisionBundle, executionTarget: "live" },
  });
  await mockApi(page, live);
  await page.goto("/copilot/91");
  await expect(page.getByText("LIVE TARGET")).toBeVisible();
  await page
    .getByRole("button", { name: "Approve one controlled attempt" })
    .click();
  await expect(
    page.getByText("Authorize one LIVE execution attempt"),
  ).toBeVisible();
  const authorize = page.getByRole("button", { name: "Authorize one attempt" });
  await page
    .getByLabel("Type the exact authorization phrase")
    .fill("APPROVE BTCUSDT LONG FOR LIVE");
  await expect(authorize).toBeDisabled();
  await page
    .getByLabel("Current password (Live step-up)")
    .fill("not-submitted-in-this-test");
  await expect(authorize).toBeEnabled();
});
