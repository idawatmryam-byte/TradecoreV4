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
  autopsyRunsTable, customStrategiesTable, strategyDecisionsTable,
  recommendationsTable, recommendationEventsTable, notificationsTable, executionIntentsTable,
  executionEventsTable, scanCountersTable, memoryValidationsTable,
  evidenceRuleSetsTable, capturedDecisionsTable, memoryInfluencesTable,
  evidenceSnapshotsTable, evidenceRuleEventsTable, strategyOpinionsTable,
  shadowCouncilRunsTable, brainDecisionsTable, brainEvidenceReferencesTable,
  positionManagementEventsTable, positionThesesTable,
  researchExperimentsTable, researchReplayEventsTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "../lib/passwordHash";
import { evictUserEngines, getOrCreateEngine, SECTIONS } from "../lib/engineRegistry";
import { setSessionCookie, SESSION_COOKIE_NAME } from "../middleware/auth";
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

  const [updated] = await db
    .update(usersTable)
    .set({
      passwordHash: await hashPassword(newPassword),
      sessionVersion: sql`${usersTable.sessionVersion} + 1`,
    })
    .where(eq(usersTable.id, req.userId!))
    .returning({ id: usersTable.id, sessionVersion: usersTable.sessionVersion });
  if (!updated) { res.status(404).json({ error: "Account not found" }); return; }
  // Revoke every previously-issued cookie, then issue one fresh cookie for
  // the password-change request itself so the user is not logged out here.
  setSessionCookie(res, updated);
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
      logger.error({ err, userId: req.userId, section }, "Engine stop during account deletion failed — deletion aborted");
      res.status(503).json({ error: "Account deletion could not safely stop every trading engine. No account data was deleted; try again after checking engine health." });
      return;
    }
  }

  const userId = req.userId!;
  const functionLookup = await db.execute(sql`SELECT to_regprocedure('capture.purge_user_data(integer)')::text AS name`);
  const functionRows = (functionLookup as unknown as { rows?: Array<{ name: string | null }> }).rows ?? [];
  const hasHardenedCapturePurge = functionRows[0]?.name != null;

  // Account erasure is all-or-nothing. The previous sequence omitted Phase
  // 0–6 intelligence, execution, recommendation and learning records and ran
  // outside a transaction, leaving orphaned personal data after a partial
  // failure. Child rows are removed first; backtest children cascade.
  await db.transaction(async (tx) => {
    const tradeIds = (await tx.select({ id: tradesTable.id }).from(tradesTable).where(eq(tradesTable.userId, userId)))
      .map((t) => t.id);
    if (tradeIds.length > 0) {
      await tx.delete(tradePartialExitsTable).where(inArray(tradePartialExitsTable.tradeId, tradeIds));
    }

    if (hasHardenedCapturePurge) {
      // Production's capture schema is INSERT/SELECT-only. This narrowly
      // scoped SECURITY DEFINER function is installed by capture-grants.sql
      // so account erasure works without weakening append-only privileges.
      await tx.execute(sql`SELECT capture.purge_user_data(${userId})`);
    } else {
      // Development/test databases usually connect as the owner and do not
      // install the grants script. Purge the same rows directly there.
      const intentIds = (await tx.select({ id: executionIntentsTable.id }).from(executionIntentsTable)
        .where(eq(executionIntentsTable.userId, userId))).map((row) => row.id);
      if (intentIds.length > 0) {
        await tx.delete(executionEventsTable).where(inArray(executionEventsTable.intentId, intentIds));
      }
      await tx.delete(recommendationEventsTable).where(eq(recommendationEventsTable.userId, userId));
      const brainIds = (await tx.select({ id: brainDecisionsTable.id }).from(brainDecisionsTable)
        .where(eq(brainDecisionsTable.userId, userId))).map((row) => row.id);
      if (brainIds.length > 0) {
        await tx.delete(brainEvidenceReferencesTable).where(inArray(brainEvidenceReferencesTable.brainDecisionId, brainIds));
      }
      await tx.delete(positionManagementEventsTable).where(eq(positionManagementEventsTable.userId, userId));
      await tx.delete(positionThesesTable).where(eq(positionThesesTable.userId, userId));
      await tx.delete(researchReplayEventsTable).where(eq(researchReplayEventsTable.userId, userId));
      await tx.delete(shadowCouncilRunsTable).where(eq(shadowCouncilRunsTable.userId, userId));
      await tx.delete(brainDecisionsTable).where(eq(brainDecisionsTable.userId, userId));
      await tx.delete(strategyOpinionsTable).where(eq(strategyOpinionsTable.userId, userId));
      await tx.delete(evidenceRuleEventsTable).where(eq(evidenceRuleEventsTable.userId, userId));
      await tx.delete(evidenceSnapshotsTable).where(eq(evidenceSnapshotsTable.userId, userId));
      await tx.delete(memoryInfluencesTable).where(eq(memoryInfluencesTable.userId, userId));
      await tx.delete(capturedDecisionsTable).where(eq(capturedDecisionsTable.userId, userId));
    }

    await tx.delete(executionIntentsTable).where(eq(executionIntentsTable.userId, userId));
    await tx.delete(recommendationsTable).where(eq(recommendationsTable.userId, userId));
    await tx.delete(notificationsTable).where(eq(notificationsTable.userId, userId));
    await tx.delete(evidenceRuleSetsTable).where(eq(evidenceRuleSetsTable.userId, userId));
    await tx.delete(memoryValidationsTable).where(eq(memoryValidationsTable.userId, userId));
    await tx.delete(scanCountersTable).where(eq(scanCountersTable.userId, userId));
    await tx.delete(autopsyRunsTable).where(eq(autopsyRunsTable.userId, userId));
    await tx.delete(researchExperimentsTable).where(eq(researchExperimentsTable.userId, userId));
    await tx.delete(customStrategiesTable).where(eq(customStrategiesTable.userId, userId));
    await tx.delete(strategyDecisionsTable).where(eq(strategyDecisionsTable.userId, userId));
    await tx.delete(tradeAnalysesTable).where(eq(tradeAnalysesTable.userId, userId));
    await tx.delete(tradesTable).where(eq(tradesTable.userId, userId));
    await tx.delete(blacklistTable).where(eq(blacklistTable.userId, userId));
    await tx.delete(hourlyStatsTable).where(eq(hourlyStatsTable.userId, userId));
    await tx.delete(strategyConfigsTable).where(eq(strategyConfigsTable.userId, userId));
    await tx.delete(botConfigTable).where(eq(botConfigTable.userId, userId));
    await tx.delete(backtestRunsTable).where(eq(backtestRunsTable.userId, userId));
    await tx.delete(userBinanceCredentialsTable).where(eq(userBinanceCredentialsTable.userId, userId));
    await tx.delete(userOandaCredentialsTable).where(eq(userOandaCredentialsTable.userId, userId));
    await tx.delete(userIdentitiesTable).where(eq(userIdentitiesTable.userId, userId));
    await tx.delete(usersTable).where(eq(usersTable.id, userId));
  });

  evictUserEngines(userId);
  logger.info({ userId, ip: req.ip }, "ACCOUNT_DELETED");
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

export default router;
