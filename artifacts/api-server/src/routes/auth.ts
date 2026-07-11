import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createSessionToken, getAuthenticatedUserId, SESSION_COOKIE_NAME } from "../middleware/auth";
import { hashPassword, verifyPassword } from "../lib/passwordHash";
import { validateEnv } from "../lib/env";
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

export default router;
