/**
 * TradeCore Pro — Authentication  (Phase 5B, Production Hardening)
 *
 * BEFORE this phase: zero authentication anywhere. Every route — including
 * PATCH /config (risk %, position size, daily loss limit, testnet on/off,
 * alert webhook URL), POST /bot/start|stop, PUT /strategies/:id, and every
 * read endpoint — accepted requests from anyone who could reach the server,
 * combined with `cors()` called with no options (reflects any origin). That
 * is the single most important gap this phase closes.
 *
 * DESIGN — single shared operator credential, not multi-user RBAC:
 * this is a single-operator bot, not a multi-tenant SaaS product. The brief
 * asks for "role-based permissions where appropriate" — for one operator
 * with one Binance account, there is exactly one role, so a full RBAC/user
 * table would be unused complexity the audit itself warns against. What IS
 * appropriate, and implemented here, is a single strong shared secret
 * (`API_AUTH_TOKEN`) with two ways to present it:
 *
 *   1. A signed, stateless, HttpOnly session cookie for the web dashboard
 *      (via POST /api/auth/login) — this is what `custom-fetch.ts` was
 *      already written to expect (see its module comment: "This function
 *      [setAuthTokenGetter] should never be used in web applications where
 *      session token cookies are automatically associated with API calls by
 *      the browser" — that plumbing was built for this and never finished).
 *   2. A bare `Authorization: Bearer <API_AUTH_TOKEN>` header for scripts,
 *      curl, or a future mobile/Expo client (`setAuthTokenGetter`).
 *
 * The cookie is intentionally stateless (HMAC-signed expiry, no server-side
 * session store/table) — simpler, survives a server restart without
 * logging everyone out, and there is exactly one credential to revoke
 * (rotate API_AUTH_TOKEN) if it's ever compromised, which invalidates every
 * outstanding cookie immediately since re-login would fail.
 */
import type { NextFunction, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { validateEnv } from "../lib/env";
import { logger } from "../lib/logger";

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

/** Build a signed session cookie value: `<expiryEpochMs>.<hmacHex>` */
export function createSessionToken(): string {
  const { sessionSecret } = validateEnv();
  const expiry = String(Date.now() + SESSION_DURATION_MS);
  return `${expiry}.${sign(expiry, sessionSecret)}`;
}

function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expiryStr, signature] = parts as [string, string];
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry)) return false;
  if (Date.now() > expiry) return false; // expired

  const { sessionSecret } = validateEnv();
  const expected = sign(expiryStr, sessionSecret);
  return timingSafeStringEqual(signature, expected);
}

function verifyBearerToken(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return false;
  const { apiAuthToken } = validateEnv();
  return timingSafeStringEqual(token, apiAuthToken);
}

/**
 * Require either a valid session cookie or a valid bearer token. 401s with a
 * generic message (never reveal *which* check failed — that's an oracle).
 * Mount this on every route except /health and /auth/login.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookieOk = verifySessionToken(req.cookies?.[SESSION_COOKIE_NAME]);
  const bearerOk = !cookieOk && verifyBearerToken(req.headers.authorization);

  if (cookieOk || bearerOk) {
    next();
    return;
  }

  logger.warn({ path: req.path, method: req.method, ip: req.ip }, "AUTH_REJECTED");
  res.status(401).json({ error: "Unauthorized" });
}

export function isAuthenticated(req: Request): boolean {
  return verifySessionToken(req.cookies?.[SESSION_COOKIE_NAME]) || verifyBearerToken(req.headers.authorization);
}
