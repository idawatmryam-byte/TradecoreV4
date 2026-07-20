/**
 * Account manager API (mounted behind requireAuth).
 *
 *   GET    /me/account           — profile: username, email, display name,
 *                                  member-since, hasPassword, linked providers
 *   PUT    /me/account           — update display name / email
 *   POST   /me/account/password  — set or change password (current required
 *                                  when one exists; OAuth-only accounts set
 *                                  their first password without one)
 *   DELETE /me/account           — permanent, full-account deletion: stops the
 *                                  bot engine, removes every row the user owns
 *                                  across all tables, clears the session.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  usersTable, userIdentitiesTable, userBinanceCredentialsTable,
  userOandaCredentialsTable,
  botConfigTable, strategyConfigsTable, tradesTable, tradePartialExitsTable,
  blacklistTable, hourlyStatsTable, tradeAnalysesTable, backtestRunsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { hashPassword, verifyPassword } from "../lib/passwordHash";
import { getOrCreateEngine, SECTIONS } from "../lib/engineRegistry";
import { SESSION_COOKIE_NAME } from "../middleware/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const MIN_PASSWORD_LENGTH = 12;

router.get("/me/account", async (req, res) => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!));
  if (!user) { res.status(404).json({ error: "Account not found" }); return; }
  const identities = await db
    .select({ provider: userIdentitiesTable.provider, email: userIdentitiesTable.email })
    .from(userIdentitiesTable)
    .where(eq(userIdentitiesTable.userId, req.userId!));
  res.json({
    id: user.id,
    username: user.username,
    email: user.email ?? null,
    displayName: user.displayName ?? null,
    createdAt: user.createdAt,
    hasPassword: user.passwordHash != null,
    isDemo: user.isDemo,
    providers: identities.map((i) => ({ provider: i.provider, email: i.email ?? null })),
  });
});

router.put("/me/account", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 64) : undefined;
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 128) : undefined;
  if (email !== undefined && email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }
  await db
    .update(usersTable)
    .set({
      ...(displayName !== undefined && { displayName: displayName || null }),
      ...(email !== undefined && { email: email || null }),
    })
    .where(eq(usersTable.id, req.userId!));
  res.json({ ok: true });
});

router.post("/me/account/password", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!));
  if (!user) { res.status(404).json({ error: "Account not found" }); return; }

  // An account that already has a password must prove it before changing it.
  // OAuth-only accounts (passwordHash null) are setting their FIRST password —
  // they're already authenticated via the provider session, nothing to prove.
  if (user.passwordHash != null) {
    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) {
      logger.warn({ userId: req.userId, ip: req.ip }, "ACCOUNT_PASSWORD_CHANGE_BAD_CURRENT");
      res.status(403).json({ error: "Current password is incorrect" });
      return;
    }
  }

  await db.update(usersTable).set({ passwordHash: await hashPassword(newPassword) }).where(eq(usersTable.id, req.userId!));
  logger.info({ userId: req.userId }, "ACCOUNT_PASSWORD_CHANGED");
  res.json({ ok: true });
});

router.delete("/me/account", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const confirm = typeof body.confirm === "string" ? body.confirm : "";
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!));
  if (!user) { res.status(404).json({ error: "Account not found" }); return; }
  // Deliberate friction on an irreversible action: the exact username must be typed.
  if (confirm !== user.username) {
    res.status(400).json({ error: "Type your username exactly to confirm deletion" });
    return;
  }

  // Stop ALL of the user's engines first (both crypto and forex sections) so
  // nothing writes new rows mid-delete and no open position keeps trading for
  // a deleted account.
  for (const section of SECTIONS) {
    try {
      await getOrCreateEngine(req.userId!, section).stop();
    } catch (err) {
      logger.warn({ err, userId: req.userId, section }, "Engine stop during account deletion failed — continuing with delete");
    }
  }

  const userId = req.userId!;
  // Children without their own userId column first (via the parent's ids),
  // then everything keyed on userId. Backtest child tables cascade from runs.
  const tradeIds = (await db.select({ id: tradesTable.id }).from(tradesTable).where(eq(tradesTable.userId, userId)))
    .map((t) => t.id);
  if (tradeIds.length > 0) {
    await db.delete(tradePartialExitsTable).where(inArray(tradePartialExitsTable.tradeId, tradeIds));
  }
  await db.delete(tradeAnalysesTable).where(eq(tradeAnalysesTable.userId, userId));
  await db.delete(tradesTable).where(eq(tradesTable.userId, userId));
  await db.delete(blacklistTable).where(eq(blacklistTable.userId, userId));
  await db.delete(hourlyStatsTable).where(eq(hourlyStatsTable.userId, userId));
  await db.delete(strategyConfigsTable).where(eq(strategyConfigsTable.userId, userId));
  await db.delete(botConfigTable).where(eq(botConfigTable.userId, userId));
  await db.delete(backtestRunsTable).where(eq(backtestRunsTable.userId, userId)); // cascades trades/equity/optimization
  await db.delete(userBinanceCredentialsTable).where(eq(userBinanceCredentialsTable.userId, userId));
  await db.delete(userOandaCredentialsTable).where(eq(userOandaCredentialsTable.userId, userId));
  await db.delete(userIdentitiesTable).where(eq(userIdentitiesTable.userId, userId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));

  logger.info({ userId, ip: req.ip }, "ACCOUNT_DELETED");
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

export default router;
