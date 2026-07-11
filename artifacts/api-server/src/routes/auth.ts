import { Router, type IRouter } from "express";
import { validateEnv } from "../lib/env";
import { createSessionToken, isAuthenticated, timingSafeStringEqual, SESSION_COOKIE_NAME } from "../middleware/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /auth/login — body { username: string, password: string } — the
// shared OPERATOR_USERNAME/OPERATOR_PASSWORD. On success, sets a signed
// HttpOnly session cookie. Deliberately NOT mounted behind requireAuth (that
// would make login impossible). Mounted behind a strict rate limiter in
// app.ts instead — this is the one unauthenticated endpoint that's a
// meaningful brute-force target.
// ---------------------------------------------------------------------------
router.post("/auth/login", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const { operatorUsername, operatorPassword, nodeEnv } = validateEnv();

  // Both comparisons run unconditionally so a wrong username can't be
  // distinguished from a wrong password by timing.
  const usernameOk = !!username && timingSafeStringEqual(username, operatorUsername);
  const passwordOk = !!password && timingSafeStringEqual(password, operatorPassword);

  if (!usernameOk || !passwordOk) {
    logger.warn({ ip: req.ip }, "AUTH_LOGIN_FAILED");
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const sessionToken = createSessionToken();
  res.cookie(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: nodeEnv === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 12 * 60 * 60 * 1000, // 12h — must match SESSION_DURATION_MS in middleware/auth.ts
  });

  logger.info({ ip: req.ip }, "AUTH_LOGIN_SUCCESS");
  res.json({ ok: true });
});

router.post("/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

/** Lets the frontend silently check auth state without eating a 401 (and
 *  without the global rate limiter treating routine polling as abuse). */
router.get("/auth/status", (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

export default router;
