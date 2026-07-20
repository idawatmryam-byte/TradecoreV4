/**
 * TradeCore Pro — PM2 process configuration (VPS production)
 *
 * One process serves BOTH the REST API (/api/*) and the built React dashboard
 * (static SPA at dist/public/), so there is only one service to run.
 *
 * Secrets are NOT stored here. This file is safe to commit. All configuration
 * is read from .env (chmod 600, gitignored) via Node's native --env-file, so
 * credentials never appear in `pm2 describe`, process listings, or git.
 *
 * IMPORTANT — do not switch to cluster mode or instances > 1.
 * The bot engine keeps live trading state in-process (engineRegistry) and runs
 * its scan loop on interval timers. Two instances would mean two engines
 * evaluating the same strategies against the same account and placing
 * DUPLICATE live orders. This must stay a single fork-mode process.
 *
 * Paths are derived from this file's own location (__dirname = repo root), so
 * the config works wherever the repo is checked out — no hardcoded per-machine
 * paths to keep in sync.
 */
const path = require("node:path");

const REPO_ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: "tradecore-api",
      cwd: path.join(REPO_ROOT, "artifacts/api-server"),
      script: "./dist/index.mjs",

      // --enable-source-maps: keeps stack traces pointing at the TS sources.
      // --env-file: loads .env into process.env (Node >= 20.6; this box is 24).
      node_args: [
        "--enable-source-maps",
        `--env-file=${path.join(REPO_ROOT, ".env")}`,
      ],

      // See the warning above — single process, never clustered.
      exec_mode: "fork",
      instances: 1,

      autorestart: true,
      // If it crashes 10x without staying up 30s, stop retrying and stay down
      // rather than thrashing a trading process in a crash loop.
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 2000,
      max_memory_restart: "1G",

      // Never auto-restart on file changes on a production trading box.
      watch: false,

      merge_logs: true,
      time: true,
      // Log files default to PM2's own ~/.pm2/logs/<name>-{out,error}.log —
      // left unset so this config carries no machine-specific absolute paths.
    },
  ],
};
