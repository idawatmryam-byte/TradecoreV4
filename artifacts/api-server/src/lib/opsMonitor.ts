/**
 * TradeCore Pro — process-level ops monitoring (dependency-free)
 *
 * Captures the two failures that otherwise crash a Node process silently
 * (an uncaught exception, or an unhandled promise rejection), logs them as
 * structured events, and — when OPS_ALERT_WEBHOOK_URL is set — fires a compact
 * alert to a Discord/Slack-compatible incoming webhook so an operator finds
 * out their trading process fell over without watching the logs.
 *
 * Deliberately NO external SDK (no Sentry dependency): a single fetch to a
 * webhook the operator already has covers the "tell me when it crashes" need,
 * and keeps the install lean. Set OPS_ALERT_WEBHOOK_URL in .env to enable;
 * leave it unset and this is log-only, with zero behavior change.
 *
 * Crash policy matches the "let it crash, let PM2 restart it" design
 * (ecosystem.config.cjs has max_restarts + min_uptime to guard a crash loop):
 * an uncaughtException logs, best-effort notifies, then exits(1) so the
 * supervisor restarts a clean process. An unhandledRejection logs + notifies
 * but does not force an exit (many are benign and self-contained), preserving
 * existing runtime behavior.
 */
import { logger } from "./logger";
import { emitCriticalOperatorAlert } from "./operatorAlerts";

let installed = false;

/** Install the process-level handlers once. Call from index.ts at startup. */
export function installOpsMonitor(): void {
  if (installed) return;
  installed = true;

  if ((process.env["OPS_ALERT_WEBHOOK_URL"] ?? "").trim()) {
    logger.info("OPS monitor: crash alerting enabled (OPS_ALERT_WEBHOOK_URL set)");
  }

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "UNHANDLED_REJECTION");
    void emitCriticalOperatorAlert({
      code: "UNHANDLED_REJECTION",
      summary: "Unhandled promise rejection; inspect structured local logs for the full error",
      detail: reason instanceof Error ? reason.name : typeof reason,
      dedupeKey: reason instanceof Error ? reason.name : typeof reason,
    });
  });

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "UNCAUGHT_EXCEPTION — exiting for a clean supervisor restart");
    // Best-effort notify, then exit so PM2/systemd restarts a fresh process.
    void emitCriticalOperatorAlert({
      code: "UNCAUGHT_EXCEPTION",
      summary: "Uncaught exception; process is restarting and full details remain in local logs",
      detail: err.name,
      dedupeKey: err.name,
    })
      .finally(() => setTimeout(() => process.exit(1), 250));
  });
}
