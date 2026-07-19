import app from "./app";
import { db, botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";
import { validateEnv } from "./lib/env";
import { getOrCreateEngine, isSection } from "./lib/engineRegistry";

// app.ts already called validateEnv() at import time (fail fast before
// building any middleware) — this call is free (memoized) and just gets us
// the typed snapshot instead of re-parsing process.env by hand here.
const { port, host } = validateEnv();

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
      .select({ userId: botConfigTable.userId, section: botConfigTable.section })
      .from(botConfigTable)
      .where(eq(botConfigTable.engineDesiredRunning, true));
    // Each (user, section) whose desired state is running resumes independently
    // — a user with both crypto and forex running gets both back.
    for (const { userId, section } of rows) {
      const sec = isSection(section) ? section : "crypto";
      try {
        await getOrCreateEngine(userId, sec).start();
        logger.info({ userId, section: sec }, "AUTO-RESUME: engine restarted after server restart");
      } catch (err) {
        logger.error({ err, userId, section: sec }, "AUTO-RESUME: engine failed to restart — user must press Start manually");
      }
    }
    if (rows.length === 0) logger.info("AUTO-RESUME: no engines were running before restart");
  } catch (err) {
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
};

// Node binds every interface when no host is passed — so the unset case must
// omit the argument entirely rather than pass undefined through.
if (host) {
  app.listen(port, host, onListening);
} else {
  app.listen(port, onListening);
}
