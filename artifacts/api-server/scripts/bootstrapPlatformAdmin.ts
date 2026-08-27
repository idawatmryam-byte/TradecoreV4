/**
 * Audited, out-of-band first-admin bootstrap.
 *
 * This is intentionally not an HTTP endpoint and refuses to run after any
 * active platform role exists. It grants no tenant financial role and never
 * touches broker credentials, mandates, execution state, or provider config.
 */
import { randomUUID } from "node:crypto";
import { count, eq, sql } from "drizzle-orm";

const migrationDatabaseUrl = (process.env["DATABASE_MIGRATION_URL"] ?? "").trim();
if (!migrationDatabaseUrl) {
  throw new Error(
    "DATABASE_MIGRATION_URL is required; the runtime DATABASE_URL is intentionally unable to grant platform roles",
  );
}
process.env["DATABASE_URL"] = migrationDatabaseUrl;

const {
  db,
  platformAccessVersionsTable,
  platformAuditEventsTable,
  platformRoleAssignmentsTable,
  pool,
  usersTable,
} = await import("@workspace/db");

const username = (process.env["PLATFORM_ADMIN_BOOTSTRAP_USERNAME"] ?? "").trim();
const reason = (process.env["PLATFORM_ADMIN_BOOTSTRAP_REASON"] ?? "").trim();

if (username.length < 3 || username.length > 64) {
  throw new Error(
    "PLATFORM_ADMIN_BOOTSTRAP_USERNAME must name one existing non-demo account",
  );
}
if (reason.length < 8 || reason.length > 500) {
  throw new Error(
    "PLATFORM_ADMIN_BOOTSTRAP_REASON must contain 8 to 500 characters",
  );
}

try {
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('cactus-platform-admin-bootstrap-v1'))`,
    );
    const [existing] = await tx
      .select({ count: count() })
      .from(platformRoleAssignmentsTable)
      .where(eq(platformRoleAssignmentsTable.status, "ACTIVE"));
    if ((existing?.count ?? 0) > 0) {
      throw new Error(
        "Bootstrap refused: an active platform role already exists; use a future reviewed role-administration workflow",
      );
    }

    const [user] = await tx
      .select({ id: usersTable.id, username: usersTable.username, isDemo: usersTable.isDemo })
      .from(usersTable)
      .where(eq(usersTable.username, username))
      .limit(1);
    if (!user || user.isDemo) {
      throw new Error("Bootstrap target must be one existing non-demo user");
    }

    await tx.insert(platformRoleAssignmentsTable).values({
      userId: user.id,
      role: "PLATFORM_ADMIN",
      status: "ACTIVE",
      grantedByUserId: null,
      reason,
    });
    await tx
      .insert(platformAccessVersionsTable)
      .values({ userId: user.id, version: 1 })
      .onConflictDoUpdate({
        target: platformAccessVersionsTable.userId,
        set: { version: sql`${platformAccessVersionsTable.version} + 1` },
      });
    const requestId = `bootstrap:${randomUUID()}`;
    await tx.insert(platformAuditEventsTable).values({
      actorUserId: null,
      permission: "admin.bootstrap",
      action: "BOOTSTRAP_PLATFORM_ADMIN",
      targetType: "user",
      targetId: String(user.id),
      requestId,
      result: "SUCCEEDED",
      reason,
      metadata: { procedure: "out-of-band", role: "PLATFORM_ADMIN" },
    });
    return { userId: user.id, username: user.username, requestId };
  });
  process.stdout.write(
    `Platform administrator bootstrapped for ${result.username} (user ${result.userId}); audit ${result.requestId}.\n`,
  );
} finally {
  await pool.end();
}
