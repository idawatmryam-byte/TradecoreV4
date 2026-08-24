/** PostgreSQL-backed Phase 12.1 transaction and serialization regressions. */
if (!process.env.DATABASE_URL) {
  console.log(
    "trading-mandate Phase 12.1 integration SKIPPED (no DATABASE_URL)",
  );
  process.exit(0);
}

import { and, eq, sql } from "drizzle-orm";
import type {
  RestrictedLiveEvidence,
  TradingMandateTerms,
} from "../src/lib/tradingMandates/contracts";
import { sha256Fingerprint } from "../src/lib/intelligence/canonical";

const {
  autopilotEventsTable,
  brainVersionsTable,
  db,
  tradingMandateAuthorizationsTable,
  tradingMandateDecisionClaimsTable,
  tradingMandateEventsTable,
  tradingMandateStatesTable,
} = await import("@workspace/db");
const { ensureBrainV0Version, transitionBrainVersion } =
  await import("../src/lib/autopilot/store");
const {
  approveTradingMandate,
  createTradingMandate,
  evaluateAndClaimRestrictedLiveDecision,
  evaluateAndClaimRestrictedLiveDecisionInTransaction,
  getTradingMandateView,
  transitionTradingMandate,
} = await import("../src/lib/tradingMandates/store");

const USERS = [991201, 991202, 991203, 991204, 991205, 991206, 991207, 991208];
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
  } catch {
    return true;
  }
}

async function cleanup() {
  for (const userId of USERS) {
    await db.execute(sql`SELECT capture.purge_user_data(${userId})`);
  }
}

async function demoBrain(userId: number) {
  const registered = await ensureBrainV0Version(userId, "crypto");
  return registered.state === "DEMO_APPROVED"
    ? registered
    : transitionBrainVersion({
        userId,
        section: "crypto",
        versionId: registered.id,
        toState: "DEMO_APPROVED",
        reason: "Phase 12.1 regression requires exact Demo-approved Brain V0",
        actorUserId: userId,
      });
}

function terms(
  brain: Awaited<ReturnType<typeof demoBrain>>,
  overrides: Partial<TradingMandateTerms> = {},
): TradingMandateTerms {
  const now = Date.now();
  return {
    brainVersionId: brain.id,
    brainVersion: brain.version,
    brainFingerprint: brain.fingerprint,
    accountIds: ["phase12-1-account"],
    exchanges: ["binance_spot_live"],
    markets: ["spot"],
    symbols: ["BTCUSDT"],
    strategies: { breakout: "strategy-v1" },
    models: [brain.implementation],
    settlementCurrency: "USDT",
    monetaryScale: 8,
    maximumPerTradeRisk: "100",
    maximumPositionNotional: "1000",
    maximumAggregateExposure: "1000",
    maximumLeverageBps: 10_000,
    maximumConcurrentPositions: 10,
    maximumConcurrentOrders: 10,
    dailyLossLimit: "1000",
    weeklyLossLimit: "2000",
    monthlyLossLimit: "3000",
    maximumDrawdownBps: 500,
    tradingHours: [
      {
        timezone: "UTC",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        startMinute: 0,
        endMinute: 1440,
      },
    ],
    effectiveAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    canaryAllocation: "1000",
    automaticSuspension: {
      maximumSpreadBps: 50,
      maximumSlippageBps: 40,
      maximumFillLatencyMs: 5_000,
      maximumProtectionFailures: 0,
      maximumReconciliationAgeSeconds: 60,
      maximumDecisionRatePerHour: 100,
      maximumEntryRatePerHour: 100,
      maximumLiveDemoDivergenceBps: 75,
      maximumMarketDataAgeSeconds: 30,
    },
    fallbackPolicy: "COPILOT_VALID_ONLY",
    ...overrides,
  };
}

async function pendingMandate(
  userId: number,
  prefix: string,
  overrides: Partial<TradingMandateTerms> = {},
) {
  const brain = await demoBrain(userId);
  const mandate = await createTradingMandate({
    userId,
    section: "crypto",
    clientRequestId: `${prefix}:create`,
    expectedNextRevision: 1,
    replacesMandateId: null,
    changeReason: "Phase 12.1 deterministic transaction regression",
    terms: terms(brain, overrides),
    actorUserId: userId,
  });
  await transitionTradingMandate({
    mandateId: mandate.id,
    userId,
    section: "crypto",
    expectedRevision: 1,
    clientRequestId: `${prefix}:submit`,
    reason: "Submit exact Phase 12.1 regression revision",
    actorType: "HUMAN",
    actorUserId: userId,
    action: "SUBMIT",
  });
  return { brain, mandate };
}

async function activeMandate(
  userId: number,
  prefix: string,
  overrides: Partial<TradingMandateTerms> = {},
) {
  const created = await pendingMandate(userId, prefix, overrides);
  await approveTradingMandate({
    mandateId: created.mandate.id,
    userId,
    section: "crypto",
    expectedRevision: 1,
    clientRequestId: `${prefix}:approve`,
    authorizationId: `${prefix}:authorization`,
    reason: "Authorize exact Phase 12.1 regression revision",
    actorUserId: userId,
    sessionVersion: 1,
    authorizationMethod: "PASSWORD_STEP_UP",
  });
  return created;
}

function evidence(
  userId: number,
  brain: Awaited<ReturnType<typeof demoBrain>>,
  decisionId: string,
  positionNotional: bigint,
  spreadBps = 1,
): RestrictedLiveEvidence {
  return {
    now: new Date(),
    lifecycleState: "ACTIVE",
    tenantId: `user:${userId}`,
    userId,
    section: "crypto",
    accountId: "phase12-1-account",
    executionAuthority: "binance_spot_live",
    market: "spot",
    symbol: "BTCUSDT",
    strategyId: "breakout",
    strategyVersion: "strategy-v1",
    model: brain.implementation,
    brainVersion: brain.version,
    brainFingerprint: brain.fingerprint,
    perTradeRisk: 10n,
    positionNotional,
    aggregateExposure: positionNotional,
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
    spreadBps,
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
    decisionId,
    riskDecisionId: `risk-${decisionId}`,
    planFingerprint: `plan-${decisionId}`,
    configurationFingerprint: `config-${decisionId}`,
    ownershipGeneration: 1,
  };
}

function identity(decisionId: string, hex: string) {
  return {
    decisionId,
    decisionFingerprint: hex.repeat(64),
    riskDecisionId: `risk-${decisionId}`,
    riskFingerprint: hex.toUpperCase().repeat(64),
    planFingerprint: `plan-${decisionId}`,
    configurationFingerprint: `config-${decisionId}`,
    ownershipGeneration: 1,
    idempotencyKey: `phase12-1:${decisionId}`,
  };
}

async function atomicApprovalRegression() {
  const userId = USERS[0]!;
  const { brain, mandate } = await pendingMandate(userId, "p12-1-atomic");
  const approval = {
    mandateId: mandate.id,
    userId,
    section: "crypto" as const,
    expectedRevision: 1,
    clientRequestId: "p12-1-atomic:approve",
    authorizationId: "p12-1-atomic:authorization",
    reason: "Atomic brain and mandate approval regression",
    actorUserId: userId,
    sessionVersion: 3,
    authorizationMethod: "PASSWORD_STEP_UP" as const,
  };
  await db.insert(tradingMandateEventsTable).values({
    eventKey: sha256Fingerprint({
      type: "MANDATE_AUTHORIZED",
      userId,
      mandateId: mandate.id,
      clientRequestId: approval.clientRequestId,
    }),
    mandateId: mandate.id,
    userId,
    section: "crypto",
    eventType: "PHASE12_1_ROLLBACK_SENTINEL",
    actorType: "SYSTEM",
    reasonCode: "PHASE12_1_ROLLBACK_SENTINEL",
    reason:
      "Force a deterministic late event conflict after transactional mutations",
  });
  expect(
    "late approval persistence conflict is refused",
    await refused(() => approveTradingMandate(approval)),
  );
  const [brainAfterFailure] = await db
    .select()
    .from(brainVersionsTable)
    .where(eq(brainVersionsTable.id, brain.id));
  const mandateAfterFailure = await getTradingMandateView({
    mandateId: mandate.id,
    userId,
    section: "crypto",
  });
  const failedAuthorizations = await db
    .select()
    .from(tradingMandateAuthorizationsTable)
    .where(eq(tradingMandateAuthorizationsTable.mandateId, mandate.id));
  const failedApprovalEvents = await db
    .select()
    .from(tradingMandateEventsTable)
    .where(
      and(
        eq(tradingMandateEventsTable.mandateId, mandate.id),
        eq(tradingMandateEventsTable.eventType, "MANDATE_AUTHORIZED"),
      ),
    );
  const failedBrainEvents = await db
    .select()
    .from(autopilotEventsTable)
    .where(
      and(
        eq(autopilotEventsTable.brainVersionId, brain.id),
        eq(autopilotEventsTable.toState, "LIVE_RESTRICTED"),
      ),
    );
  expect(
    "failed approval leaves no partial brain or mandate authority",
    brainAfterFailure?.state === "DEMO_APPROVED" &&
      mandateAfterFailure.lifecycleState === "PENDING_APPROVAL" &&
      failedAuthorizations.length === 0 &&
      failedApprovalEvents.length === 0 &&
      failedBrainEvents.length === 0,
  );

  const approved = await approveTradingMandate({
    ...approval,
    clientRequestId: "p12-1-atomic:approve-success",
    authorizationId: "p12-1-atomic:authorization-success",
  });
  const [brainAfterSuccess] = await db
    .select()
    .from(brainVersionsTable)
    .where(eq(brainVersionsTable.id, brain.id));
  const successfulAuthorizations = await db
    .select()
    .from(tradingMandateAuthorizationsTable)
    .where(eq(tradingMandateAuthorizationsTable.mandateId, mandate.id));
  const brainEvents = await db
    .select()
    .from(autopilotEventsTable)
    .where(
      and(
        eq(autopilotEventsTable.brainVersionId, brain.id),
        eq(autopilotEventsTable.toState, "LIVE_RESTRICTED"),
      ),
    );
  expect(
    "successful approval commits brain, mandate, authorization, and audit together",
    approved.lifecycleState === "ACTIVE" &&
      brainAfterSuccess?.state === "LIVE_RESTRICTED" &&
      successfulAuthorizations.length === 1 &&
      brainEvents.length === 1,
  );
}

async function reservationRegression() {
  for (let iteration = 0; iteration < 3; iteration++) {
    const overUser = USERS[1 + iteration]!;
    const prefix = `p12-1-over-${iteration + 1}`;
    const over = await activeMandate(overUser, prefix, {
      canaryAllocation: "100",
    });
    const overResults = await Promise.all([
      evaluateAndClaimRestrictedLiveDecision({
        mandateId: over.mandate.id,
        mandateFingerprint: over.mandate.fingerprint,
        userId: overUser,
        section: "crypto",
        evidence: evidence(overUser, over.brain, `${prefix}-a`, 60n),
        identity: identity(`${prefix}-a`, "a"),
      }),
      evaluateAndClaimRestrictedLiveDecision({
        mandateId: over.mandate.id,
        mandateFingerprint: over.mandate.fingerprint,
        userId: overUser,
        section: "crypto",
        evidence: evidence(overUser, over.brain, `${prefix}-b`, 60n),
        identity: identity(`${prefix}-b`, "b"),
      }),
    ]);
    const overClaims = await db
      .select()
      .from(tradingMandateDecisionClaimsTable)
      .where(eq(tradingMandateDecisionClaimsTable.mandateId, over.mandate.id));
    const reserved = overClaims
      .filter((claim) => claim.status !== "REFUSED")
      .reduce(
        (total, claim) => total + BigInt(claim.reservedNotional ?? "0"),
        0n,
      );
    expect(
      `concurrent 60 + 60 iteration ${iteration + 1} has one claimant and one capacity refusal`,
      overResults.filter((result) => result.allowed).length === 1 &&
        overResults.some(
          (result) =>
            !result.allowed &&
            result.evaluation.reasonCode === "CANARY_ALLOCATION_EXHAUSTED",
        ) &&
        reserved === 60n,
      `reserved=${reserved}`,
    );
  }

  const boundaryUser = USERS[4]!;
  const boundary = await activeMandate(boundaryUser, "p12-1-boundary", {
    canaryAllocation: "100",
  });
  const boundaryResults = await Promise.all([
    evaluateAndClaimRestrictedLiveDecision({
      mandateId: boundary.mandate.id,
      mandateFingerprint: boundary.mandate.fingerprint,
      userId: boundaryUser,
      section: "crypto",
      evidence: evidence(boundaryUser, boundary.brain, "boundary-a", 40n),
      identity: identity("boundary-a", "c"),
    }),
    evaluateAndClaimRestrictedLiveDecision({
      mandateId: boundary.mandate.id,
      mandateFingerprint: boundary.mandate.fingerprint,
      userId: boundaryUser,
      section: "crypto",
      evidence: evidence(boundaryUser, boundary.brain, "boundary-b", 60n),
      identity: identity("boundary-b", "d"),
    }),
  ]);
  const boundaryClaims = await db
    .select()
    .from(tradingMandateDecisionClaimsTable)
    .where(
      eq(tradingMandateDecisionClaimsTable.mandateId, boundary.mandate.id),
    );
  const boundaryReserved = boundaryClaims.reduce(
    (total, claim) => total + BigInt(claim.reservedNotional ?? "0"),
    0n,
  );
  expect(
    "concurrent 40 + 60 inclusive boundary authorizes both without missing accounting",
    boundaryResults.every((result) => result.allowed) &&
      boundaryReserved === 100n,
    `reserved=${boundaryReserved}`,
  );
}

async function suspensionRegression(userId: number, iteration: number) {
  const prefix = `p12-1-suspend-${iteration}`;
  const active = await activeMandate(userId, prefix, {
    automaticSuspension: {
      maximumSpreadBps: 10,
      maximumSlippageBps: 40,
      maximumFillLatencyMs: 5_000,
      maximumProtectionFailures: 0,
      maximumReconciliationAgeSeconds: 60,
      maximumDecisionRatePerHour: 100,
      maximumEntryRatePerHour: 100,
      maximumLiveDemoDivergenceBps: 75,
      maximumMarketDataAgeSeconds: 30,
    },
  });
  let release!: () => void;
  let suspensionEvaluated!: () => void;
  const releasePromise = new Promise<void>((resolve) => (release = resolve));
  const evaluatedPromise = new Promise<void>(
    (resolve) => (suspensionEvaluated = resolve),
  );
  const suspending = db.transaction(async (tx) => {
    const result = await evaluateAndClaimRestrictedLiveDecisionInTransaction(
      tx,
      {
        mandateId: active.mandate.id,
        mandateFingerprint: active.mandate.fingerprint,
        userId,
        section: "crypto",
        evidence: evidence(userId, active.brain, `${prefix}-a`, 10n, 10),
        identity: identity(`${prefix}-a`, "e"),
      },
    );
    suspensionEvaluated();
    await releasePromise;
    return result;
  });
  await evaluatedPromise;
  const visibleState = await getTradingMandateView({
    mandateId: active.mandate.id,
    userId,
    section: "crypto",
  });
  const visibleRefusals = await db
    .select()
    .from(tradingMandateDecisionClaimsTable)
    .where(eq(tradingMandateDecisionClaimsTable.mandateId, active.mandate.id));
  expect(
    `suspension iteration ${iteration} exposes neither half before commit`,
    visibleState.lifecycleState === "ACTIVE" && visibleRefusals.length === 0,
  );

  const healthy = evaluateAndClaimRestrictedLiveDecision({
    mandateId: active.mandate.id,
    mandateFingerprint: active.mandate.fingerprint,
    userId,
    section: "crypto",
    evidence: evidence(userId, active.brain, `${prefix}-b`, 10n, 1),
    identity: identity(`${prefix}-b`, "f"),
  });
  const healthyBlocked = await Promise.race([
    healthy.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 75)),
  ]);
  release();
  const [suspendingResult, healthyResult] = await Promise.all([
    suspending,
    healthy,
  ]);
  const finalState = await getTradingMandateView({
    mandateId: active.mandate.id,
    userId,
    section: "crypto",
  });
  const claims = await db
    .select()
    .from(tradingMandateDecisionClaimsTable)
    .where(eq(tradingMandateDecisionClaimsTable.mandateId, active.mandate.id));
  const suspensionClaim = claims.find(
    (claim) => claim.decisionId === `${prefix}-a`,
  );
  const event = suspensionClaim?.suspensionEventId
    ? (
        await db
          .select()
          .from(tradingMandateEventsTable)
          .where(
            eq(tradingMandateEventsTable.id, suspensionClaim.suspensionEventId),
          )
      )[0]
    : null;
  expect(
    `suspension iteration ${iteration} serializes refusal, suspension, and healthy contender`,
    healthyBlocked &&
      !suspendingResult.allowed &&
      suspendingResult.automaticallySuspended &&
      !healthyResult.allowed &&
      healthyResult.evaluation.reasonCode === "MANDATE_SUSPENDED" &&
      finalState.lifecycleState === "SUSPENDED" &&
      event?.eventType === "MANDATE_SUSPENDED" &&
      event.toState === "SUSPENDED",
  );
}

async function main() {
  await cleanup();
  try {
    await atomicApprovalRegression();
    await reservationRegression();
    for (let iteration = 0; iteration < 3; iteration++) {
      await suspensionRegression(USERS[5 + iteration]!, iteration + 1);
    }
  } finally {
    await cleanup();
  }
  console.log(
    failures === 0
      ? "\ntrading-mandate Phase 12.1 integration: all checks passed"
      : `\ntrading-mandate Phase 12.1 integration: ${failures} FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
