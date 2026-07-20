import app from "./app";
import { db, botConfigTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
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

    // EXCLUSIVE MODE: only one section per user may run. If a user has BOTH
    // sections flagged (state from before exclusivity, or a crash between
    // stop/start), resume the one holding open positions — it needs its
    // trade management back — preferring crypto on a tie, and clear the
    // other's desired flag so the state converges.
    const byUser = new Map<number, string[]>();
    for (const { userId, section } of rows) {
      byUser.set(userId, [...(byUser.get(userId) ?? []), section]);
    }

    for (const [userId, sections] of byUser) {
      let chosen = sections[0]!;
      if (sections.length > 1) {
        chosen = "crypto";
        for (const section of sections) {
          const open = await db
            .select({ id: tradesTable.id })
            .from(tradesTable)
            .where(and(eq(tradesTable.userId, userId), eq(tradesTable.section, section), eq(tradesTable.status, "open")))
            .limit(1);
          if (open.length > 0) { chosen = section; break; }
        }
        for (const section of sections) {
          if (section === chosen) continue;
          await db
            .update(botConfigTable)
            .set({ engineDesiredRunning: false })
            .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)));
          logger.info({ userId, section, chosen }, "AUTO-RESUME: exclusive mode — sibling section's desired-running cleared");
        }
      }

      const sec = isSection(chosen) ? chosen : "crypto";
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
