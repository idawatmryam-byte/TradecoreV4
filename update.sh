#!/usr/bin/env bash
# TradeCore Pro — validated VPS update with automatic runtime rollback.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

log() { printf '\n\033[1;36m[update]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[update] WARNING:\033[0m %s\n' "$*"; }

if [[ -f .env ]]; then
  log "loading .env"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

BASE_PATH="${BASE_PATH:-/}"
BUILD_PORT="${PORT:-8080}"
PM2_APP="${PM2_APP:-}"
SERVICE_NAME="${SERVICE_NAME:-tradecore}"
HEALTH_BASE_URL="${HEALTH_BASE_URL:-http://127.0.0.1:${BUILD_PORT}}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-2}"

if [[ -n "${RESTART_CMD:-}" ]]; then
  warn "RESTART_CMD is no longer executed because shell-evaluated commands are unsafe."
  echo "Set PM2_APP/SERVICE_NAME, or set RESTART_SCRIPT to an executable operator-owned script."
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to deploy over tracked local changes. Commit or stash them first." >&2
  exit 1
fi

if [[ -z "$PM2_APP" ]] && command -v pm2 >/dev/null 2>&1; then
  for candidate in tradecore-api tradecore; do
    if pm2 describe "$candidate" >/dev/null 2>&1; then
      PM2_APP="$candidate"
      break
    fi
  done
fi
PM2_APP="${PM2_APP:-tradecore-api}"

PREVIOUS_COMMIT="$(git rev-parse HEAD)"
BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tradecore-update.XXXXXX")"
ROLLED_BACK=0

cleanup() { rm -rf -- "$BACKUP_DIR"; }
trap cleanup EXIT

if [[ -d artifacts/api-server/dist ]]; then
  cp -a artifacts/api-server/dist "$BACKUP_DIR/api-dist"
fi
if [[ -d artifacts/tradecore-pro/dist ]]; then
  cp -a artifacts/tradecore-pro/dist "$BACKUP_DIR/web-dist"
fi

restart_service() {
  if [[ -n "${RESTART_SCRIPT:-}" ]]; then
    if [[ ! -x "$RESTART_SCRIPT" ]]; then
      echo "RESTART_SCRIPT is not executable: $RESTART_SCRIPT" >&2
      return 1
    fi
    "$RESTART_SCRIPT"
  elif command -v pm2 >/dev/null 2>&1 && pm2 describe "$PM2_APP" >/dev/null 2>&1; then
    pm2 restart "$PM2_APP" --update-env
  elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "$SERVICE_NAME.service" 2>/dev/null | grep -q "^${SERVICE_NAME}\.service"; then
    sudo systemctl restart "$SERVICE_NAME"
  else
    echo "No managed service found. Set PM2_APP, SERVICE_NAME, or RESTART_SCRIPT." >&2
    return 1
  fi
}

wait_for_endpoint() {
  local endpoint="$1"
  local label="$2"
  local attempt
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if curl --fail --silent --show-error --max-time 5 "${HEALTH_BASE_URL}${endpoint}" >/dev/null; then
      log "$label verified"
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  echo "$label failed after $HEALTH_ATTEMPTS attempts: ${HEALTH_BASE_URL}${endpoint}" >&2
  return 1
}

rollback() {
  local failed_commit
  failed_commit="$(git rev-parse HEAD)"
  warn "deployment verification failed at $failed_commit; rolling runtime back to $PREVIOUS_COMMIT"
  ROLLED_BACK=1
  git reset --hard "$PREVIOUS_COMMIT"
  pnpm install --frozen-lockfile

  if [[ -d "$BACKUP_DIR/api-dist" ]]; then
    rm -rf -- artifacts/api-server/dist
    cp -a "$BACKUP_DIR/api-dist" artifacts/api-server/dist
  else
    PORT="$BUILD_PORT" BASE_PATH="$BASE_PATH" pnpm --filter @workspace/tradecore-pro run build
    pnpm --filter @workspace/api-server run build
  fi
  if [[ -d "$BACKUP_DIR/web-dist" ]]; then
    rm -rf -- artifacts/tradecore-pro/dist
    cp -a "$BACKUP_DIR/web-dist" artifacts/tradecore-pro/dist
  fi

  restart_service
  wait_for_endpoint "/api/healthz" "rollback liveness"
  wait_for_endpoint "/api/readyz" "rollback database and engine-resume readiness"
}

on_error() {
  local exit_code=$?
  local line=$1
  trap - ERR
  if [[ "$ROLLED_BACK" -eq 0 ]] && [[ "$(git rev-parse HEAD)" != "$PREVIOUS_COMMIT" ]]; then
    warn "update failed at line $line"
    rollback || warn "automatic rollback also failed; operator intervention is required"
  fi
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

log "fetching and fast-forwarding origin/main"
git fetch origin main
git merge --ff-only origin/main

log "installing the exact lockfile"
pnpm install --frozen-lockfile

log "auditing production dependencies"
pnpm audit --prod --audit-level high

log "typechecking and running the database-independent test suite"
pnpm run typecheck
pnpm --filter @workspace/api-server run test

log "building frontend and backend"
PORT="$BUILD_PORT" BASE_PATH="$BASE_PATH" pnpm --filter @workspace/tradecore-pro run build
pnpm --filter @workspace/api-server run build

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL (non-owner runtime connection) is required." >&2
  exit 1
fi
if [[ -z "${DATABASE_MIGRATION_URL:-}" ]]; then
  echo "DATABASE_MIGRATION_URL is required for production schema ownership separation." >&2
  exit 1
fi
if [[ -z "${TRADECORE_DATABASE_OWNER_ROLE:-}" || -z "${TRADECORE_RUNTIME_ROLE:-}" ]]; then
  echo "TRADECORE_DATABASE_OWNER_ROLE and TRADECORE_RUNTIME_ROLE are required." >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required for reviewed database security installation and verification." >&2
  exit 1
fi

log "applying the database schema with migration authority"
DATABASE_URL="$DATABASE_MIGRATION_URL" pnpm --filter @workspace/db run push

log "installing capture purge function and immutable-evidence grants"
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 \
  -v app_role="$TRADECORE_RUNTIME_ROLE" \
  -v owner_role="$TRADECORE_DATABASE_OWNER_ROLE" \
  -f scripts/sql/capture-grants.sql

log "verifying database owner/runtime separation and immutable evidence"
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 \
  -v app_role="$TRADECORE_RUNTIME_ROLE" \
  -v owner_role="$TRADECORE_DATABASE_OWNER_ROLE" \
  -f scripts/sql/verify-database-roles.sql

if [[ "${SEED_DEMO:-}" == "1" ]]; then
  log "refreshing the read-only demo account"
  pnpm --filter @workspace/api-server run seed:demo
fi

log "restarting the service"
restart_service
wait_for_endpoint "/api/healthz" "process liveness"
wait_for_endpoint "/api/readyz" "database and desired-engine resume readiness"

trap - ERR
log "deployment complete at $(git rev-parse HEAD)"
