#!/usr/bin/env bash
#
# TradeCore Pro — one-command VPS update.
#
# Run this on the VPS every time new code lands on GitHub. It does:
#   git pull → install deps → apply DB schema → build frontend + backend → restart
#
# This is an UPDATE helper, NOT first-time setup. Do the initial bootstrap
# (create DB, set env vars, first build) once by following docs/HANDOFF.md.
# After that, "get the latest" is just:  bash update.sh
#
# ── Configuration ────────────────────────────────────────────────────────────
# The build/schema steps need a few env vars (PORT, BASE_PATH, DATABASE_URL).
# This script loads them from a `.env` file at the repo root if one exists;
# otherwise it uses whatever is already exported in your shell.
#
# The restart step depends on how YOU run the server. In priority order:
#   1. RESTART_CMD  — set this to the exact command that restarts your service
#                     (e.g. RESTART_CMD="pm2 restart tradecore"). Most reliable.
#   2. pm2          — if installed, restarts the app named $PM2_APP (default
#                     "tradecore").
#   3. systemd      — else restarts the unit named $SERVICE_NAME (default
#                     "tradecore").
#   4. otherwise    — prints a reminder to restart manually.
# Set any of these in your .env so you never have to think about it again.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

log() { printf '\n\033[1;36m[update]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[update] WARNING:\033[0m %s\n' "$*"; }

# ── Load .env (if present) so build/schema steps see the config ──────────────
if [[ -f .env ]]; then
  log "loading .env"
  set -a; # shellcheck disable=SC1091
  . ./.env; set +a
fi

BASE_PATH="${BASE_PATH:-/}"
BUILD_PORT="${PORT:-8080}"   # build-time only; the server reads the real PORT at runtime
PM2_APP="${PM2_APP:-tradecore}"
SERVICE_NAME="${SERVICE_NAME:-tradecore}"

# ── 1. Pull latest (fast-forward only — never silently merge/diverge) ────────
log "pulling latest from origin/main"
git fetch origin main
git pull --ff-only origin main

# ── 2. Install dependencies (in case package.json / lockfile changed) ────────
log "installing dependencies (pnpm install)"
pnpm install

# ── 3. Apply DB schema (additive changes auto-apply; destructive ones prompt) ─
if [[ -n "${DATABASE_URL:-}" ]]; then
  log "applying DB schema (drizzle-kit push)"
  pnpm --filter @workspace/db run push
else
  warn "DATABASE_URL not set — skipping schema push. Run it manually if the schema changed."
fi

# ── 4. Build — frontend FIRST (the backend build copies it into dist/public) ──
log "building frontend"
PORT="$BUILD_PORT" BASE_PATH="$BASE_PATH" pnpm --filter @workspace/tradecore-pro run build

log "building backend"
pnpm --filter @workspace/api-server run build

# ── 5. Restart the service ───────────────────────────────────────────────────
log "restarting service"
if [[ -n "${RESTART_CMD:-}" ]]; then
  echo "  using RESTART_CMD: $RESTART_CMD"
  eval "$RESTART_CMD"
elif command -v pm2 >/dev/null 2>&1 && pm2 describe "$PM2_APP" >/dev/null 2>&1; then
  echo "  pm2 restart $PM2_APP"
  pm2 restart "$PM2_APP"
elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "$SERVICE_NAME.service" 2>/dev/null | grep -q "$SERVICE_NAME"; then
  echo "  systemctl restart $SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
else
  warn "couldn't auto-detect how to restart the server."
  echo "  Build is up to date, but the RUNNING process is still the old one."
  echo "  Restart it yourself, or set RESTART_CMD in .env (e.g. RESTART_CMD=\"pm2 restart tradecore\")."
  exit 0
fi

log "done — latest code is built and running."
