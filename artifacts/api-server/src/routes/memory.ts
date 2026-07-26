import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { blacklistTable, botConfigTable, hourlyStatsTable } from "@workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  GetBlacklistResponse,
  GetToxicHoursResponse,
  GetMemoryInfluenceResponse,
  RunMemoryValidationResponse,
  UpdateMemoryInfluenceBody,
  UpdateMemoryInfluenceResponse,
} from "@workspace/api-zod";
import {
  invalidate, latestValidation, loadMemoryPermission, recentInfluences,
  revokeInfluence, runValidation,
} from "../lib/memory/memoryState";
import { summariseState } from "../lib/memory/influence";

const router: IRouter = Router();

router.get("/memory/blacklist", async (req, res): Promise<void> => {
  const now = new Date();
  const rows = await db
    .select()
    .from(blacklistTable)
    .where(and(eq(blacklistTable.userId, req.userId!), eq(blacklistTable.section, req.section!), gte(blacklistTable.expiresAt, now)));

  res.json(
    GetBlacklistResponse.parse(
      rows.map((r) => ({
        symbol: r.symbol,
        winRate: Number(r.winRate),
        tradeCount: r.tradeCount,
        blacklistedAt: r.blacklistedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      }))
    )
  );
});

router.get("/memory/toxic-hours", async (req, res): Promise<void> => {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;

  const rows = await db
    .select({
      hour: hourlyStatsTable.hour,
      cumulativePnl: sql<number>`sum(${hourlyStatsTable.pnl})`,
      tradeCount: sql<number>`sum(${hourlyStatsTable.tradeCount})`,
      blockedAt: sql<string>`min(${hourlyStatsTable.createdAt})`,
    })
    .from(hourlyStatsTable)
    .where(and(eq(hourlyStatsTable.userId, req.userId!), eq(hourlyStatsTable.section, req.section!), gte(hourlyStatsTable.date, threeDaysAgo)))
    .groupBy(hourlyStatsTable.hour)
    .having(sql`sum(${hourlyStatsTable.pnl}) < 0`);

  res.json(
    GetToxicHoursResponse.parse(
      rows.map((r) => ({
        hour: r.hour,
        cumulativePnl: Number(r.cumulativePnl),
        tradeCount: Number(r.tradeCount),
        blockedAt: new Date(r.blockedAt).toISOString(),
      }))
    )
  );
});

// ---------------------------------------------------------------------------
// P8 — gated memory influence
//
// The only endpoints in the product that can change how the engine trades, so
// each one is deliberately narrow: read the status, run a validation, or set
// the two knobs. Enabling is a config write plus a cache invalidation, and
// nothing here can grant live permission — only a passing walk-forward run
// does that, inside runValidation.
// ---------------------------------------------------------------------------

/** Status: what memory would do, whether it may, and what it has done. */
router.get("/memory/influence", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const section = req.section!;

  const [cfg] = await db
    .select({
      enabled: botConfigTable.memoryInfluenceEnabled,
      maxDelta: botConfigTable.memoryInfluenceMaxDelta,
      approvedVersion: botConfigTable.memoryInfluenceApprovedVersion,
    })
    .from(botConfigTable)
    .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)))
    .limit(1);

  const permission = await loadMemoryPermission(userId, section);
  const validation = await latestValidation(userId, section);
  const influences = await recentInfluences(userId, section, 50);

  res.json(GetMemoryInfluenceResponse.parse({
    enabled: cfg?.enabled ?? false,
    maxDelta: Number(cfg?.maxDelta ?? 10),
    approvedVersion: cfg?.approvedVersion ?? null,
    active: permission.state.enabled && permission.state.rules.length > 0,
    needsValidation: permission.needsValidation,
    executionTarget: permission.executionTarget,
    reason: permission.reason,
    summary: summariseState(permission.state),
    version: permission.state.version,
    rules: permission.state.rules,
    latestValidation: validation
      ? {
          id: validation.id,
          status: validation.status,
          verdict: validation.verdict,
          summary: validation.summary,
          stateVersion: validation.stateVersion,
          executionTarget: validation.executionTarget,
          trainTrades: validation.trainTrades,
          validationTrades: validation.validationTrades,
          withheld: validation.withheld,
          withheldPnlUsdt: validation.withheldPnlUsdt != null ? Number(validation.withheldPnlUsdt) : null,
          expectancyDelta: validation.expectancyDelta != null ? Number(validation.expectancyDelta) : null,
          createdAt: validation.createdAt.toISOString(),
        }
      : null,
    recent: influences.map((i) => ({
      id: i.id,
      symbol: i.symbol,
      strategyId: i.strategyId,
      admitted: i.admitted,
      confidence: Number(i.confidence),
      requiredConfidence: Number(i.requiredConfidence),
      delta: Number(i.delta),
      memoryVersion: i.memoryVersion,
      executionTarget: i.executionTarget,
      reason: i.reason,
      createdAt: i.createdAt.toISOString(),
    })),
  }));
});

/**
 * Run a walk-forward validation.
 *
 * Cells are fitted on an earlier window and tested on a later one they never
 * saw. On `improved` this writes the approved version, which is the only way
 * live influence is ever unlocked.
 */
router.post("/memory/influence/validate", async (req, res): Promise<void> => {
  const { result } = await runValidation(req.userId!, req.section!);
  res.json(RunMemoryValidationResponse.parse({
    verdict: result.verdict,
    summary: result.summary,
    stateVersion: result.state.version,
    trainTrades: result.trainTrades,
    validationTrades: result.validationTrades,
    withheld: result.withheld,
    withheldPnlUsdt: result.withheldPnlUsdt,
    expectancyDelta: result.expectancyDelta,
    baseline: result.baseline,
    withMemory: result.withMemory,
    rules: result.state.rules,
  }));
});

/**
 * Set the two knobs.
 *
 * Turning influence OFF goes through revokeInfluence, which also clears the
 * approved version and the cached state — the kill switch. The next scan is
 * already inert; there is nothing to restart. Changing maxDelta invalidates
 * the cache too, since the bound is part of what the state hashes.
 */
router.patch("/memory/influence", async (req, res): Promise<void> => {
  const body = UpdateMemoryInfluenceBody.parse(req.body);
  const userId = req.userId!;
  const section = req.section!;

  if (body.enabled === false) {
    await revokeInfluence(userId, section, "disabled from the UI");
  }

  const updates: Record<string, unknown> = {};
  if (body.enabled === true) updates.memoryInfluenceEnabled = true;
  if (body.maxDelta !== undefined) updates.memoryInfluenceMaxDelta = body.maxDelta.toFixed(2);

  if (Object.keys(updates).length > 0) {
    await db.update(botConfigTable).set(updates)
      .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)));
    invalidate(userId, section);
  }

  const permission = await loadMemoryPermission(userId, section);
  res.json(UpdateMemoryInfluenceResponse.parse({
    enabled: body.enabled ?? permission.requested,
    active: permission.state.enabled && permission.state.rules.length > 0,
    needsValidation: permission.needsValidation,
    version: permission.state.version,
    reason: permission.reason,
  }));
});

export default router;
