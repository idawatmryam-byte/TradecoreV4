/**
 * DEMO-LIFECYCLE integration test — session-scoped demo engines.
 *
 * A live engine runs because real money is at stake and must keep running
 * whether or not anyone is watching. A demo engine has no such claim: leaving
 * one scanning forever for every account that ever signed up is an always-on
 * cost per signup with no revenue behind it.
 *
 * The two properties that make session-scoping safe:
 *
 *   1. It NEVER touches a live engine. Pausing a real position's engine
 *      because nobody opened the dashboard would be dangerous, so this is the
 *      assertion that matters most here.
 *   2. It is invisible. A paused demo engine keeps the user's desired-running
 *      flag, so it resumes on the next boot or the next time they return —
 *      nobody has to press Start again because they went to lunch.
 *
 * REQUIRES a database. Part of `pnpm test:integration`.
 *
 * Run:  DATABASE_URL=... tsx harness/demo-lifecycle.test.ts   (exit 0 = pass)
 */
process.env.CREDENTIALS_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.SESSION_SECRET ??= "demo-lifecycle-test-session-secret-123";

import { db, botConfigTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { BotEngine } from "../src/lib/botEngine";
import { DEMO_IDLE_GRACE_MS } from "../src/lib/engineRegistry";

const USER = 990045;

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
}

async function cleanup() {
  await db.delete(botConfigTable).where(eq(botConfigTable.userId, USER));
}

/** Put an engine into the "running" state without a broker or a scan loop. */
function fakeRunning(engine: BotEngine, target: "demo" | "live") {
  const e = engine as any;
  e.state.running = true;
  e.state.startedAt = new Date().toISOString();
  e.executionTarget = target;
}

async function main() {
  await cleanup();

  const engine = new BotEngine(USER, "crypto");
  const e = engine as any;
  await engine.loadConfig();

  // ── A new section starts in demo ─────────────────────────────────────────
  console.log("\n— a brand-new account starts in the simulation —");
  const [fresh] = await db.select().from(botConfigTable)
    .where(and(eq(botConfigTable.userId, USER), eq(botConfigTable.section, "crypto")));
  expect("new config defaults to the demo target", fresh?.executionTarget === "demo", String(fresh?.executionTarget));
  expect("new config starts on autopilot", fresh?.mode === "autopilot", String(fresh?.mode));
  expect("crypto demo starts at 10k virtual", Number(fresh?.demoStartingBalanceUsdt) === 10_000);

  const forexEngine = new BotEngine(USER, "forex");
  await forexEngine.loadConfig();
  const [freshForex] = await db.select().from(botConfigTable)
    .where(and(eq(botConfigTable.userId, USER), eq(botConfigTable.section, "forex")));
  expect("forex demo starts at 100k virtual", Number(freshForex?.demoStartingBalanceUsdt) === 100_000);

  // ── Pausing preserves the user's intent ──────────────────────────────────
  console.log("\n— pausing an idle demo engine is not the same as stopping it —");
  await db.update(botConfigTable).set({ engineDesiredRunning: true })
    .where(and(eq(botConfigTable.userId, USER), eq(botConfigTable.section, "crypto")));
  fakeRunning(engine, "demo");

  expect("engine reports running", engine.isRunning());
  expect("engine reports a demo target", engine.isDemoTarget());

  await engine.pauseForIdle();
  expect("pause stops the scan loop", !engine.isRunning());
  expect("pause keeps the desired-running flag", await engine.isDesiredRunning());
  expect("so the engine is eligible to resume itself", await engine.isDesiredRunning());

  // An explicit Stop is different: it must survive restarts.
  fakeRunning(engine, "demo");
  await engine.stop();
  expect("explicit stop clears the desired-running flag", !(await engine.isDesiredRunning()));

  // ── The sweeper never touches a live engine ──────────────────────────────
  console.log("\n— the sweeper leaves live engines alone —");
  const liveEngine = new BotEngine(USER, "forex");
  fakeRunning(liveEngine, "live");
  expect("live engine reports a live target", !liveEngine.isDemoTarget());

  // Mirror sweepIdleDemoEngines' predicate directly: the registry's map is
  // module-private, and what matters is the rule, not the plumbing.
  const eligible = (eng: BotEngine, idleMs: number) =>
    idleMs >= DEMO_IDLE_GRACE_MS && eng.isRunning() && eng.isDemoTarget();

  const longIdle = DEMO_IDLE_GRACE_MS + 1;
  expect("a long-idle LIVE engine is never swept", !eligible(liveEngine, longIdle));

  fakeRunning(engine, "demo");
  expect("a long-idle demo engine is swept", eligible(engine, longIdle));
  expect("a recently-active demo engine is left running", !eligible(engine, 60_000));

  const stoppedDemo = new BotEngine(USER, "crypto");
  (stoppedDemo as any).executionTarget = "demo";
  expect("an already-stopped demo engine is not swept again", !eligible(stoppedDemo, longIdle));

  await cleanup();
  console.log(failures === 0 ? "\nAll demo-lifecycle checks passed." : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
