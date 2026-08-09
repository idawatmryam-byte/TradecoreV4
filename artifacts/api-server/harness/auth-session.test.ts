/**
 * Session revocation integration checks.
 *
 * A valid HMAC alone is insufficient: password changes and account deletion
 * must invalidate outstanding cookies for that user immediately.
 */
if (!process.env.DATABASE_URL) {
  console.log("auth-session test SKIPPED (no DATABASE_URL)");
  process.exit(0);
}
process.env.SESSION_SECRET ??= "auth-session-integration-secret-123";
process.env.CREDENTIALS_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.PORT ??= "8080";

import type { Request } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  createSessionToken,
  getAuthenticatedUserId,
  SESSION_COOKIE_NAME,
} from "../src/middleware/auth";

const USERNAME = "auth_session_harness_990071";
let failures = 0;

function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(`${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`);
}

function requestFor(token: string): Request {
  return { cookies: { [SESSION_COOKIE_NAME]: token }, headers: {} } as Request;
}

async function main() {
  await db.delete(usersTable).where(eq(usersTable.username, USERNAME));
  const [user] = await db.insert(usersTable).values({ username: USERNAME }).returning();
  try {
    const original = createSessionToken(user!.id, user!.sessionVersion);
    expect("a fresh versioned session authenticates",
      (await getAuthenticatedUserId(requestFor(original))) === user!.id);

    const [rotated] = await db.update(usersTable)
      .set({ sessionVersion: sql`${usersTable.sessionVersion} + 1` })
      .where(eq(usersTable.id, user!.id))
      .returning();
    expect("password/session rotation revokes the old cookie",
      (await getAuthenticatedUserId(requestFor(original))) === null);

    const replacement = createSessionToken(rotated!.id, rotated!.sessionVersion);
    expect("the replacement version authenticates",
      (await getAuthenticatedUserId(requestFor(replacement))) === user!.id);

    await db.delete(usersTable).where(eq(usersTable.id, user!.id));
    expect("account deletion invalidates an otherwise unexpired cookie",
      (await getAuthenticatedUserId(requestFor(replacement))) === null);
  } finally {
    await db.delete(usersTable).where(eq(usersTable.username, USERNAME));
  }

  console.log(failures === 0 ? "\nauth-session: all checks passed" : `\nauth-session: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
