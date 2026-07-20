import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { db } from "@workspace/db";
import { usersTable, userIdentitiesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createSessionToken, getAuthenticatedUserId, SESSION_COOKIE_NAME } from "../middleware/auth";
import { hashPassword, verifyPassword } from "../lib/passwordHash";
import { validateEnv } from "../lib/env";
import {
  googleEnabled, appleEnabled, googleAuthUrl, appleAuthUrl,
  exchangeGoogleCode, exchangeAppleCode, type OAuthIdentity,
} from "../lib/oauth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const MIN_PASSWORD_LENGTH = 12;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 64;

// A fixed, well-formed-but-never-matching salt:key pair (16-byte salt,
// 64-byte key — see passwordHash.ts's KEY_LENGTH) so a login attempt for a
// nonexistent username still pays the same scrypt cost as a real one —
// otherwise "no such user" would return near-instantly while a wrong
// password for a real user takes scrypt's full derivation time, leaking
// which usernames exist via response timing.
const DUMMY_HASH = `${"0".repeat(32)}:${"0".repeat(128)}`;

function setSessionCookie(res: Response, userId: number): void {
  const { nodeEnv } = validateEnv();
  const sessionToken = createSessionToken(userId);
  res.cookie(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: nodeEnv === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 12 * 60 * 60 * 1000, // 12h — must match SESSION_DURATION_MS in middleware/auth.ts
  });
}

// ---------------------------------------------------------------------------
// POST /auth/register — body { username: string, password: string }.
// Multi-user Phase: anyone can create their own account — each account only
// ever risks its own Binance credentials/funds (see middleware/auth.ts), so
// open registration doesn't expand another user's blast radius. On success,
// behaves exactly like login: sets the signed session cookie immediately.
// ---------------------------------------------------------------------------
router.post("/auth/register", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH) {
    res.status(400).json({ error: `Username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters` });
    return;
  }
  if (!/^[a-zA-Z0-9_.\- ]+$/.test(username)) {
    res.status(400).json({ error: "Username may only contain letters, numbers, spaces, and _ . -" });
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (existing) {
    res.status(409).json({ error: "Username already taken" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const [user] = await db.insert(usersTable).values({ username, passwordHash }).returning();

  logger.info({ userId: user!.id, ip: req.ip }, "AUTH_REGISTER_SUCCESS");
  setSessionCookie(res, user!.id);
  res.status(201).json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /auth/login — body { username: string, password: string }. On
// success, sets a signed HttpOnly session cookie. Deliberately NOT mounted
// behind requireAuth (that would make login impossible). Mounted behind a
// strict rate limiter in app.ts instead — this is the one unauthenticated
// endpoint that's a meaningful brute-force target.
// ---------------------------------------------------------------------------
router.post("/auth/login", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";

  const [user] = username ? await db.select().from(usersTable).where(eq(usersTable.username, username)) : [];

  // Always run verifyPassword, even with no matching user, against a fixed
  // dummy hash — so a nonexistent username can't be distinguished from a
  // wrong password by response timing (scrypt's cost dominates either way).
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !passwordOk) {
    logger.warn({ ip: req.ip }, "AUTH_LOGIN_FAILED");
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  logger.info({ userId: user.id, ip: req.ip }, "AUTH_LOGIN_SUCCESS");
  setSessionCookie(res, user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /auth/demo — one-click, no-signup entry into the shared READ-ONLY demo
// account (users.isDemo). Sets the same signed session cookie as a real login;
// the demo user can view the fully-seeded product but every state-changing
// request is rejected server-side (middleware/demoGuard.ts), and it holds no
// exchange credentials, so it can never place an order. Returns 404 when no
// demo account has been seeded (scripts/seedDemo.ts) so the frontend can hide
// the button gracefully.
// ---------------------------------------------------------------------------
router.post("/auth/demo", async (req, res) => {
  const [demo] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.isDemo, true))
    .limit(1);
  if (!demo) {
    res.status(404).json({ error: "No demo account is available." });
    return;
  }
  logger.info({ userId: demo.id, ip: req.ip }, "AUTH_DEMO_LOGIN");
  setSessionCookie(res, demo.id);
  res.json({ ok: true });
});

router.post("/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

/** Lets the frontend silently check auth state without eating a 401 (and
 *  without the global rate limiter treating routine polling as abuse). */
router.get("/auth/status", async (req, res) => {
  const userId = await getAuthenticatedUserId(req);
  res.json({ authenticated: userId !== null });
});

// ═════════════════════════════════════════════════════════════════════════════
// Social sign-in (Google / Apple) — server-side authorization-code flow.
// Providers are OPTIONAL: each activates only when its env vars are set (see
// lib/oauth.ts for setup); the frontend calls /auth/providers to know which
// buttons to render. CSRF protection: a random state value is set as a
// short-lived signed-origin cookie before redirecting out, and must round-trip
// exactly on the callback.
// ═════════════════════════════════════════════════════════════════════════════

const OAUTH_STATE_COOKIE = "tradecore_oauth_state";

function setOauthStateCookie(res: Response, state: string): void {
  const { nodeEnv } = validateEnv();
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: nodeEnv === "production",
    // Apple's form_post callback is a cross-site POST — "none" (with secure)
    // is required for the cookie to accompany it. Google's GET redirect works
    // under "lax", but one setting must serve both; "none" requires HTTPS,
    // which production always is. Dev (http) falls back to lax + insecure.
    sameSite: nodeEnv === "production" ? "none" : "lax",
    path: "/",
    maxAge: 10 * 60 * 1000,
  });
}

/** Which social sign-in buttons the login page should render, and whether a
 *  one-click demo account exists to offer an "Explore the live demo" button. */
router.get("/auth/providers", async (_req, res) => {
  const [demo] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.isDemo, true))
    .limit(1);
  res.json({ google: googleEnabled(), apple: appleEnabled(), demo: !!demo });
});

/**
 * Resolve an OAuth identity to a local user id, creating the account on first
 * sign-in. Keyed on the provider's stable subject id (never email). New
 * accounts get a unique username derived from the email/name and NO password —
 * they can add one later on the Account page.
 */
async function findOrCreateOauthUser(identity: OAuthIdentity): Promise<number> {
  const [existing] = await db
    .select()
    .from(userIdentitiesTable)
    .where(and(
      eq(userIdentitiesTable.provider, identity.provider),
      eq(userIdentitiesTable.providerUserId, identity.providerUserId),
    ));
  if (existing) return existing.userId;

  const base = (identity.email?.split("@")[0] ?? identity.displayName ?? identity.provider)
    .replace(/[^a-zA-Z0-9_.\- ]/g, "")
    .slice(0, 48) || identity.provider;
  let username = base;
  for (let i = 2; ; i++) {
    const [taken] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username));
    if (!taken) break;
    username = `${base}${i}`;
  }

  const [user] = await db
    .insert(usersTable)
    .values({
      username,
      passwordHash: null,
      email: identity.email,
      displayName: identity.displayName,
    })
    .returning();
  await db.insert(userIdentitiesTable).values({
    userId: user!.id,
    provider: identity.provider,
    providerUserId: identity.providerUserId,
    email: identity.email,
  });
  logger.info({ userId: user!.id, provider: identity.provider }, "AUTH_OAUTH_ACCOUNT_CREATED");
  return user!.id;
}

/** Where the dashboard SPA is served from, in lock-step with BASE_PATH (see
 *  app.ts). OAuth callbacks must land the user inside the app, not on the
 *  public landing page that owns "/" when the app is mounted under a sub-path. */
function appBasePath(): string {
  const raw = (process.env["BASE_PATH"] ?? "/").trim();
  if (raw === "/" || raw === "") return "/";
  return `/${raw.replace(/^\/+|\/+$/g, "")}/`;
}

/** Shared callback tail: verify state, resolve the user, set the session
 *  cookie, and redirect into the app (the SPA re-checks /auth/status). */
async function completeOauthLogin(
  req: Request,
  res: Response,
  provider: "google" | "apple",
  code: unknown,
  state: unknown,
): Promise<void> {
  const cookieState = (req.cookies as Record<string, string> | undefined)?.[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });
  if (typeof code !== "string" || !code || typeof state !== "string" || !state || state !== cookieState) {
    logger.warn({ provider, ip: req.ip, hasCookie: !!cookieState }, "AUTH_OAUTH_STATE_MISMATCH");
    res.redirect(`${appBasePath()}?auth_error=oauth_state`);
    return;
  }
  try {
    const identity = provider === "google" ? await exchangeGoogleCode(code) : await exchangeAppleCode(code);
    const userId = await findOrCreateOauthUser(identity);
    logger.info({ userId, provider, ip: req.ip }, "AUTH_OAUTH_LOGIN_SUCCESS");
    setSessionCookie(res, userId);
    res.redirect(appBasePath());
  } catch (err) {
    logger.error({ err, provider }, "AUTH_OAUTH_LOGIN_FAILED");
    res.redirect(`${appBasePath()}?auth_error=oauth_failed`);
  }
}

router.get("/auth/google", (_req, res) => {
  if (!googleEnabled()) { res.status(404).json({ error: "Google sign-in is not configured" }); return; }
  const state = randomBytes(16).toString("hex");
  setOauthStateCookie(res, state);
  res.redirect(googleAuthUrl(state));
});

router.get("/auth/google/callback", async (req, res) => {
  if (!googleEnabled()) { res.status(404).json({ error: "Google sign-in is not configured" }); return; }
  await completeOauthLogin(req, res, "google", req.query.code, req.query.state);
});

router.get("/auth/apple", (_req, res) => {
  if (!appleEnabled()) { res.status(404).json({ error: "Apple sign-in is not configured" }); return; }
  const state = randomBytes(16).toString("hex");
  setOauthStateCookie(res, state);
  res.redirect(appleAuthUrl(state));
});

// Apple delivers the callback as a form POST (response_mode=form_post) —
// express.urlencoded is mounted globally in app.ts, so req.body has the params.
router.post("/auth/apple/callback", async (req, res) => {
  if (!appleEnabled()) { res.status(404).json({ error: "Apple sign-in is not configured" }); return; }
  const body = req.body as Record<string, unknown>;
  await completeOauthLogin(req, res, "apple", body.code, body.state);
});

export default router;
