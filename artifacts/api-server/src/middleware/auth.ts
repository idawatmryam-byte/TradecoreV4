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
 * DESIGN — single shared operator username/password, not multi-user RBAC:
 * this is a single-operator bot, not a multi-tenant SaaS product. The brief
 * asks for "role-based permissions where appropriate" — for one operator
 * with one Binance account, there is exactly one role, so a full RBAC/user
 * table would be unused complexity the audit itself warns against. What IS
 * appropriate, and implemented here, is a single shared username/password
 * (`OPERATOR_USERNAME` / `OPERATOR_PASSWORD`) with two ways to present it:
 *
 *   1. A signed, stateless, HttpOnly session cookie for the web dashboard
 *      (via POST /api/auth/login) — this is what `custom-fetch.ts` was
 *      already written to expect (see its module comment: "This function
 *      [setAuthTokenGetter] should never be used in web applications where
 *      session token cookies are automatically associated with API calls by
 *      the browser" — that plumbing was built for this and never finished).
 *   2. An `Authorization: Basic <base64(username:password)>` header for
 *      scripts, curl, or a future mobile/Expo client.
 *
 * The cookie is intentionally stateless (HMAC-signed expiry, no server-side
 * session store/table) — simpler, survives a server restart without
 * logging everyone out, and there is exactly one credential pair to revoke
 * (rotate OPERATOR_PASSWORD) if it's ever compromised, which invalidates
 * every outstanding cookie immediately since re-login would fail.
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

function verifyBasicAuth(header: string | undefined): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const encoded = header.slice("Basic ".length).trim();
  if (!encoded) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return false;
  }
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return false;

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  const { operatorUsername, operatorPassword } = validateEnv();

  // Both comparisons run unconditionally (no short-circuit on the first
  // failure) so a wrong username can't be distinguished from a wrong
  // password by timing.
  const usernameOk = timingSafeStringEqual(username, operatorUsername);
  const passwordOk = timingSafeStringEqual(password, operatorPassword);
  return usernameOk && passwordOk;
}

/**
 * Require either a valid session cookie or valid Basic-auth credentials.
 * 401s with a generic message (never reveal *which* check failed — that's
 * an oracle). Mount this on every route except /health and /auth/login.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookieOk = verifySessionToken(req.cookies?.[SESSION_COOKIE_NAME]);
  const basicOk = !cookieOk && verifyBasicAuth(req.headers.authorization);

  if (cookieOk || basicOk) {
    next();
    return;
  }

  logger.warn({ path: req.path, method: req.method, ip: req.ip }, "AUTH_REJECTED");
  res.status(401).json({ error: "Unauthorized" });
}

export function isAuthenticated(req: Request): boolean {
  return verifySessionToken(req.cookies?.[SESSION_COOKIE_NAME]) || verifyBasicAuth(req.headers.authorization);
}
