/** PostgreSQL-only verification for security-critical schema additions. */
if (!process.env.DATABASE_URL) {
  console.log("schema-security test SKIPPED (no DATABASE_URL)");
  process.exit(0);
}
process.env.SESSION_SECRET ??= "schema-security-integration-secret-123";
process.env.PORT ??= "8080";

import { eq, sql } from "drizzle-orm";

const USERNAME = "schema_security_harness_990081";
let failures = 0;

function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(`${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`);
}

async function main() {
  const {
    brainDecisionsTable,
    brainEvidenceReferencesTable,
    db,
    positionManagementEventsTable,
    positionThesesTable,
    researchExperimentsTable,
    researchReplayEventsTable,
    tradesTable,
    usersTable,
  } = await import("@workspace/db");
  await db.delete(usersTable).where(eq(usersTable.username, USERNAME));
  const [user] = await db.insert(usersTable).values({ username: USERNAME }).returning();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000);
  try {
    expect("session_version is present, non-null, and defaults to zero", user?.sessionVersion === 0);

    const functionResult = await db.execute(sql`
      SELECT to_regprocedure('capture.purge_user_data(integer)')::text AS name
    `);
    const functionRows = (functionResult as unknown as { rows?: Array<{ name: string | null }> }).rows ?? [];
    expect("capture purge function is installed", functionRows[0]?.name === "capture.purge_user_data(integer)");

    const [decision] = await db.insert(brainDecisionsTable).values({
      userId: user!.id,
      section: "crypto",
      decisionId: `schema-test-decision-${user!.id}`,
      schemaVersion: "1",
      brainVersion: "schema-test",
      action: "OBSERVE",
      symbol: "BTCUSDT",
      marketStateFingerprint: `m-${user!.id}`,
      decisionFingerprint: `d-${user!.id}`,
      dataTimestamp: now,
      expiresAt,
      decision: { test: true },
    }).returning();
    await db.insert(brainEvidenceReferencesTable).values({
      brainDecisionId: decision!.id,
      evidenceId: `e-${user!.id}`,
      kind: "test",
      source: "schema-security",
      reference: "integration",
      dataTimestamp: now,
    });

    const thesisId = `schema-test-thesis-${user!.id}`;
    const [trade] = await db.insert(tradesTable).values({
      userId: user!.id,
      section: "crypto",
      symbol: "BTCUSDT",
      side: "buy",
      entryPrice: "100",
      quantity: "1",
      confidence: "75",
      stopLoss: "98",
      takeProfit: "104",
      managementAuthority: "phase7",
      managementMode: "phase7_active",
      managementPolicyVersion: "phase7-bounded-management-v1",
      thesisId,
    }).returning();
    const thesisFingerprint = "a".repeat(64);
    const actionFingerprint = "b".repeat(64);
    await db.insert(positionThesesTable).values({
      userId: user!.id,
      section: "crypto",
      tradeId: trade!.id,
      thesisId,
      schemaVersion: "position-thesis-v1",
      policyVersion: "phase7-bounded-management-v1",
      thesisFingerprint,
      thesis: { thesisId, fingerprint: thesisFingerprint },
    });
    await db.insert(positionManagementEventsTable).values({
      eventId: `schema-test-event-${user!.id}`,
      userId: user!.id,
      section: "crypto",
      tradeId: trade!.id,
      thesisId,
      actionFingerprint,
      stage: "PROPOSED",
      thesisState: "VALID",
      actionType: "HOLD",
      policyVersion: "phase7-bounded-management-v1",
      validationPassed: true,
      evaluation: { test: true },
      action: { fingerprint: actionFingerprint },
      validation: { valid: true },
      observedAt: now,
    });

    const [researchExperiment] = await db.insert(researchExperimentsTable).values({
      userId: user!.id,
      section: "crypto",
      experimentId: "11111111-1111-5111-8111-111111111111",
      name: "Schema security fixture",
      manifestVersion: "phase8-experiment-v1",
      manifestFingerprint: "c".repeat(64),
      manifest: { mode: "research", cannotExecute: true },
      request: { source: "schema-security" },
      status: "pending",
      stage: "manifest",
    }).returning();
    await db.insert(researchReplayEventsTable).values({
      userId: user!.id,
      section: "crypto",
      experimentDbId: researchExperiment!.id,
      experimentId: researchExperiment!.experimentId!,
      sequence: 0,
      kind: "decision",
      partitionId: "fold-1",
      observedAt: now,
      symbol: "BTCUSDT",
      eventFingerprint: "d".repeat(64),
      event: { mode: "research", cannotExecute: true },
    });

    let duplicateActionRefused = false;
    try {
      await db.insert(positionManagementEventsTable).values({
        eventId: `schema-test-event-duplicate-${user!.id}`,
        userId: user!.id,
        section: "crypto",
        tradeId: trade!.id,
        thesisId,
        actionFingerprint,
        stage: "PROPOSED",
        thesisState: "VALID",
        actionType: "HOLD",
        policyVersion: "phase7-bounded-management-v1",
        validationPassed: true,
        evaluation: { test: true },
        action: { fingerprint: actionFingerprint },
        validation: { valid: true },
        observedAt: now,
      });
    } catch {
      duplicateActionRefused = true;
    }
    expect("database refuses a duplicate Phase 7 action-stage claim", duplicateActionRefused);

    let inconsistentOwnerRefused = false;
    try {
      await db.insert(tradesTable).values({
        userId: user!.id,
        section: "crypto",
        symbol: "ETHUSDT",
        side: "buy",
        entryPrice: "100",
        quantity: "1",
        confidence: "75",
        stopLoss: "98",
        takeProfit: "104",
        managementAuthority: "fixed",
        managementMode: "phase7_active",
      });
    } catch {
      inconsistentOwnerRefused = true;
    }
    expect("database refuses inconsistent fixed/Phase 7 ownership", inconsistentOwnerRefused);

    await db.execute(sql`SELECT capture.purge_user_data(${user!.id})`);
    const remainingDecisions = await db.select({ id: brainDecisionsTable.id })
      .from(brainDecisionsTable).where(eq(brainDecisionsTable.userId, user!.id));
    const remainingEvidence = await db.select({ id: brainEvidenceReferencesTable.id })
      .from(brainEvidenceReferencesTable).where(eq(brainEvidenceReferencesTable.brainDecisionId, decision!.id));
    const remainingTheses = await db.select({ id: positionThesesTable.id })
      .from(positionThesesTable).where(eq(positionThesesTable.userId, user!.id));
    const remainingManagementEvents = await db.select({ id: positionManagementEventsTable.id })
      .from(positionManagementEventsTable).where(eq(positionManagementEventsTable.userId, user!.id));
    const remainingResearchEvents = await db.select({ id: researchReplayEventsTable.id })
      .from(researchReplayEventsTable).where(eq(researchReplayEventsTable.userId, user!.id));
    expect("capture purge removes the user's decision", remainingDecisions.length === 0);
    expect("capture purge removes dependent evidence first", remainingEvidence.length === 0);
    expect("capture purge removes Phase 7 management events", remainingManagementEvents.length === 0);
    expect("capture purge removes Phase 7 theses", remainingTheses.length === 0);
    expect("capture purge removes Phase 8 replay events", remainingResearchEvents.length === 0);
    await db.delete(researchExperimentsTable).where(eq(researchExperimentsTable.id, researchExperiment!.id));
    await db.delete(tradesTable).where(eq(tradesTable.id, trade!.id));
  } finally {
    await db.execute(sql`SELECT capture.purge_user_data(${user!.id})`);
    await db.delete(tradesTable).where(eq(tradesTable.userId, user!.id));
    await db.delete(researchExperimentsTable).where(eq(researchExperimentsTable.userId, user!.id));
    await db.delete(usersTable).where(eq(usersTable.id, user!.id));
  }

  console.log(failures === 0 ? "\nschema-security: all checks passed" : `\nschema-security: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
