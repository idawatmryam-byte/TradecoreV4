/** PostgreSQL-only verification for security-critical schema additions. */
if (!process.env.DATABASE_URL) {
  console.log("schema-security test SKIPPED (no DATABASE_URL)");
  process.exit(0);
}
process.env.SESSION_SECRET ??= "schema-security-integration-secret-123";
process.env.PORT ??= "8080";

import {
  brainDecisionsTable,
  brainEvidenceReferencesTable,
  db,
  usersTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const USERNAME = "schema_security_harness_990081";
let failures = 0;

function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(`${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`);
}

async function main() {
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

    await db.execute(sql`SELECT capture.purge_user_data(${user!.id})`);
    const remainingDecisions = await db.select({ id: brainDecisionsTable.id })
      .from(brainDecisionsTable).where(eq(brainDecisionsTable.userId, user!.id));
    const remainingEvidence = await db.select({ id: brainEvidenceReferencesTable.id })
      .from(brainEvidenceReferencesTable).where(eq(brainEvidenceReferencesTable.brainDecisionId, decision!.id));
    expect("capture purge removes the user's decision", remainingDecisions.length === 0);
    expect("capture purge removes dependent evidence first", remainingEvidence.length === 0);
  } finally {
    await db.execute(sql`SELECT capture.purge_user_data(${user!.id})`);
    await db.delete(usersTable).where(eq(usersTable.id, user!.id));
  }

  console.log(failures === 0 ? "\nschema-security: all checks passed" : `\nschema-security: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
