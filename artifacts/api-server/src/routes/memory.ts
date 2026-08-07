import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import { db, blacklistTable, botConfigTable, hourlyStatsTable } from "@workspace/db";
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
  EvidenceLifecycleError,
  PROMOTION_CONFIRMATION,
  ROLLBACK_CONFIRMATION,
  invalidate,
  latestValidation,
  loadMemoryPermission,
  promoteEvidenceVersion,
  recentInfluences,
  revokeInfluence,
  rollbackEvidenceVersion,
  runValidation,
  suspendEvidenceVersion,
} from "../lib/memory/memoryState";
import { summariseState } from "../lib/memory/influence";
import { evidenceOverview } from "../lib/intelligence/evidence/service";

const router: IRouter = Router();

router.get("/memory/blacklist", async (req, res): Promise<void> => {
  const rows = await db.select().from(blacklistTable).where(and(
    eq(blacklistTable.userId, req.userId!),
    eq(blacklistTable.section, req.section!),
    gte(blacklistTable.expiresAt, new Date()),
  ));
  res.json(GetBlacklistResponse.parse(rows.map((row) => ({
    symbol: row.symbol,
    winRate: Number(row.winRate),
    tradeCount: row.tradeCount,
    blacklistedAt: row.blacklistedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }))));
});

router.get("/memory/toxic-hours", async (req, res): Promise<void> => {
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;
  const rows = await db.select({
    hour: hourlyStatsTable.hour,
    cumulativePnl: sql<number>`sum(${hourlyStatsTable.pnl})`,
    tradeCount: sql<number>`sum(${hourlyStatsTable.tradeCount})`,
    blockedAt: sql<string>`min(${hourlyStatsTable.createdAt})`,
  }).from(hourlyStatsTable)
    .where(and(
      eq(hourlyStatsTable.userId, req.userId!),
      eq(hourlyStatsTable.section, req.section!),
      gte(hourlyStatsTable.date, since),
    ))
    .groupBy(hourlyStatsTable.hour)
    .having(sql`sum(${hourlyStatsTable.pnl}) < 0`);
  res.json(GetToxicHoursResponse.parse(rows.map((row) => ({
    hour: row.hour,
    cumulativePnl: Number(row.cumulativePnl),
    tradeCount: Number(row.tradeCount),
    blockedAt: new Date(row.blockedAt).toISOString(),
  }))));
});

/** Full point-in-time evidence read model and independently controlled lifecycle. */
router.get("/memory/evidence", async (req, res): Promise<void> => {
  res.json(await evidenceOverview(req.userId!, req.section!));
});

const validationResponse = (result: Awaited<ReturnType<typeof runValidation>>["result"]) => ({
  verdict: result.verdict,
  summary: result.summary,
  stateVersion: result.state.version,
  trainTrades: result.trainTrades,
  validationTrades: result.validationTrades,
  embargoedTrades: result.embargoedTrades,
  embargoMs: result.embargoMs,
  dataCutoff: result.dataCutoff,
  withheld: result.withheld,
  withheldPnlUsdt: result.withheldPnlUsdt,
  expectancyDelta: result.expectancyDelta,
  baseline: result.baseline,
  withMemory: result.withMemory,
  rules: result.state.rules,
});

router.post("/memory/evidence/validate", async (req, res): Promise<void> => {
  const { result } = await runValidation(req.userId!, req.section!);
  res.json(validationResponse(result));
});

const confirmationBody = z.object({ confirmation: z.string().min(1) }).strict();
const suspensionBody = z.object({ reason: z.string().trim().min(3).max(500).optional() }).strict();

async function lifecycleResponse(res: Response, operation: () => Promise<unknown>) {
  try {
    res.json(await operation());
  } catch (error) {
    if (error instanceof EvidenceLifecycleError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    throw error;
  }
}

router.post("/memory/evidence/:version/promote", async (req, res): Promise<void> => {
  const body = confirmationBody.parse(req.body);
  if (body.confirmation !== PROMOTION_CONFIRMATION) {
    res.status(400).json({ error: `Type ${PROMOTION_CONFIRMATION} to confirm tightening-only activation.` });
    return;
  }
  await lifecycleResponse(res, () => promoteEvidenceVersion(
    req.userId!, req.section!, req.params.version!, body.confirmation,
  ));
});

router.post("/memory/evidence/:version/suspend", async (req, res): Promise<void> => {
  const body = suspensionBody.parse(req.body ?? {});
  await lifecycleResponse(res, () => suspendEvidenceVersion(
    req.userId!, req.section!, req.params.version!, body.reason,
  ));
});

router.post("/memory/evidence/:version/rollback", async (req, res): Promise<void> => {
  const body = confirmationBody.parse(req.body);
  if (body.confirmation !== ROLLBACK_CONFIRMATION) {
    res.status(400).json({ error: `Type ${ROLLBACK_CONFIRMATION} to confirm rollback.` });
    return;
  }
  await lifecycleResponse(res, () => rollbackEvidenceVersion(
    req.userId!, req.section!, req.params.version!, body.confirmation,
  ));
});

/** Compatibility status for existing generated clients. */
router.get("/memory/influence", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const section = req.section!;
  const [config] = await db.select({
    enabled: botConfigTable.memoryInfluenceEnabled,
    maxDelta: botConfigTable.memoryInfluenceMaxDelta,
    approvedVersion: botConfigTable.memoryInfluenceApprovedVersion,
  }).from(botConfigTable)
    .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)))
    .limit(1);
  const permission = await loadMemoryPermission(userId, section);
  const validation = await latestValidation(userId, section);
  const influences = await recentInfluences(userId, section, 50);
  res.json(GetMemoryInfluenceResponse.parse({
    enabled: config?.enabled ?? false,
    maxDelta: Number(config?.maxDelta ?? 10),
    approvedVersion: config?.approvedVersion ?? null,
    active: permission.state.enabled && permission.state.rules.length > 0,
    needsValidation: permission.needsValidation,
    executionTarget: permission.executionTarget,
    reason: permission.reason,
    summary: summariseState(permission.state),
    version: permission.state.version,
    rules: permission.state.rules,
    latestValidation: validation ? {
      id: validation.id,
      status: validation.status,
      verdict: validation.verdict,
      summary: validation.summary,
      stateVersion: validation.stateVersion,
      executionTarget: validation.executionTarget,
      trainTrades: validation.trainTrades,
      validationTrades: validation.validationTrades,
      withheld: validation.withheld,
      withheldPnlUsdt: validation.withheldPnlUsdt == null ? null : Number(validation.withheldPnlUsdt),
      expectancyDelta: validation.expectancyDelta == null ? null : Number(validation.expectancyDelta),
      createdAt: validation.createdAt.toISOString(),
    } : null,
    recent: influences.map((influence) => ({
      id: influence.id,
      symbol: influence.symbol,
      strategyId: influence.strategyId,
      admitted: influence.admitted,
      confidence: Number(influence.confidence),
      requiredConfidence: Number(influence.requiredConfidence),
      delta: Number(influence.delta),
      memoryVersion: influence.memoryVersion,
      executionTarget: influence.executionTarget,
      reason: influence.reason,
      createdAt: influence.createdAt.toISOString(),
    })),
  }));
});

/** Compatibility validation endpoint; it also creates Shadow only. */
router.post("/memory/influence/validate", async (req, res): Promise<void> => {
  const { result } = await runValidation(req.userId!, req.section!);
  res.json(RunMemoryValidationResponse.parse(validationResponse(result)));
});

/**
 * Direct activation was intentionally removed. Existing clients may still use
 * this route for the kill switch and for a desired max delta; both operations
 * leave influence inert until a new exact version is validated and promoted.
 */
router.patch("/memory/influence", async (req, res): Promise<void> => {
  const body = UpdateMemoryInfluenceBody.parse(req.body);
  const userId = req.userId!;
  const section = req.section!;

  if (body.enabled === true) {
    const permission = await loadMemoryPermission(userId, section);
    if (!permission.state.enabled) {
      res.status(409).json({
        error: "Direct activation is disabled. Validate a Shadow version, review it, and use the explicit promotion action.",
      });
      return;
    }
  }
  if (body.enabled === false || body.maxDelta !== undefined) {
    await revokeInfluence(userId, section, body.maxDelta !== undefined
      ? "Influence suspended because its configured bound changed; revalidation is required."
      : "Disabled from the UI.");
  }
  if (body.maxDelta !== undefined) {
    await db.update(botConfigTable).set({ memoryInfluenceMaxDelta: body.maxDelta.toFixed(2) })
      .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)));
    invalidate(userId, section);
  }
  const permission = await loadMemoryPermission(userId, section);
  res.json(UpdateMemoryInfluenceResponse.parse({
    enabled: permission.requested,
    active: permission.state.enabled && permission.state.rules.length > 0,
    needsValidation: permission.needsValidation,
    version: permission.state.version,
    reason: permission.reason,
  }));
});

export default router;
