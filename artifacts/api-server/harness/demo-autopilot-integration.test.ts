/** PostgreSQL-backed Phase 10 concurrency, idempotency, lifecycle, and audit verification. */
if (!process.env.DATABASE_URL) {
  console.log("demo-autopilot integration SKIPPED (no DATABASE_URL)");
  process.exit(0);
}

import { eq, sql, type SQL } from "drizzle-orm";
import { makeAutopilotClientOrderId, makeAutopilotCorrelationId } from "../src/lib/execution/ids";
import { autonomousIdempotencyKey } from "../src/lib/autopilot/fingerprints";

const {
  autopilotControlsTable, autopilotDecisionClaimsTable, autopilotEventsTable,
  autopilotMandateStatesTable, brainVersionsTable, db, demoMandatesTable,
  executionIntentsTable,
} = await import("@workspace/db");
const {
  claimAutonomousDecision, completeAutonomousDecision, createMandate,
  ensureBrainV0Version, getAutopilotSnapshot, listAutopilotEvents,
  recordAutonomousRefusal, setAutopilotState, transitionBrainVersion,
} = await import("../src/lib/autopilot/store");

const USER = 990010;
let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(`${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`);
}

class UnexpectedlyAllowedMutation extends Error {}

async function mutationIsRefused(statement: SQL, rollbackIfAllowed = false): Promise<boolean> {
  try {
    if (rollbackIfAllowed) {
      await db.transaction(async (tx) => {
        await tx.execute(statement);
        throw new UnexpectedlyAllowedMutation();
      });
    } else {
      await db.execute(statement);
    }
    return false;
  } catch (error) {
    return !(error instanceof UnexpectedlyAllowedMutation);
  }
}

async function cleanup() {
  await db.execute(sql`SELECT capture.purge_user_data(${USER})`);
  await db.delete(executionIntentsTable).where(eq(executionIntentsTable.userId, USER));
}

async function main() {
  await cleanup();
  try {
    const brain = await ensureBrainV0Version(USER, "crypto");
    expect("Brain V0 is registered without autonomous authority", brain.state === "COPILOT");
    const approved = await transitionBrainVersion({
      userId: USER, section: "crypto", versionId: brain.id, toState: "DEMO_APPROVED",
      reason: "Integration operator explicitly approved exact Brain V0 for Demo", actorUserId: USER,
    });
    expect("explicit lifecycle transition grants Demo-only eligibility", approved.state === "DEMO_APPROVED");

    const mandate = await createMandate({
      schemaVersion: "phase10-demo-autopilot-v1", userId: USER, section: "crypto", version: 1,
      botConfigId: 100, configFingerprint: "a".repeat(64), brainVersionId: approved.id,
      brainVersion: "brain-v0", executionAuthority: "simulated_demo", marketType: "spot",
      instruments: ["BTCUSDT"], strategyVersions: { breakout: "strategy-config:fixture" },
      maximumPositionSizeUsdt: 500, maximumLeverage: 1, maximumPortfolioRiskPercent: 5,
      maximumSymbolExposurePercent: 50, maximumNetExposurePercent: 100,
      maximumCorrelatedExposurePercent: 100, dailyLossLimitUsdt: 100,
      maximumDrawdownPercent: 10, maximumConcurrentPositions: 3, maximumMarketDataAgeSeconds: 30,
      allowedTradingHoursUtc: [],
      permittedPhase7Actions: ["HOLD", "FREEZE", "REDUCE", "TIGHTEN_STOP", "APPLY_TRAILING", "EXIT"],
      validFrom: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }, USER);
    expect("immutable mandate has a content fingerprint", /^[a-f0-9]{64}$/.test(mandate.fingerprint));

    await setAutopilotState({
      userId: USER, section: "crypto", state: "AUTOPILOT_ENABLED",
      reasonCode: "HUMAN_ACTIVATION_APPROVED", reason: "Integration operator enabled the exact immutable Demo mandate",
      actor: { actorType: "user", actorUserId: USER }, mandateId: mandate.id,
      configSuspended: false, globalSuspended: false,
    });
    let snapshot = await getAutopilotSnapshot(USER, "crypto");
    expect("human activation enables the exact mandate", snapshot.control.state === "AUTOPILOT_ENABLED" && snapshot.mandateState?.state === "ACTIVE");

    const decisionFingerprint = "b".repeat(64);
    const riskFingerprint = "c".repeat(64);
    const idempotencyKey = autonomousIdempotencyKey({ userId: USER, section: "crypto", mandateFingerprint: mandate.fingerprint, decisionFingerprint });
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => claimAutonomousDecision({
      userId: USER, section: "crypto", mandateId: mandate.id, mandateFingerprint: mandate.fingerprint,
      brainVersion: mandate.brainVersion, decisionFingerprint, riskFingerprint, idempotencyKey,
    })));
    const claims = concurrent.filter(Boolean);
    expect("concurrent duplicate decision has exactly one durable claimant", claims.length === 1, String(claims.length));

    const claim = claims[0]!;
    const correlationId = makeAutopilotCorrelationId(idempotencyKey);
    const clientOrderId = makeAutopilotClientOrderId(USER, idempotencyKey);
    const intentValues = {
      userId: USER, section: "crypto", correlationId, clientOrderId,
      planFingerprint: "d".repeat(64), autopilotClaimId: claim.id, autopilotMandateId: mandate.id,
      autopilotMandateFingerprint: mandate.fingerprint, brainVersion: mandate.brainVersion,
      brainDecisionFingerprint: decisionFingerprint, riskDecisionFingerprint: riskFingerprint,
      autopilotIdempotencyKey: idempotencyKey, symbol: "BTCUSDT", side: "buy", marketType: "spot",
      plannedEntryPrice: "100", plannedStopLoss: "98", plannedTakeProfit: "104", plannedQuantity: "1",
    };
    const firstIntent = await db.insert(executionIntentsTable).values(intentValues).onConflictDoNothing().returning();
    const duplicateIntent = await db.insert(executionIntentsTable).values(intentValues).onConflictDoNothing().returning();
    expect("autonomous execution intent is idempotent at the database seam", firstIntent.length === 1 && duplicateIntent.length === 0);

    await completeAutonomousDecision({
      claimId: claim.id, userId: USER, section: "crypto", status: "EXECUTED",
      reasonCode: "AUTONOMOUS_EXECUTION_SUCCEEDED", reason: "Integration simulated execution persisted",
      executionIntentId: firstIntent[0]!.id,
    });
    await completeAutonomousDecision({
      claimId: claim.id, userId: USER, section: "crypto", status: "EXECUTED",
      reasonCode: "AUTONOMOUS_EXECUTION_SUCCEEDED", reason: "Duplicate completion must be a no-op",
      executionIntentId: firstIntent[0]!.id,
    });
    const persistedClaims = await db.select().from(autopilotDecisionClaimsTable).where(eq(autopilotDecisionClaimsTable.userId, USER));
    expect("execution outcome is durable and singular", persistedClaims.length === 1 && persistedClaims[0]?.status === "EXECUTED");
    await recordAutonomousRefusal({
      userId: USER, section: "crypto", mandateId: mandate.id,
      mandateFingerprint: mandate.fingerprint,
      decisionFingerprint: "e".repeat(64), reasonCode: "MARKET_DATA_STALE",
      reason: "Integration stale MarketState refusal", checks: [{ name: "Market data freshness", passed: false }],
    });

    await setAutopilotState({
      userId: USER, section: "crypto", state: "AUTOPILOT_PAUSED", reasonCode: "HUMAN_PAUSE",
      reason: "Integration operator paused autonomous entries while retaining protective management",
      actor: { actorType: "user", actorUserId: USER }, mandateId: mandate.id, configSuspended: true,
    });
    snapshot = await getAutopilotSnapshot(USER, "crypto");
    expect("pause halts new entries and suspends only the mandate", snapshot.control.state === "AUTOPILOT_PAUSED" && snapshot.mandateState?.state === "SUSPENDED");
    await setAutopilotState({
      userId: USER, section: "crypto", state: "AUTOPILOT_ENABLED", reasonCode: "HUMAN_RESUME_APPROVED",
      reason: "Integration operator revalidated and resumed the exact Demo mandate",
      actor: { actorType: "user", actorUserId: USER }, mandateId: mandate.id, configSuspended: false,
    });
    snapshot = await getAutopilotSnapshot(USER, "crypto");
    expect("resume restores entries only after explicit revalidation", snapshot.control.state === "AUTOPILOT_ENABLED" && snapshot.mandateState?.state === "ACTIVE");

    const eventTypes = new Set((await listAutopilotEvents(USER, "crypto", 200)).map((event) => event.eventType));
    expect("audit records mandate creation", eventTypes.has("MANDATE_CREATED"));
    expect("audit records autonomous decision", eventTypes.has("AUTONOMOUS_DECISION_CLAIMED"));
    expect("audit records autonomous execution", eventTypes.has("AUTONOMOUS_EXECUTION_SUCCEEDED"));
    expect("audit records autonomous refusal", eventTypes.has("AUTONOMOUS_DECISION_REFUSED"));
    expect("audit records suspension and resume", eventTypes.has("AUTOPILOT_PAUSED") && eventTypes.has("AUTOPILOT_RESUMED"));

    expect("runtime role cannot update immutable mandate terms", await mutationIsRefused(
      sql`UPDATE public.demo_autopilot_mandates SET fingerprint = fingerprint WHERE id = -1`,
    ));
    expect("runtime role cannot delete an immutable mandate", await mutationIsRefused(
      sql`DELETE FROM public.demo_autopilot_mandates WHERE id = -1`,
    ));
    expect("runtime role cannot truncate immutable mandates", await mutationIsRefused(
      sql`TRUNCATE TABLE public.demo_autopilot_mandates`, true,
    ));
    expect("runtime role cannot update append-only Autopilot audit evidence", await mutationIsRefused(
      sql`UPDATE public.autopilot_events SET reason = reason WHERE id = -1`,
    ));
    expect("runtime role cannot delete append-only Autopilot audit evidence", await mutationIsRefused(
      sql`DELETE FROM public.autopilot_events WHERE id = -1`,
    ));
    expect("runtime role cannot truncate append-only Autopilot audit evidence", await mutationIsRefused(
      sql`TRUNCATE TABLE public.autopilot_events`, true,
    ));
    expect("runtime role cannot rewrite autonomous claim identity", await mutationIsRefused(
      sql`UPDATE public.autopilot_decision_claims SET mandate_fingerprint = mandate_fingerprint WHERE id = -1`,
    ));
    expect("runtime role cannot delete autonomous decision claims", await mutationIsRefused(
      sql`DELETE FROM public.autopilot_decision_claims WHERE id = -1`,
    ));
    expect("runtime role cannot truncate autonomous decision claims", await mutationIsRefused(
      sql`TRUNCATE TABLE public.autopilot_decision_claims`, true,
    ));

    await db.execute(sql`SELECT capture.purge_user_data(${USER})`);
    const remaining = await Promise.all([
      db.select().from(autopilotEventsTable).where(eq(autopilotEventsTable.userId, USER)),
      db.select().from(autopilotDecisionClaimsTable).where(eq(autopilotDecisionClaimsTable.userId, USER)),
      db.select().from(autopilotMandateStatesTable).where(eq(autopilotMandateStatesTable.userId, USER)),
      db.select().from(autopilotControlsTable).where(eq(autopilotControlsTable.userId, USER)),
      db.select().from(demoMandatesTable).where(eq(demoMandatesTable.userId, USER)),
      db.select().from(brainVersionsTable).where(eq(brainVersionsTable.userId, USER)),
    ]);
    expect("owner-defined account purge removes all Phase 10 evidence", remaining.every((rows) => rows.length === 0));
  } finally {
    await cleanup();
  }

  console.log(failures === 0 ? "\ndemo-autopilot integration: all checks passed" : `\ndemo-autopilot integration: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
