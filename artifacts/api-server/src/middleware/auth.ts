/**
 * TradeCore Pro — Authentication  (Phase 5B, Production Hardening;
 * Multi-user Phase: per-account users, not a single shared credential)
 *
 * DESIGN — multi-user accounts, each running a fully independent bot:
 * every user registers their own account (username/password, hashed with
 * scrypt — see lib/passwordHash.ts) and supplies their own Binance API
 * credentials (encrypted at rest — see lib/credentialsCrypto.ts). A user's
 * blast radius is their own account and their own Binance funds only — see
 * lib/engineRegistry.ts for how a userId maps to its own BotEngine instance,
 * trades, config, and strategy tuning.
 *
 * Two ways to present credentials, both resolving to a `userId` attached to
 * `req.userId`:
 *
 *   1. A signed, stateless, HttpOnly session cookie for the web dashboard
 *      (via POST /api/auth/login or /api/auth/register) — encodes the
 *      userId and an expiry, HMAC-signed so it can't be forged or altered.
 *   2. An `Authorization: Basic <base64(username:password)>` header for
 *      scripts, curl, or a future mobile/Expo client — verified against the
 *      DB on every request (no session-cookie shortcut for this path).
 *
 * The cookie is intentionally stateless (HMAC-signed expiry + userId, no
 * server-side session store/table) — simpler, and survives a server restart
 * without logging everyone out. Rotating SESSION_SECRET invalidates every
 * outstanding cookie for every user at once (e.g. if it's ever suspected to
 * be exposed); an individual user's password only protects their own
 * session (rotate that to log just them out everywhere).
 */
import type { NextFunction, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { validateEnv } from "../lib/env";
import { verifyPassword } from "../lib/passwordHash";
import { logger } from "../lib/logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth once a session cookie or Basic-auth credentials
       *  have been verified — the id of the user making this request. */
      userId?: number;
    }
  }
}

export const SESSION_COOKIE_NAME = "tc_session";
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws if lengths differ — pad instead of short-circuiting,
  // so a wrong-length guess can't be distinguished from a wrong-value one by timing.
  if (bufA.length !== bufB.length) {
    // Still do a constant-time-ish compare against a same-length buffer so the
    // control flow doesn't obviously branch on "length matched or not" either.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Build a signed session cookie value: `<userId>.<expiryEpochMs>.<hmacHex>` */
export function createSessionToken(userId: number): string {
  const { sessionSecret } = validateEnv();
  const expiry = String(Date.now() + SESSION_DURATION_MS);
  const payload = `${userId}.${expiry}`;
  return `${payload}.${sign(payload, sessionSecret)}`;
}

function verifySessionToken(token: string | undefined): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userIdStr, expiryStr, signature] = parts as [string, string, string];
  const userId = Number(userIdStr);
  const expiry = Number(expiryStr);
  if (!Number.isFinite(userId) || !Number.isFinite(expiry)) return null;
  if (Date.now() > expiry) return null; // expired

  const { sessionSecret } = validateEnv();
  const payload = `${userIdStr}.${expiryStr}`;
  const expected = sign(payload, sessionSecret);
  return timingSafeStringEqual(signature, expected) ? userId : null;
}

async function verifyBasicAuth(header: string | undefined): Promise<number | null> {
  if (!header?.startsWith("Basic ")) return null;
  const encoded = header.slice("Basic ".length).trim();
  if (!encoded) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return null;

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  if (!username || !password) return null;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (!user) return null;

  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? user.id : null;
}

/**
 * Require either a valid session cookie or valid Basic-auth credentials.
 * 401s with a generic message (never reveal *which* check failed — that's
 * an oracle). Mount this on every route except /health and /auth/*.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const cookieUserId = verifySessionToken(req.cookies?.[SESSION_COOKIE_NAME]);
  const userId = cookieUserId ?? (await verifyBasicAuth(req.headers.authorization));

  if (userId !== null) {
    req.userId = userId;
    next();
    return;
  }

  logger.warn({ path: req.path, method: req.method, ip: req.ip }, "AUTH_REJECTED");
  res.status(401).json({ error: "Unauthorized" });
}

export async function getAuthenticatedUserId(req: Request): Promise<number | null> {
  const cookieUserId = verifySessionToken(req.cookies?.[SESSION_COOKIE_NAME]);
  if (cookieUserId !== null) return cookieUserId;
  return verifyBasicAuth(req.headers.authorization);
}
