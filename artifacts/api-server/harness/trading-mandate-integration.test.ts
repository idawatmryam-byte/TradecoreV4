/** PostgreSQL-backed Phase 12 lifecycle, concurrency, replay, restart, and race verification. */
if (!process.env.DATABASE_URL) {
  console.log("trading-mandate integration SKIPPED (no DATABASE_URL)");
  process.exit(0);
}

import { eq, sql } from "drizzle-orm";
import type {
  RestrictedLiveEvidence,
  TradingMandateTerms,
} from "../src/lib/tradingMandates/contracts";

const {
  db,
  tradingMandateAuthorizationsTable,
  tradingMandateDecisionClaimsTable,
  tradingMandateEventsTable,
  tradingMandateStatesTable,
  tradingMandateUsageTable,
  tradingMandatesTable,
} = await import("@workspace/db");
const { ensureBrainV0Version, transitionBrainVersion } =
  await import("../src/lib/autopilot/store");
const {
  MandateConflictError,
  approveTradingMandate,
  authorizeRestrictedLiveClaimAtBoundary,
  createTradingMandate,
  evaluateAndClaimRestrictedLiveDecision,
  getActiveTradingMandate,
  getTradingMandateUsage,
  listTradingMandateEvents,
  transitionTradingMandate,
} = await import("../src/lib/tradingMandates/store");

const USER = 990012;
let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(
    `${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`,
  );
}
async function refused(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return (
      error instanceof MandateConflictError ||
      /unique|permission|denied/i.test(String(error))
    );
  }
}
async function cleanup() {
  await db.execute(sql`SELECT capture.purge_user_data(${USER})`);
}

async function main() {
  await cleanup();
  try {
    const registered = await ensureBrainV0Version(USER, "crypto");
    const brain =
      registered.state === "DEMO_APPROVED"
        ? registered
        : await transitionBrainVersion({
            userId: USER,
            section: "crypto",
            versionId: registered.id,
            toState: "DEMO_APPROVED",
            reason:
              "Phase 12 integration approved exact Brain V0 for Demo first",
            actorUserId: USER,
          });
    const now = Date.now();
    const terms: TradingMandateTerms = {
      brainVersionId: brain.id,
      brainVersion: brain.version,
      brainFingerprint: brain.fingerprint,
      accountIds: ["integration-account"],
      exchanges: ["binance_spot_live"],
      markets: ["spot"],
      symbols: ["BTCUSDT"],
      strategies: { breakout: "strategy-v1" },
      models: [brain.implementation],
      settlementCurrency: "USDT",
      monetaryScale: 8,
      maximumPerTradeRisk: "100",
      maximumPositionNotional: "1000",
      maximumAggregateExposure: "5000",
      maximumLeverageBps: 10_000,
      maximumConcurrentPositions: 2,
      maximumConcurrentOrders: 4,
      dailyLossLimit: "200",
      weeklyLossLimit: "500",
      monthlyLossLimit: "1000",
      maximumDrawdownBps: 500,
      tradingHours: [
        {
          timezone: "UTC",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          startMinute: 0,
          endMinute: 1440,
        },
      ],
      effectiveAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 86_400_000).toISOString(),
      canaryAllocation: "2000",
      automaticSuspension: {
        maximumSpreadBps: 50,
        maximumSlippageBps: 40,
        maximumFillLatencyMs: 5000,
        maximumProtectionFailures: 0,
        maximumReconciliationAgeSeconds: 60,
        maximumDecisionRatePerHour: 30,
        maximumEntryRatePerHour: 5,
        maximumLiveDemoDivergenceBps: 75,
        maximumMarketDataAgeSeconds: 30,
      },
      fallbackPolicy: "COPILOT_VALID_ONLY",
    };
    const createInput = {
      userId: USER,
      section: "crypto" as const,
      clientRequestId: "phase12-create-1",
      expectedNextRevision: 1,
      replacesMandateId: null,
      changeReason: "Integration creates immutable Restricted Live authority",
      terms,
      actorUserId: USER,
    };
    const first = await createTradingMandate(createInput);
    const replay = await createTradingMandate(createInput);
    expect(
      "create request is idempotent",
      first.id === replay.id && first.fingerprint === replay.fingerprint,
    );
    expect(
      "draft has no authority",
      (await getActiveTradingMandate({ userId: USER, section: "crypto" })) ===
        null,
    );
    const pending = await transitionTradingMandate({
      mandateId: first.id,
      userId: USER,
      section: "crypto",
      expectedRevision: 1,
      clientRequestId: "phase12-submit-1",
      reason: "Integration submits exact immutable revision",
      actorType: "HUMAN",
      actorUserId: USER,
      action: "SUBMIT",
    });
    expect(
      "pending approval still has no authority",
      pending.lifecycleState === "PENDING_APPROVAL" &&
        (await getActiveTradingMandate({ userId: USER, section: "crypto" })) ===
          null,
    );

    const approval = {
      mandateId: first.id,
      userId: USER,
      section: "crypto" as const,
      expectedRevision: 1,
      clientRequestId: "phase12-approve-1",
      authorizationId: "phase12-authorization-1",
      reason: "Integration step-up authorizes this exact fingerprint",
      actorUserId: USER,
      sessionVersion: 7,
      authorizationMethod: "PASSWORD_STEP_UP" as const,
    };
    const concurrent = await Promise.allSettled([
      approveTradingMandate(approval),
      approveTradingMandate({
        ...approval,
        clientRequestId: "phase12-approve-2",
        authorizationId: "phase12-authorization-2",
      }),
    ]);
    expect(
      "concurrent approval has exactly one winner",
      concurrent.filter((item) => item.status === "fulfilled").length === 1,
    );
    const active = await getActiveTradingMandate({
      userId: USER,
      section: "crypto",
    });
    expect(
      "one exact revision becomes active",
      active?.view.id === first.id &&
        active.view.fingerprint === first.fingerprint,
    );
    const idempotentApproval = await approveTradingMandate(approval);
    expect(
      "exact approval request replay is idempotent",
      idempotentApproval.lifecycleState === "ACTIVE",
    );
    expect(
      "different duplicate approval is refused",
      await refused(() =>
        approveTradingMandate({
          ...approval,
          clientRequestId: "phase12-approve-3",
          authorizationId: "phase12-authorization-3",
        }),
      ),
    );
    expect(
      "authorization evidence is singular",
      (
        await db
          .select()
          .from(tradingMandateAuthorizationsTable)
          .where(eq(tradingMandateAuthorizationsTable.userId, USER))
      ).length === 1,
    );

    const evidence: RestrictedLiveEvidence = {
      now: new Date(),
      lifecycleState: "ACTIVE",
      tenantId: `user:${USER}`,
      userId: USER,
      section: "crypto",
      accountId: "integration-account",
      executionAuthority: "binance_spot_live",
      market: "spot",
      symbol: "BTCUSDT",
      strategyId: "breakout",
      strategyVersion: "strategy-v1",
      model: brain.implementation,
      brainVersion: brain.version,
      brainFingerprint: brain.fingerprint,
      perTradeRisk: 100n,
      positionNotional: 1000n,
      aggregateExposure: 1000n,
      canaryUsed: 0n,
      leverageBps: 10_000,
      openPositionCount: 0,
      openOrderCount: 0,
      dailyLoss: 0n,
      weeklyLoss: 0n,
      monthlyLoss: 0n,
      drawdownBps: 0,
      decisionsLastHour: 0,
      entriesLastHour: 0,
      spreadBps: 1,
      expectedSlippageBps: 1,
      fillLatencyMs: null,
      protectionFailures: 0,
      reconciliationAgeSeconds: 1,
      liveDemoDivergenceBps: null,
      marketDataAgeSeconds: 1,
      deterministicRiskPassed: true,
      currentStateRevalidated: true,
      phase11Healthy: true,
      killSwitchActive: false,
      blockingOperatingMode: false,
      decisionId: "decision-1",
      riskDecisionId: "risk-1",
      planFingerprint: "plan-1",
      configurationFingerprint: "config-1",
      ownershipGeneration: 3,
    };
    const identity = {
      decisionId: "decision-1",
      decisionFingerprint: "b".repeat(64),
      riskDecisionId: "risk-1",
      riskFingerprint: "c".repeat(64),
      planFingerprint: "plan-1",
      configurationFingerprint: "config-1",
      ownershipGeneration: 3,
      idempotencyKey: "phase12-command-1",
    };
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        evaluateAndClaimRestrictedLiveDecision({
          mandateId: first.id,
          mandateFingerprint: first.fingerprint,
          userId: USER,
          section: "crypto",
          evidence,
          identity,
        }),
      ),
    );
    const won = claims.filter((item) => item.allowed);
    expect(
      "concurrent decision has one durable claimant",
      won.length === 1,
      String(won.length),
    );
    const claimId = (won[0] as { allowed: true; claimId: number }).claimId;
    const boundary = await authorizeRestrictedLiveClaimAtBoundary({
      context: {
        claimId,
        mandateId: first.id,
        mandateRevision: 1,
        mandateFingerprint: first.fingerprint,
        brainVersion: brain.version,
        brainFingerprint: brain.fingerprint,
        decisionFingerprint: identity.decisionFingerprint,
        riskFingerprint: identity.riskFingerprint,
        configurationFingerprint: identity.configurationFingerprint,
        idempotencyKey: identity.idempotencyKey,
      },
      userId: USER,
      section: "crypto",
      ownershipGeneration: 3,
    });
    expect("durable claim is revalidated at Live boundary", boundary.allowed);
    await transitionTradingMandate({
      mandateId: first.id,
      userId: USER,
      section: "crypto",
      expectedRevision: 1,
      clientRequestId: "phase12-suspend-1",
      reason: "Integration suspends all later new entries",
      actorType: "SYSTEM",
      action: "SUSPEND",
    });
    expect(
      "already boundary-authorized in-flight command has deterministic status",
      (
        await authorizeRestrictedLiveClaimAtBoundary({
          context: {
            claimId,
            mandateId: first.id,
            mandateRevision: 1,
            mandateFingerprint: first.fingerprint,
            brainVersion: brain.version,
            brainFingerprint: brain.fingerprint,
            decisionFingerprint: identity.decisionFingerprint,
            riskFingerprint: identity.riskFingerprint,
            configurationFingerprint: identity.configurationFingerprint,
            idempotencyKey: identity.idempotencyKey,
          },
          userId: USER,
          section: "crypto",
          ownershipGeneration: 3,
        })
      ).allowed,
    );
    const later = await evaluateAndClaimRestrictedLiveDecision({
      mandateId: first.id,
      mandateFingerprint: first.fingerprint,
      userId: USER,
      section: "crypto",
      evidence: { ...evidence, decisionId: "decision-2" },
      identity: {
        ...identity,
        decisionId: "decision-2",
        decisionFingerprint: "d".repeat(64),
        idempotencyKey: "phase12-command-2",
      },
    });
    expect(
      "persistent suspension blocks all later claims",
      !later.allowed && later.evaluation.reasonCode === "MANDATE_SUSPENDED",
    );
    const usage = await getTradingMandateUsage(first.id);
    expect(
      "usage projection survives a fresh store read",
      usage !== null && usage.mandateId === first.id,
    );
    const eventTypes = new Set(
      (await listTradingMandateEvents(USER, "crypto")).map(
        (event) => event.eventType,
      ),
    );
    expect(
      "audit is complete for create, approval, and suspension",
      [
        "MANDATE_CREATED",
        "MANDATE_PENDING_APPROVAL",
        "MANDATE_AUTHORIZED",
        "MANDATE_SUSPENDED",
      ].every((item) => eventTypes.has(item)),
    );
    expect(
      "cross-user read is isolated",
      (await getActiveTradingMandate({
        userId: USER + 1,
        section: "crypto",
      })) === null,
    );
    expect(
      "crypto and forex are isolated",
      (await getActiveTradingMandate({ userId: USER, section: "forex" })) ===
        null,
    );
    expect(
      "decision identity remains unique",
      (
        await db
          .select()
          .from(tradingMandateDecisionClaimsTable)
          .where(eq(tradingMandateDecisionClaimsTable.userId, USER))
      ).length === 2,
    );
  } finally {
    await cleanup();
  }
  console.log(
    failures === 0
      ? "\ntrading-mandate integration: all checks passed"
      : `\ntrading-mandate integration: ${failures} FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
