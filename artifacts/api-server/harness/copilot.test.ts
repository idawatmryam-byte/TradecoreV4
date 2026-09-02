/**
 * CO-PILOT integration test — the human in the loop.
 *
 * The acceptance criteria this phase promised, each stated as a claim that
 * would be embarrassing to get wrong:
 *
 *   1. A Co-Pilot recommendation is byte-identical to what AutoPilot would
 *      have traded for the same scan. Proven by fingerprint equality, not by
 *      inspection — a Co-Pilot that recommends something subtly different from
 *      what the bot would do is worse than no Co-Pilot at all.
 *   2. Approval re-validates. Approving is "is this still a good idea?", not
 *      "place this order". Otherwise Co-Pilot is strictly MORE dangerous than
 *      AutoPilot: same trade, taken later, no checks re-run.
 *   3. Expired plans cannot execute.
 *   4. Blocked is terminal and read-only — no path from there to a position.
 *   5. Modify creates a NEW linked plan and never edits the original, so a
 *      later post-mortem can still say whose decision lost the money.
 *
 * REQUIRES a database. Part of `pnpm test:integration`.
 *
 * Run:  DATABASE_URL=... tsx harness/copilot.test.ts   (exit 0 = pass)
 */
process.env.CREDENTIALS_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.SESSION_SECRET ??= "copilot-test-session-secret-123";

import {
  db, tradesTable, botConfigTable,
  recommendationEventsTable,
  recommendationsTable, notificationsTable,
  tradePartialExitsTable, strategyConfigsTable, strategyDecisionsTable,
  tradeAnalysesTable, executionIntentsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { BotEngine } from "../src/lib/botEngine";
import { planFingerprint } from "../src/lib/plan/fingerprint";
import { expiryFor } from "../src/lib/execution/recommendExecutor";
import {
  executeRecommendation, getRecommendationWorkspace, listInbox, modifyRecommendation, rejectRecommendation,
} from "../src/lib/copilot/copilotService";
import { loadStrategyConfigs } from "../src/lib/strategyConfigLoader";
import type { StrategyConfig } from "../src/lib/strategies";
import { getOrCreateEngine } from "../src/lib/engineRegistry";

const USER = 990046;

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
}

const T0 = new Date("2025-06-01T12:00:00Z");

function plan(over: Record<string, unknown> = {}) {
  return {
    strategyId: "trend_pullback", strategyName: "Trend Pullback", symbol: "BTCUSDT",
    side: "long", entryPrice: 100, slPrice: 95, tpPrice: 110, qty: 1, leverage: 1,
    confidence: 70, expectedHoldSeconds: 1200, maxHoldSeconds: 7200, regime: "strong_trend",
    netRewardRisk: 2, report: { summary: "copilot test plan", marketView: [], entryLogic: [], riskLogic: [], exitLogic: [], checks: [],
    },
    ...over,
  } as any;
}

function supervision(symbol: string, p: ReturnType<typeof plan>) {
  const marketState = {
    marketStateVersion: "market-state-v1",
    fingerprint: "a".repeat(64),
    symbol,
    dataTimestamp: T0.toISOString(),
    dataQuality: { status: "healthy", issues: [] },
    inferences: { regime: p.regime },
  };
  const decision = {
    decisionId: "00000000-0000-5000-8000-000000000001",
    decisionFingerprint: "b".repeat(64),
    versions: {
      brain: "brain-v0",
      strategy: p.strategyId,
      model: "none",
      config: "test",
      marketState: "market-state-v1",
    },
    thesis: {
      managementPolicyVersion: "shadow-fixed-sltp-v1",
      context: "test context",
      trigger: "test trigger",
      invalidationConditions: ["stop crossed"],
      targetRationale: "test target",
      expectedPath: ["continue"],
      expectedDurationSeconds: p.expectedHoldSeconds,
    },
  };
  return {
    marketState,
    specialistCouncil: { consensus: { stance: p.side, explanation: "test" } },
    councilRun: {
      councilVersion: "shadow-decision-council-v1",
      decision,
      decisionFingerprint: "b".repeat(64),
    },
    portfolio: {
      portfolioVersion: "shadow-portfolio-intelligence-v1",
      fingerprint: "c".repeat(64),
      dataIssues: [],
      policy: { riskPolicyVersion: "test-risk-v1" },
      context: { correlationClusters: [] },
    },
    creationRiskChecks: [],
  } as any;
}

function approvalFor(
  rec: typeof recommendationsTable.$inferSelect,
  key: string,
) {
  return {
    expectedPlanFingerprint: rec.planFingerprint,
    expectedDecisionBundleFingerprint: rec.decisionBundleFingerprint!,
    executionTarget: rec.executionTarget as "demo" | "live",
    approvalChallenge: rec.approvalChallenge!,
    idempotencyKey: key,
    confirmation: `APPROVE ${rec.symbol} ${rec.side.toUpperCase()} FOR ${String(rec.executionTarget).toUpperCase()}`,
  };
}

async function cleanup() {
  const ids = (await db.select({ id: tradesTable.id }).from(tradesTable).where(eq(tradesTable.userId, USER))).map((t) => t.id);
  if (ids.length) await db.delete(tradePartialExitsTable).where(inArray(tradePartialExitsTable.tradeId, ids));
  await db.execute(sql`SELECT capture.purge_user_data(${USER})`);
  await db.delete(executionIntentsTable).where(eq(executionIntentsTable.userId, USER));
  await db
    .delete(recommendationsTable).where(eq(recommendationsTable.userId, USER));
  await db.delete(notificationsTable).where(eq(notificationsTable.userId, USER));
  await db.delete(tradeAnalysesTable).where(eq(tradeAnalysesTable.userId, USER));
  await db.delete(tradesTable).where(eq(tradesTable.userId, USER));
  await db.delete(strategyDecisionsTable).where(eq(strategyDecisionsTable.userId, USER));
  await db.delete(strategyConfigsTable).where(eq(strategyConfigsTable.userId, USER));
  await db.delete(botConfigTable).where(eq(botConfigTable.userId, USER));
}

async function main() {
  await cleanup();

  const engine = new BotEngine(USER, "crypto");
  const e = engine as any;
  const baseConfig = await engine.loadConfig();
  expect("a new section starts in Demo AutoPilot", baseConfig.mode === "autopilot", String(baseConfig.mode),
  );
  expect("a new section starts in demo", baseConfig.executionTarget === "demo", String(baseConfig.executionTarget),
  );

  // The remainder of this harness exercises Co-Pilot approval semantics, so it
  // must opt in explicitly now that new accounts begin in Demo AutoPilot.
  await db.update(botConfigTable).set({ mode: "copilot" }).where(and(
    eq(botConfigTable.userId, USER),
    eq(botConfigTable.section, "crypto"),
  ));

  const configs = await loadStrategyConfigs(USER, "crypto");
  const pure: StrategyConfig = {
    ...configs.get("trend_pullback")!,
    tp1RMultiple: 0, tp3Enabled: false, trailingStopMode: "none",
    emergencyTrailingRMultiple: 0, breakEvenRMultiple: 0, cooldownMinutes: 5,
  };
  const copilotConfig = { ...baseConfig, mode: "copilot", executionTarget: "demo",
  };
  e.executionTarget = "demo";

  // ── 1. Same pipeline, different executor ─────────────────────────────────
  console.log("\n— Co-Pilot recommends exactly what AutoPilot would have traded —",
  );
  expect("copilot mode selects the recommend executor", e.resolveExecutor(copilotConfig).kind === "recommend",
  );

  const p = plan();
  const precedingStages = [
    { name: "Market Data", status: "pass" as const, detail: "candles fresh" },
    { name: "Indicators", status: "pass" as const, detail: "RSI 62" },
    { name: "Signal", status: "pass" as const, detail: "trend pullback triggered",
    },
    { name: "Risk Checks", status: "pass" as const, detail: "within daily loss limit",
    },
  ];
  const res = await e.resolveExecutor(copilotConfig).execute({
    symbol: "BTCUSDT", plan: p, row: { confidence: 70, regime: "trend" }, config: copilotConfig, now: T0, stratConfig: pure,
    precedingStages,
    copilotSupervision: supervision("BTCUSDT", p),
  });
  expect("Co-Pilot opens no position", res.entered === false);
  expect("its reason says it is awaiting review", /Co-Pilot/.test(res.reason), res.reason,
  );

  const [rec] = await db.select().from(recommendationsTable).where(eq(recommendationsTable.userId, USER));
  expect("a recommendation was recorded", !!rec);
  expect("it starts actionable", rec!.status === "created");
  expect("authored by the engine", rec!.authoredBy === "engine");
  expect(
    "its fingerprint equals the plan AutoPilot would have executed",
    rec!.planFingerprint === planFingerprint(USER, p),
    rec!.planFingerprint,
  );
  expect("no trade exists yet", (await db.select().from(tradesTable).where(eq(tradesTable.userId, USER))).length === 0,
  );

  const proposedEvents = await db
    .select()
    .from(recommendationEventsTable)
    .where(eq(recommendationEventsTable.recommendationId, rec!.id));
  expect(
    "proposal creation is append-only audited",
    proposedEvents.length === 1 && proposedEvents[0]!.eventType === "PROPOSED",
  );

  const notes = await db.select().from(notificationsTable).where(eq(notificationsTable.userId, USER));
  expect("the user was notified", notes.length === 1, String(notes.length));
  expect("notification typed as copilot, reusing the existing bell", notes[0]?.type === "copilot", String(notes[0]?.type),
  );

  const inbox = await listInbox(USER, "crypto");
  expect("it appears in the inbox", inbox.length === 1 && inbox[0]!.id === rec!.id,
  );

  // Expiry derives from the plan's own expected resolution, not a flat number,
  // and is anchored to the SCAN's timestamp — the moment the setup was true —
  // rather than to when the row happened to be written.
  expect("expiry is derived from the plan's expected hold",
    rec!.expiresAt.getTime() === expiryFor(p, T0).getTime(),
    `${rec!.expiresAt.toISOString()} vs ${expiryFor(p, T0).toISOString()}`,
  );
  expect("a 20-minute thesis gets a 10-minute review window",
    rec!.expiresAt.getTime() - T0.getTime() === 600_000,
    String(rec!.expiresAt.getTime() - T0.getTime()),
  );

  // The decision trace is the real pipeline stages, snapshotted at creation —
  // never a narrative reconstruction of them.
  console.log("\n— the decision trace persists and round-trips through the workspace —",
  );
  const persistedTrace = rec!.decisionTrace as unknown as Array<{ name: string; status: string; detail: string;
  }>;
  expect("persists all 4 preceding stages plus Order", persistedTrace.length === 5, String(persistedTrace.length),
  );
  expect("preceding stage names carry over in order",
    persistedTrace.slice(0, 4).map((s) => s.name).join(",") === precedingStages.map((s) => s.name).join(","),
    persistedTrace.map((s) => s.name).join(","),
  );
  expect("the Order stage names Co-Pilot, not the strategy", /Co-Pilot/.test(persistedTrace[4]!.detail), persistedTrace[4]!.detail,
  );

  const workspace = await getRecommendationWorkspace(USER, "crypto", rec!.id);
  expect("the workspace resolves the recommendation", workspace?.recommendation.id === rec!.id,
  );
  expect("the workspace's decisionTrace matches what was persisted",
    JSON.stringify(workspace!.decisionTrace) === JSON.stringify(persistedTrace),
  );
  expect("portfolio impact reports this plan's own risk",
    Math.abs(workspace!.portfolioImpact.candidateRiskUsdt - Math.abs(p.entryPrice - p.slPrice) * p.qty,
    ) < 1e-9,
    String(workspace!.portfolioImpact.candidateRiskUsdt),
  );
  // Feature-similarity search runs for real here, against a test account with
  // essentially no history — so the correct result is a refusal that explains
  // itself, not a thin list of "similar" trades.
  const similar = workspace!.similarTrades;
  expect("similar trades refuses to answer from an empty record",
    similar.available === false, `available=${similar.available} pool=${similar.poolSize}`,
  );
  expect("...and returns no matches at all rather than a short list", similar.matches.length === 0,
  );
  expect("...and no aggregate stats", similar.stats === null);
  expect("...while stating the pool it needs and the pool it has",
    typeof similar.reason === "string" && similar.reason.length > 10 && similar.minPoolSize > 0,
  );
  expect("workspace on an unknown id returns null", (await getRecommendationWorkspace(USER, "crypto", 9_999_999)) === null,
  );

  // ── 2. Modify creates a NEW plan; the original is untouched ──────────────
  console.log("\n— modifying authors a new plan rather than editing one —");
  const originalSl = Number(rec!.slPrice);
  const mod = await modifyRecommendation(USER, "crypto", rec!.id, { slPrice: 97,
  });
  expect("modify succeeds", mod.ok, mod.reason);
  expect("it returns the new plan's id", typeof mod.newRecommendationId === "number",
  );

  const [origAfter] = await db.select().from(recommendationsTable).where(eq(recommendationsTable.id, rec!.id));
  expect("the ORIGINAL plan's numbers are unchanged", Number(origAfter!.slPrice) === originalSl, String(origAfter!.slPrice),
  );
  expect("the original is marked superseded, not deleted", origAfter!.status === "superseded",
  );

  const [derived] = await db.select().from(recommendationsTable).where(eq(recommendationsTable.id, mod.newRecommendationId!));
  expect("the new plan carries the user's stop", Number(derived!.slPrice) === 97,
  );
  expect("the new plan is attributed to the user", derived!.authoredBy === "user",
  );
  expect("the new plan links back to the original", derived!.derivedFromId === rec!.id,
  );
  expect("the new plan has its own fingerprint", derived!.planFingerprint !== origAfter!.planFingerprint,
  );

  const derivedTrace = derived!.decisionTrace as unknown as Array<{ name: string; status: string; detail: string;
  }>;
  expect("the modified plan keeps exactly one Order stage",
    derivedTrace.filter((s) => s.name === "Order").length === 1, String(derivedTrace.length),
  );
  expect("the modified plan's Order stage attributes it to the user",
    /User-modified/.test(derivedTrace[derivedTrace.length - 1]!.detail), derivedTrace[derivedTrace.length - 1]!.detail,
  );
  expect("the modified plan still carries the original's market context",
    derivedTrace.slice(0, 4).map((s) => s.name).join(",") === precedingStages.map((s) => s.name).join(","),
  );

  // Geometry the engine would never produce cannot be created by hand either.
  const bad = await modifyRecommendation(USER, "crypto", derived!.id, { slPrice: 120,
  });
  expect("a stop on the wrong side of entry is refused", !bad.ok, bad.reason);
  expect("and it explains why", /stop must sit below/.test(bad.reason), bad.reason,
  );

  // A superseded plan is terminal.
  const reMod = await modifyRecommendation(USER, "crypto", rec!.id, { slPrice: 96,
  });
  expect("a superseded plan can no longer be modified", !reMod.ok, reMod.reason,
  );

  // ── 3. Approval re-validates ─────────────────────────────────────────────
  console.log("\n— approval re-asks the risk engine —");
  // The engine is not running, so the very first gate must refuse.
  const stoppedApproval = approvalFor(derived!, "stopped-approval-0001");
  const stopped = await executeRecommendation(USER, "crypto", derived!.id,
    stoppedApproval,
  );
  expect("a stopped engine refuses execution", !stopped.ok, stopped.reason);
  expect("the refusal names the engine state", stopped.reason.includes("engine is stopped") || stopped.reason.includes("Engine"), stopped.reason,
  );
  expect("every check that ran is reported, not just the first failure",
    (stopped.checks?.length ?? 0) >= 8, String(stopped.checks?.length),
  );

  // ── 4. Blocked is terminal and read-only ─────────────────────────────────
  const [blocked] = await db.select().from(recommendationsTable).where(eq(recommendationsTable.id, derived!.id));
  expect("the refused plan is now blocked", blocked!.status === "blocked", String(blocked!.status),
  );
  expect("the block reason is recorded", !!blocked!.resolutionReason);
  expect(
    "the current validation verdict is retained",
    blocked!.lastValidation != null,
  );
  const retry = await executeRecommendation(USER, "crypto", derived!.id,
    stoppedApproval,
  );
  expect("a blocked plan cannot be retried into a position", !retry.ok, retry.reason,
  );
  expect("and it stays blocked", retry.status === "blocked", retry.status);
  expect(
    "a lost-response retry replays the same result",
    retry.idempotentReplay === true,
  );
  expect(
    "no trade was ever opened", (await db.select().from(tradesTable).where(eq(tradesTable.userId, USER))).length === 0,
  );

  // ── 5. Expiry ────────────────────────────────────────────────────────────
  console.log("\n— an expired plan cannot be executed —");
  const p2 = plan({ symbol: "ETHUSDT" });
  await e.resolveExecutor(copilotConfig).execute({
    symbol: "ETHUSDT", plan: p2, row: { confidence: 70 }, config: copilotConfig, now: T0, stratConfig: pure,
    copilotSupervision: supervision("ETHUSDT", p2),
  });
  const [rec2] = await db.select().from(recommendationsTable)
    .where(and(eq(recommendationsTable.userId, USER), eq(recommendationsTable.symbol, "ETHUSDT"),
      ),
    );
  await db.update(recommendationsTable)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(recommendationsTable.id, rec2!.id));

  const expired = await executeRecommendation(USER, "crypto", rec2!.id,
    approvalFor(rec2!, "expired-approval-0001"),
  );
  expect("an expired plan is refused", !expired.ok, expired.reason);
  expect("the refusal says it expired", /expired/i.test(expired.reason), expired.reason,
  );
  const expiryCheck = expired.checks?.find((c) => c.name === "Not expired");
  expect("the expiry check is shown as failed", expiryCheck?.passed === false);

  // ── 6. Reject ────────────────────────────────────────────────────────────
  console.log("\n— declining is recorded, not discarded —");
  const p3 = plan({ symbol: "SOLUSDT" });
  await e.resolveExecutor(copilotConfig).execute({
    symbol: "SOLUSDT", plan: p3, row: { confidence: 70 }, config: copilotConfig, now: T0, stratConfig: pure,
    copilotSupervision: supervision("SOLUSDT", p3),
  });
  const [rec3] = await db.select().from(recommendationsTable)
    .where(and(eq(recommendationsTable.userId, USER), eq(recommendationsTable.symbol, "SOLUSDT"),
      ),
    );
  const rejection = {
    expectedPlanFingerprint: rec3!.planFingerprint,
    approvalChallenge: rec3!.approvalChallenge!,
    note: "not convinced by the volume",
  };
  const rejected = await rejectRecommendation(USER, "crypto", rec3!.id,
    rejection,
  );
  expect("reject succeeds", rejected.ok, rejected.reason);
  const [rec3After] = await db.select().from(recommendationsTable).where(eq(recommendationsTable.id, rec3!.id));
  expect("the row survives as a record", !!rec3After && rec3After.status === "rejected",
  );
  expect("the user's note is kept", rec3After!.resolutionReason === "not convinced by the volume",
  );
  const rejectionEvents = await db
    .select()
    .from(recommendationEventsTable)
    .where(eq(recommendationEventsTable.recommendationId, rec3!.id));
  expect(
    "rejection audit attributes the acting user",
    rejectionEvents.some(
      (event) => event.eventType === "REJECTED" && event.actorUserId === USER,
    ),
  );
  const rejectAgain = await rejectRecommendation(USER, "crypto", rec3!.id,
    rejection,
  );
  expect("a rejected plan cannot be rejected twice", !rejectAgain.ok);

  // ── 7. Concurrent approval is single-use ────────────────────────────────
  console.log("\n— concurrent approval can claim the plan only once —");
  const p4 = plan({ symbol: "XRPUSDT" });
  await e.resolveExecutor(copilotConfig).execute({
    symbol: "XRPUSDT", plan: p4, row: { confidence: 70 }, config: copilotConfig, now: T0, stratConfig: pure,
    copilotSupervision: supervision("XRPUSDT", p4),
  });
  const [rec4] = await db.select().from(recommendationsTable)
    .where(and(eq(recommendationsTable.userId, USER), eq(recommendationsTable.symbol, "XRPUSDT"),
      ),
    );

  const registryEngine = getOrCreateEngine(USER, "crypto") as any;
  const unauthorized = await executeRecommendation(
    USER + 1,
    "crypto",
    rec4!.id,
    approvalFor(rec4!, "unauthorized-user-0001"),
  );
  expect(
    "another account cannot approve this proposal",
    !unauthorized.ok && /not found/i.test(unauthorized.reason),
    unauthorized.reason,
  );
  const originalGather = registryEngine.gatherRevalidationState.bind(registryEngine);
  let releaseGather!: () => void;
  let markGatherEntered!: () => void;
  const gatherEntered = new Promise<void>((resolve) => { markGatherEntered = resolve; });
  const gatherHold = new Promise<void>((resolve) => { releaseGather = resolve; });
  registryEngine.gatherRevalidationState = async (
    candidate: unknown,
    approvalTime: Date,
  ) => {
    markGatherEntered();
    await gatherHold;
    return originalGather(candidate, approvalTime);
  };

  const concurrentApprovalNow = new Date(T0.getTime() + 60_000);
  const firstApproval = executeRecommendation(USER, "crypto", rec4!.id,
    approvalFor(rec4!, "concurrent-approval-0001"),
    concurrentApprovalNow,
  );
  await gatherEntered; // first request has already won the `created → executing` CAS
  const secondApproval = await executeRecommendation(USER, "crypto", rec4!.id,
    approvalFor(rec4!, "concurrent-approval-0002"),
    concurrentApprovalNow,
  );
  releaseGather();
  const firstOutcome = await firstApproval;
  registryEngine.gatherRevalidationState = originalGather;

  expect("the concurrent request is refused while the first owns the claim",
    !secondApproval.ok && secondApproval.status === "executing", `${secondApproval.status}: ${secondApproval.reason}`,
  );
  expect("the owning request resolves through normal re-validation", !firstOutcome.ok && firstOutcome.status === "blocked", firstOutcome.reason,
  );
  const [rec4After] = await db.select().from(recommendationsTable).where(eq(recommendationsTable.id, rec4!.id));
  expect("the claimed recommendation ends in one terminal state", rec4After!.status === "blocked", rec4After!.status,
  );
  expect("concurrent approval opened no duplicate trade", (await db.select().from(tradesTable).where(eq(tradesTable.userId, USER))).length === 0,
  );

  const concurrentEvents = await db
    .select()
    .from(recommendationEventsTable)
    .where(eq(recommendationEventsTable.recommendationId, rec4!.id));
  expect(
    "only one concurrent request crosses the approval claim",
    concurrentEvents.filter((event) => event.eventType === "APPROVAL_REQUESTED")
      .length === 1,
  );

  // ── 8. A healthy approval uses the existing controlled engine path once ──
  console.log("\n— a valid approval authorizes one existing-path attempt —");
  const p5 = plan({ symbol: "ADAUSDT" });
  await e.resolveExecutor(copilotConfig).execute({
    symbol: "ADAUSDT", plan: p5, row: { confidence: 70 }, config: copilotConfig,
    now: T0, stratConfig: pure, copilotSupervision: supervision("ADAUSDT", p5),
  });
  const [rec5] = await db.select().from(recommendationsTable)
    .where(and(eq(recommendationsTable.userId, USER), eq(recommendationsTable.symbol, "ADAUSDT")));
  const originalExecuteApprovedPlan = registryEngine.executeApprovedPlan.bind(registryEngine);
  let controlledExecutionCalls = 0;
  const approvalNow = new Date(T0.getTime() + 60_000);
  const originalLoadConfig = registryEngine.loadConfig.bind(registryEngine);
  const originalRunning = registryEngine.state.running;
  const originalConnectionSuspended = registryEngine.connectionSuspended;
  registryEngine.state.running = true;
  registryEngine.connectionSuspended = false;
  registryEngine.loadConfig = async () => ({
    ...baseConfig,
    mode: "copilot",
    executionTarget: "live",
  });
  const targetFlip = await originalExecuteApprovedPlan(
    p5,
    { confidence: 70 } as any,
    approvalNow,
    "demo",
  );
  expect(
    "the execution boundary refuses a Demo-to-Live target flip",
    !targetFlip.entered && /target changed/i.test(targetFlip.reason),
    targetFlip.reason,
  );
  registryEngine.loadConfig = originalLoadConfig;
  registryEngine.state.running = originalRunning;
  registryEngine.connectionSuspended = originalConnectionSuspended;
  registryEngine.gatherRevalidationState = async () => ({
    engineRunning: true,
    circuitBreakerActive: false,
    riskPaused: false,
    openPositions: 0,
    maxOpenPositions: 5,
    strategyOpenCount: 0,
    maxConcurrentPerStrategy: 2,
    openRiskUsdt: 0,
    maxPortfolioRiskUsdt: 100,
    onCooldown: false,
    blacklisted: false,
    symbolAlreadyOpen: false,
    currentPrice: 100,
    marketDataTimestamp: approvalNow,
    tradingMode: "copilot",
    currentExecutionTarget: "demo",
    reconciliationHealthy: true,
    reconciliationDetail: "test reconciliation healthy",
    executionEligible: true,
    executionEligibilityDetail: "controlled engine test path eligible",
    marketStateFresh: true,
    marketStateHealthy: true,
    currentRegime: "strong_trend",
    thesisValid: true,
    thesisDetail: "test thesis valid",
    symbolExposureAfterUsdt: 100,
    maxSymbolExposureUsdt: 1_000,
    netExposureAfterUsdt: 100,
    maxNetExposureUsdt: 1_000,
    correlatedExposureAfterUsdt: 100,
    maxCorrelatedExposureUsdt: 1_000,
    correlationKnownOrAllowed: true,
    sizingValid: true,
    sizingDetail: "test sizing valid",
    executionCostViable: true,
    executionCostDetail: "test execution costs viable",
  });
  registryEngine.executeApprovedPlan = async (
    _plan: unknown,
    _row: unknown,
    _now: Date,
    approvedTarget: "demo" | "live",
  ) => {
    controlledExecutionCalls++;
    if (approvedTarget !== "demo") {
      return { entered: false, reason: "approved target was not preserved" };
    }
    return { entered: true, reason: "existing controlled engine path entered", tradeId: 7701 };
  };
  const validApproval = approvalFor(rec5!, "valid-approval-0001");
  const approved = await executeRecommendation(USER, "crypto", rec5!.id, validApproval, approvalNow);
  expect("a fully valid approval succeeds", approved.ok && approved.status === "executed", approved.reason);
  expect("the existing controlled engine path is called exactly once", controlledExecutionCalls === 1, String(controlledExecutionCalls));
  const replayedApproval = await executeRecommendation(USER, "crypto", rec5!.id, validApproval, approvalNow);
  expect("same-request replay returns the stored successful result", replayedApproval.ok && replayedApproval.idempotentReplay === true);
  expect("idempotent replay does not invoke execution again", controlledExecutionCalls === 1, String(controlledExecutionCalls));
  const successEvents = await db.select().from(recommendationEventsTable)
    .where(eq(recommendationEventsTable.recommendationId, rec5!.id));
  expect("successful approval records request, authorization, and execution",
    ["APPROVAL_REQUESTED", "APPROVAL_AUTHORIZED", "EXECUTION_SUCCEEDED"]
      .every((eventType) => successEvents.some((event) => event.eventType === eventType)));
  registryEngine.gatherRevalidationState = originalGather;
  registryEngine.executeApprovedPlan = originalExecuteApprovedPlan;

  const finalInbox = await listInbox(USER, "crypto");
  expect("the inbox shows only actionable plans", finalInbox.length === 0, String(finalInbox.length),
  );

  await cleanup();
  console.log(failures === 0 ? "\nAll Co-Pilot checks passed." : `\n${failures} FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
