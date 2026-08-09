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
  db, tradesTable, botConfigTable, recommendationsTable, notificationsTable,
  tradePartialExitsTable, strategyConfigsTable, strategyDecisionsTable,
  tradeAnalysesTable, executionIntentsTable, executionEventsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
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
    confidence: 70, expectedHoldSeconds: 1200, maxHoldSeconds: 7200, regime: "trend",
    netRewardRisk: 2, report: { summary: "copilot test plan", marketView: [], entryLogic: [], riskLogic: [], exitLogic: [], checks: [] },
    ...over,
  } as any;
}

async function cleanup() {
  const ids = (await db.select({ id: tradesTable.id }).from(tradesTable).where(eq(tradesTable.userId, USER))).map((t) => t.id);
  if (ids.length) await db.delete(tradePartialExitsTable).where(inArray(tradePartialExitsTable.tradeId, ids));
  const intentIds = (await db.select({ id: executionIntentsTable.id }).from(executionIntentsTable)
    .where(eq(executionIntentsTable.userId, USER))).map((i) => i.id);
  if (intentIds.length) await db.delete(executionEventsTable).where(inArray(executionEventsTable.intentId, intentIds));
  await db.delete(executionIntentsTable).where(eq(executionIntentsTable.userId, USER));
  await db.delete(recommendationsTable).where(eq(recommendationsTable.userId, USER));
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
  expect("a new section starts in Co-Pilot", baseConfig.mode === "copilot", String(baseConfig.mode));
  expect("a new section starts in demo", baseConfig.executionTarget === "demo", String(baseConfig.executionTarget));

  const configs = await loadStrategyConfigs(USER, "crypto");
  const pure: StrategyConfig = {
    ...configs.get("trend_pullback")!,
    tp1RMultiple: 0, tp3Enabled: false, trailingStopMode: "none",
    emergencyTrailingRMultiple: 0, breakEvenRMultiple: 0, cooldownMinutes: 5,
  };
  const copilotConfig = { ...baseConfig, mode: "copilot", executionTarget: "demo" };
  e.executionTarget = "demo";

  // ── 1. Same pipeline, different executor ─────────────────────────────────
  console.log("\n— Co-Pilot recommends exactly what AutoPilot would have traded —");
  expect("copilot mode selects the recommend executor", e.resolveExecutor(copilotConfig).kind === "recommend");

  const p = plan();
  const precedingStages = [
    { name: "Market Data", status: "pass" as const, detail: "candles fresh" },
    { name: "Indicators", status: "pass" as const, detail: "RSI 62" },
    { name: "Signal", status: "pass" as const, detail: "trend pullback triggered" },
    { name: "Risk Checks", status: "pass" as const, detail: "within daily loss limit" },
  ];
  const res = await e.resolveExecutor(copilotConfig).execute({
    symbol: "BTCUSDT", plan: p, row: { confidence: 70, regime: "trend" }, config: copilotConfig, now: T0, stratConfig: pure,
    precedingStages,
  });
  expect("Co-Pilot opens no position", res.entered === false);
  expect("its reason says it is awaiting review", /Co-Pilot/.test(res.reason), res.reason);

  const [rec] = await db.select().from(recommendationsTable).where(eq(recommendationsTable.userId, USER));
  expect("a recommendation was recorded", !!rec);
  expect("it starts actionable", rec!.status === "created");
  expect("authored by the engine", rec!.authoredBy === "engine");
  expect(
    "its fingerprint equals the plan AutoPilot would have executed",
    rec!.planFingerprint === planFingerprint(USER, p),
    rec!.planFingerprint,
  );
  expect("no trade exists yet", (await db.select().from(tradesTable).where(eq(tradesTable.userId, USER))).length === 0);

  const notes = await db.select().from(notificationsTable).where(eq(notificationsTable.userId, USER));
  expect("the user was notified", notes.length === 1, String(notes.length));
  expect("notification typed as copilot, reusing the existing bell", notes[0]?.type === "copilot", String(notes[0]?.type));

  const inbox = await listInbox(USER, "crypto");
  expect("it appears in the inbox", inbox.length === 1 && inbox[0]!.id === rec!.id);

  // Expiry derives from the plan's own expected resolution, not a flat number,
  // and is anchored to the SCAN's timestamp — the moment the setup was true —
  // rather than to when the row happened to be written.
  expect("expiry is derived from the plan's expected hold",
    rec!.expiresAt.getTime() === expiryFor(p, T0).getTime(),
    `${rec!.expiresAt.toISOString()} vs ${expiryFor(p, T0).toISOString()}`);
  expect("a 20-minute thesis gets a 10-minute review window",
    rec!.expiresAt.getTime() - T0.getTime() === 600_000,
    String(rec!.expiresAt.getTime() - T0.getTime()));

  // The decision trace is the real pipeline stages, snapshotted at creation —
  // never a narrative reconstruction of them.
  console.log("\n— the decision trace persists and round-trips through the workspace —");
  const persistedTrace = rec!.decisionTrace as unknown as Array<{ name: string; status: string; detail: string }>;
  expect("persists all 4 preceding stages plus Order", persistedTrace.length === 5, String(persistedTrace.length));
  expect("preceding stage names carry over in order",
    persistedTrace.slice(0, 4).map((s) => s.name).join(",") === precedingStages.map((s) => s.name).join(","),
    persistedTrace.map((s) => s.name).join(","));
  expect("the Order stage names Co-Pilot, not the strategy", /Co-Pilot/.test(persistedTrace[4]!.detail), persistedTrace[4]!.detail);

  const workspace = await getRecommendationWorkspace(USER, "crypto", rec!.id);
  expect("the workspace resolves the recommendation", workspace?.recommendation.id === rec!.id);
  expect("the workspace's decisionTrace matches what was persisted",
    JSON.stringify(workspace!.decisionTrace) === JSON.stringify(persistedTrace));
  expect("portfolio impact reports this plan's own risk",
    Math.abs(workspace!.portfolioImpact.candidateRiskUsdt - Math.abs(p.entryPrice - p.slPrice) * p.qty) < 1e-9,
    String(workspace!.portfolioImpact.candidateRiskUsdt));
  // Feature-similarity search runs for real here, against a test account with
  // essentially no history — so the correct result is a refusal that explains
  // itself, not a thin list of "similar" trades.
  const similar = workspace!.similarTrades;
  expect("similar trades refuses to answer from an empty record",
    similar.available === false, `available=${similar.available} pool=${similar.poolSize}`);
  expect("...and returns no matches at all rather than a short list", similar.matches.length === 0);
  expect("...and no aggregate stats", similar.stats === null);
  expect("...while stating the pool it needs and the pool it has",
    typeof similar.reason === "string" && similar.reason.length > 10 && similar.minPoolSize > 0);
  expect("workspace on an unknown id returns null", (await getRecommendationWorkspace(USER, "crypto", 9_999_999)) === null);

  // ── 2. Modify creates a NEW plan; the original is untouched ──────────────
  console.log("\n— modifying authors a new plan rather than editing one —");
  const originalSl = Number(rec!.slPrice);
  const mod = await modifyRecommendation(USER, "crypto", rec!.id, { slPrice: 97 });
  expect("modify succeeds", mod.ok, mod.reason);
  expect("it returns the new plan's id", typeof mod.newRecommendationId === "number");

  const [origAfter] = await db.select().from(recommendationsTable).where(eq(recommendationsTable.id, rec!.id));
  expect("the ORIGINAL plan's numbers are unchanged", Number(origAfter!.slPrice) === originalSl, String(origAfter!.slPrice));
  expect("the original is marked superseded, not deleted", origAfter!.status === "superseded");

  const [derived] = await db.select().from(recommendationsTable).where(eq(recommendationsTable.id, mod.newRecommendationId!));
  expect("the new plan carries the user's stop", Number(derived!.slPrice) === 97);
  expect("the new plan is attributed to the user", derived!.authoredBy === "user");
  expect("the new plan links back to the original", derived!.derivedFromId === rec!.id);
  expect("the new plan has its own fingerprint", derived!.planFingerprint !== origAfter!.planFingerprint);

  const derivedTrace = derived!.decisionTrace as unknown as Array<{ name: string; status: string; detail: string }>;
  expect("the modified plan keeps exactly one Order stage",
    derivedTrace.filter((s) => s.name === "Order").length === 1, String(derivedTrace.length));
  expect("the modified plan's Order stage attributes it to the user",
    /User-modified/.test(derivedTrace[derivedTrace.length - 1]!.detail), derivedTrace[derivedTrace.length - 1]!.detail);
  expect("the modified plan still carries the original's market context",
    derivedTrace.slice(0, 4).map((s) => s.name).join(",") === precedingStages.map((s) => s.name).join(","));

  // Geometry the engine would never produce cannot be created by hand either.
  const bad = await modifyRecommendation(USER, "crypto", derived!.id, { slPrice: 120 });
  expect("a stop on the wrong side of entry is refused", !bad.ok, bad.reason);
  expect("and it explains why", /stop must sit below/.test(bad.reason), bad.reason);

  // A superseded plan is terminal.
  const reMod = await modifyRecommendation(USER, "crypto", rec!.id, { slPrice: 96 });
  expect("a superseded plan can no longer be modified", !reMod.ok, reMod.reason);

  // ── 3. Approval re-validates ─────────────────────────────────────────────
  console.log("\n— approval re-asks the risk engine —");
  // The engine is not running, so the very first gate must refuse.
  const stopped = await executeRecommendation(USER, "crypto", derived!.id);
  expect("a stopped engine refuses execution", !stopped.ok, stopped.reason);
  expect("the refusal names the engine state", stopped.reason.includes("engine is stopped") || stopped.reason.includes("Engine"), stopped.reason);
  expect("every check that ran is reported, not just the first failure",
    (stopped.checks?.length ?? 0) >= 8, String(stopped.checks?.length));

  // ── 4. Blocked is terminal and read-only ─────────────────────────────────
  const [blocked] = await db.select().from(recommendationsTable).where(eq(recommendationsTable.id, derived!.id));
  expect("the refused plan is now blocked", blocked!.status === "blocked", String(blocked!.status));
  expect("the block reason is recorded", !!blocked!.resolutionReason);
  const retry = await executeRecommendation(USER, "crypto", derived!.id);
  expect("a blocked plan cannot be retried into a position", !retry.ok, retry.reason);
  expect("and it stays blocked", retry.status === "blocked", retry.status);
  expect("no trade was ever opened", (await db.select().from(tradesTable).where(eq(tradesTable.userId, USER))).length === 0);

  // ── 5. Expiry ────────────────────────────────────────────────────────────
  console.log("\n— an expired plan cannot be executed —");
  const p2 = plan({ symbol: "ETHUSDT" });
  await e.resolveExecutor(copilotConfig).execute({
    symbol: "ETHUSDT", plan: p2, row: { confidence: 70 }, config: copilotConfig, now: T0, stratConfig: pure,
  });
  const [rec2] = await db.select().from(recommendationsTable)
    .where(and(eq(recommendationsTable.userId, USER), eq(recommendationsTable.symbol, "ETHUSDT")));
  await db.update(recommendationsTable)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(recommendationsTable.id, rec2!.id));

  const expired = await executeRecommendation(USER, "crypto", rec2!.id);
  expect("an expired plan is refused", !expired.ok, expired.reason);
  expect("the refusal says it expired", /expired/i.test(expired.reason), expired.reason);
  const expiryCheck = expired.checks?.find((c) => c.name === "Not expired");
  expect("the expiry check is shown as failed", expiryCheck?.passed === false);

  // ── 6. Reject ────────────────────────────────────────────────────────────
  console.log("\n— declining is recorded, not discarded —");
  const p3 = plan({ symbol: "SOLUSDT" });
  await e.resolveExecutor(copilotConfig).execute({
    symbol: "SOLUSDT", plan: p3, row: { confidence: 70 }, config: copilotConfig, now: T0, stratConfig: pure,
  });
  const [rec3] = await db.select().from(recommendationsTable)
    .where(and(eq(recommendationsTable.userId, USER), eq(recommendationsTable.symbol, "SOLUSDT")));
  const rejected = await rejectRecommendation(USER, "crypto", rec3!.id, "not convinced by the volume");
  expect("reject succeeds", rejected.ok, rejected.reason);
  const [rec3After] = await db.select().from(recommendationsTable).where(eq(recommendationsTable.id, rec3!.id));
  expect("the row survives as a record", !!rec3After && rec3After.status === "rejected");
  expect("the user's note is kept", rec3After!.resolutionReason === "not convinced by the volume");
  const rejectAgain = await rejectRecommendation(USER, "crypto", rec3!.id);
  expect("a rejected plan cannot be rejected twice", !rejectAgain.ok);

  // ── 7. Concurrent approval is single-use ────────────────────────────────
  console.log("\n— concurrent approval can claim the plan only once —");
  const p4 = plan({ symbol: "XRPUSDT" });
  await e.resolveExecutor(copilotConfig).execute({
    symbol: "XRPUSDT", plan: p4, row: { confidence: 70 }, config: copilotConfig, now: T0, stratConfig: pure,
  });
  const [rec4] = await db.select().from(recommendationsTable)
    .where(and(eq(recommendationsTable.userId, USER), eq(recommendationsTable.symbol, "XRPUSDT")));

  const registryEngine = getOrCreateEngine(USER, "crypto") as any;
  const originalGather = registryEngine.gatherRevalidationState.bind(registryEngine);
  let releaseGather!: () => void;
  let markGatherEntered!: () => void;
  const gatherEntered = new Promise<void>((resolve) => { markGatherEntered = resolve; });
  const gatherHold = new Promise<void>((resolve) => { releaseGather = resolve; });
  registryEngine.gatherRevalidationState = async (candidate: unknown) => {
    markGatherEntered();
    await gatherHold;
    return originalGather(candidate);
  };

  const firstApproval = executeRecommendation(USER, "crypto", rec4!.id);
  await gatherEntered; // first request has already won the `created → executing` CAS
  const secondApproval = await executeRecommendation(USER, "crypto", rec4!.id);
  releaseGather();
  const firstOutcome = await firstApproval;
  registryEngine.gatherRevalidationState = originalGather;

  expect("the concurrent request is refused while the first owns the claim",
    !secondApproval.ok && secondApproval.status === "executing", `${secondApproval.status}: ${secondApproval.reason}`);
  expect("the owning request resolves through normal re-validation", !firstOutcome.ok && firstOutcome.status === "blocked", firstOutcome.reason);
  const [rec4After] = await db.select().from(recommendationsTable).where(eq(recommendationsTable.id, rec4!.id));
  expect("the claimed recommendation ends in one terminal state", rec4After!.status === "blocked", rec4After!.status);
  expect("concurrent approval opened no duplicate trade", (await db.select().from(tradesTable).where(eq(tradesTable.userId, USER))).length === 0);

  const finalInbox = await listInbox(USER, "crypto");
  expect("the inbox shows only actionable plans", finalInbox.length === 0, String(finalInbox.length));

  await cleanup();
  console.log(failures === 0 ? "\nAll Co-Pilot checks passed." : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
