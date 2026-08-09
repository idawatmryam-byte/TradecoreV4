import app from "./app";
import { db, botConfigTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";
import { validateEnv } from "./lib/env";
import { DEMO_IDLE_GRACE_MS, getOrCreateEngine, isSection, startDemoSweeper } from "./lib/engineRegistry";
import { installOpsMonitor } from "./lib/opsMonitor";
import { ensureDemoAccount } from "./lib/demoSeed";
import { beginEngineResume, failEngineResumeDiscovery, recordEngineResume } from "./lib/startupHealth";
import { resumeIncompleteResearchExperiments } from "./lib/intelligence/research/runner";

// app.ts already called validateEnv() at import time (fail fast before
// building any middleware) — this call is free (memoized) and just gets us
// the typed snapshot instead of re-parsing process.env by hand here.
const { port, host } = validateEnv();

// Capture uncaught exceptions / unhandled rejections (log always; optional
// webhook alert when OPS_ALERT_WEBHOOK_URL is set) before anything runs.
installOpsMonitor();

/**
 * Auto-resume: every engine whose persisted desired state is "running"
 * (user pressed Start and never Stop) is restarted after a server restart.
 * Without this, every update.sh / pm2 restart / reboot silently stopped all
 * trading until each user pressed START again — observed live as "the
 * engine hasn't made a trade in hours". Failures are per-user and non-fatal
 * (e.g. credentials revoked since): the server must come up regardless.
 */
async function resumeRunningEngines(): Promise<void> {
  try {
    const rows = await db
      .select({ userId: botConfigTable.userId, section: botConfigTable.section, isDemo: usersTable.isDemo })
      .from(botConfigTable)
      .leftJoin(usersTable, eq(usersTable.id, botConfigTable.userId))
      .where(eq(botConfigTable.engineDesiredRunning, true));

    // The read-only demo account must never run a live engine (it holds no
    // exchange keys and every mutation is blocked), so exclude it defensively
    // in case its desired-running flag was ever set outside the API.
    const resumable = rows.filter((r) => !r.isDemo);
    beginEngineResume(resumable.length);

    // Crypto and Forex are independent engines. Resume every valid section
    // the user deliberately left running; never clear one section's intent
    // merely because the other is also active. Doing so strands active
    // position management (trailing, ladder and time exits) after a deploy.
    for (const { userId, section } of resumable) {
      if (!isSection(section)) {
        logger.error({ userId, section }, "AUTO-RESUME: invalid persisted section — skipped");
        recordEngineResume(false);
        continue;
      }
      try {
        const engine = getOrCreateEngine(userId, section);
        await engine.start();
        const entryGateHealthy = engine.isDemoTarget() || engine.getState().newEntriesAllowed;
        logger.info(
          { userId, section, entryGateHealthy },
          entryGateHealthy
            ? "AUTO-RESUME: engine restarted after server restart"
            : "AUTO-RESUME: engine restarted in exit-only mode; readiness remains degraded",
        );
        recordEngineResume(entryGateHealthy);
      } catch (err) {
        logger.error({ err, userId, section }, "AUTO-RESUME: engine failed to restart — user must press Start manually");
        recordEngineResume(false);
      }
    }
    if (resumable.length === 0) logger.info("AUTO-RESUME: no engines were running before restart");
  } catch (err) {
    failEngineResumeDiscovery();
    logger.error({ err }, "AUTO-RESUME: could not query desired engine states");
  }
}

const onListening = (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, host: host ?? "0.0.0.0" }, "Server listening");
  void resumeRunningEngines();
  void ensureDemoOnStartup();
  void resumeIncompleteResearchExperiments().catch((err) => {
    logger.error({ err }, "RESEARCH: interrupted experiment discovery failed");
  });
  // Demo engines are session-scoped: they stop after a grace period of user
  // silence so a free signup does not cost an always-on scan loop forever.
  // Live engines are never touched by this sweeper.
  startDemoSweeper();
  logger.info(
    { graceMinutes: DEMO_IDLE_GRACE_MS / 60_000 },
    "Demo engine sweeper started — idle demo engines will pause, live engines are unaffected",
  );
};

/**
 * Make the one-click "Explore the live demo" path work out of the box: if no
 * demo account exists yet, create and seed one on startup. Never wipes an
 * existing demo (that's the explicit `seed:demo` / SEED_DEMO refresh). The
 * demo is read-only and holds no exchange keys, so it's safe to have by
 * default; an operator who doesn't want a public demo sets DEMO_DISABLED=1.
 */
async function ensureDemoOnStartup(): Promise<void> {
  if (process.env["DEMO_DISABLED"] === "1") {
    logger.info("DEMO: disabled via DEMO_DISABLED=1 — skipping demo account setup");
    return;
  }
  try {
    const { created, userId } = await ensureDemoAccount();
    if (created) logger.info({ userId }, "DEMO: no demo account existed — created and seeded one");
    else logger.info({ userId }, "DEMO: demo account present");
  } catch (err) {
    logger.error({ err }, "DEMO: could not ensure the demo account (non-fatal)");
  }
}

// Node binds every interface when no host is passed — so the unset case must
// omit the argument entirely rather than pass undefined through.
if (host) {
  app.listen(port, host, onListening);
} else {
  app.listen(port, onListening);
}
