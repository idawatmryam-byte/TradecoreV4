#!/usr/bin/env bash
# TradeCore Pro target-revision deployment implementation (stage 2).
set -Eeuo pipefail

REPO_ROOT="${TRADECORE_REPO_ROOT:?TRADECORE_REPO_ROOT is required}"
PREVIOUS_COMMIT="${TRADECORE_PREVIOUS_COMMIT:?TRADECORE_PREVIOUS_COMMIT is required}"
TARGET_COMMIT="${TRADECORE_TARGET_COMMIT:?TRADECORE_TARGET_COMMIT is required}"
TARGET_SCRIPT_BLOB="${TRADECORE_TARGET_SCRIPT_BLOB:?TRADECORE_TARGET_SCRIPT_BLOB is required}"
DEPLOY_BUNDLE_DIR="${TRADECORE_DEPLOY_BUNDLE_DIR:?TRADECORE_DEPLOY_BUNDLE_DIR is required}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTUAL_SCRIPT_BLOB="$(git -C "$REPO_ROOT" hash-object "$SCRIPT_DIR/deploy-target.sh")"
if [[ "$ACTUAL_SCRIPT_BLOB" != "$TARGET_SCRIPT_BLOB" ]]; then
  echo "Extracted stage-two script does not match target Git blob." >&2
  exit 1
fi
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
cd "$REPO_ROOT"

cleanup_bundle() { rm -rf -- "$DEPLOY_BUNDLE_DIR"; }
trap cleanup_bundle EXIT

if [[ -f .env ]]; then
  deploy_log "loading runtime .env"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
if [[ -f .env.deploy ]]; then
  DEPLOY_ENV_MODE="$(stat -c '%a' .env.deploy)"
  DEPLOY_ENV_MODE="${DEPLOY_ENV_MODE: -3}"
  if [[ "$DEPLOY_ENV_MODE" != "600" && "$DEPLOY_ENV_MODE" != "400" ]]; then
    echo ".env.deploy must be owner-only (mode 0600 or 0400; received $DEPLOY_ENV_MODE)." >&2
    exit 1
  fi
  deploy_log "loading deployment-only .env.deploy"
  set -a
  # shellcheck disable=SC1091
  . ./.env.deploy
  set +a
fi

BASE_PATH="${BASE_PATH:-/}"
BUILD_PORT="${PORT:-8080}"
PM2_APP="${PM2_APP:-}"
SERVICE_NAME="${SERVICE_NAME:-tradecore}"
HEALTH_BASE_URL="${HEALTH_BASE_URL:-http://127.0.0.1:${BUILD_PORT}}"
LIVENESS_TIMEOUT_SECONDS="${LIVENESS_TIMEOUT_SECONDS:-60}"
READINESS_TIMEOUT_SECONDS="${READINESS_TIMEOUT_SECONDS:-180}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-2}"
HEALTH_REQUEST_TIMEOUT_SECONDS="${HEALTH_REQUEST_TIMEOUT_SECONDS:-5}"

# An explicit true remains an emergency deployment hard stop. When the value is
# absent, the persisted platform control is authoritative and itself starts
# suspended/fails closed until two qualified operators approve a resume.
AUTOPILOT_GLOBAL_SUSPENDED="$(normalize_autopilot_global_suspended "${AUTOPILOT_GLOBAL_SUSPENDED:-}")"
if [[ "$AUTOPILOT_GLOBAL_SUSPENDED" == "database" ]]; then
  unset AUTOPILOT_GLOBAL_SUSPENDED
  deploy_log "AUTOPILOT_GLOBAL_SUSPENDED is governed by the fail-closed persisted platform control"
elif [[ "$AUTOPILOT_GLOBAL_SUSPENDED" == "false" ]]; then
  deploy_log "AUTOPILOT_GLOBAL_SUSPENDED deployment hard stop is disabled; the persisted platform control remains authoritative"
  export AUTOPILOT_GLOBAL_SUSPENDED
else
  export AUTOPILOT_GLOBAL_SUSPENDED
fi

require_positive_integer LIVENESS_TIMEOUT_SECONDS "$LIVENESS_TIMEOUT_SECONDS"
require_positive_integer READINESS_TIMEOUT_SECONDS "$READINESS_TIMEOUT_SECONDS"
require_positive_integer HEALTH_INTERVAL_SECONDS "$HEALTH_INTERVAL_SECONDS"
require_positive_integer HEALTH_REQUEST_TIMEOUT_SECONDS "$HEALTH_REQUEST_TIMEOUT_SECONDS"
if (( READINESS_TIMEOUT_SECONDS < 180 )); then
  echo "READINESS_TIMEOUT_SECONDS must be at least 180 for the current engine workload." >&2
  exit 1
fi

if [[ -n "${RESTART_CMD:-}" ]]; then
  deploy_warn "RESTART_CMD is not executed because shell-evaluated commands are unsafe."
  echo "Set PM2_APP/SERVICE_NAME, or set RESTART_SCRIPT to an executable operator-owned script." >&2
  exit 1
fi

if [[ -z "$PM2_APP" ]] && command -v pm2 >/dev/null 2>&1; then
  for candidate in tradecore-api tradecore; do
    if pm2 describe "$candidate" >/dev/null 2>&1; then PM2_APP="$candidate"; break; fi
  done
fi
PM2_APP="${PM2_APP:-tradecore-api}"

BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tradecore-update.XXXXXX")"
ROLLED_BACK=0
WORKTREE_MOVED=0
PRESERVE_BACKUP=0

cleanup_all() {
  if [[ "$PRESERVE_BACKUP" -eq 0 ]]; then
    rm -rf -- "$BACKUP_DIR"
  else
    deploy_warn "preserving rollback artifacts and metadata for operator recovery: $BACKUP_DIR"
  fi
  cleanup_bundle
}
trap cleanup_all EXIT

printf 'previous_commit=%s\ntarget_commit=%s\ntarget_stage2_blob=%s\nstarted_at=%s\n' \
  "$PREVIOUS_COMMIT" "$TARGET_COMMIT" "$TARGET_SCRIPT_BLOB" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$BACKUP_DIR/deployment-metadata"
if [[ -d artifacts/api-server/dist ]]; then cp -a artifacts/api-server/dist "$BACKUP_DIR/api-dist"; fi
if [[ -d artifacts/tradecore-pro/dist ]]; then cp -a artifacts/tradecore-pro/dist "$BACKUP_DIR/web-dist"; fi
if [[ -d artifacts/tradecore-admin/dist ]]; then cp -a artifacts/tradecore-admin/dist "$BACKUP_DIR/admin-dist"; fi

restart_service() {
  if [[ -n "${RESTART_SCRIPT:-}" ]]; then
    if [[ ! -x "$RESTART_SCRIPT" ]]; then
      echo "RESTART_SCRIPT is not executable: $RESTART_SCRIPT" >&2
      return 1
    fi
    env DATABASE_MIGRATION_URL= DATABASE_BOOTSTRAP_URL= "$RESTART_SCRIPT"
  elif command -v pm2 >/dev/null 2>&1 && pm2 describe "$PM2_APP" >/dev/null 2>&1; then
    env DATABASE_MIGRATION_URL= DATABASE_BOOTSTRAP_URL= pm2 restart "$PM2_APP" --update-env
  elif command -v systemctl >/dev/null 2>&1 \
    && systemctl list-unit-files "$SERVICE_NAME.service" 2>/dev/null | grep -q "^${SERVICE_NAME}\.service"; then
    sudo systemctl restart "$SERVICE_NAME"
  else
    echo "No managed service found. Set PM2_APP, SERVICE_NAME, or RESTART_SCRIPT." >&2
    return 1
  fi
}

restore_previous_artifacts() {
  if [[ -d "$BACKUP_DIR/api-dist" && -d "$BACKUP_DIR/web-dist" ]]; then
    rm -rf -- artifacts/api-server/dist artifacts/tradecore-pro/dist artifacts/tradecore-admin/dist
    cp -a "$BACKUP_DIR/api-dist" artifacts/api-server/dist
    cp -a "$BACKUP_DIR/web-dist" artifacts/tradecore-pro/dist
    if [[ -d "$BACKUP_DIR/admin-dist" ]]; then
      cp -a "$BACKUP_DIR/admin-dist" artifacts/tradecore-admin/dist
    fi
  else
    PORT="$BUILD_PORT" BASE_PATH="$BASE_PATH" pnpm --filter @workspace/tradecore-pro run build
    PORT="$BUILD_PORT" pnpm --filter @workspace/tradecore-admin run build
    pnpm --filter @workspace/api-server run build
  fi
}

rollback() {
  local failed_commit
  local mechanics_failed=0
  failed_commit="$(git rev-parse HEAD 2>/dev/null || printf unknown)"
  deploy_warn "deployment verification failed at $failed_commit; restoring runtime $PREVIOUS_COMMIT"
  ROLLED_BACK=1
  trap - ERR

  git reset --hard "$PREVIOUS_COMMIT" || mechanics_failed=1
  pnpm install --frozen-lockfile || mechanics_failed=1
  restore_previous_artifacts || mechanics_failed=1
  restart_service || mechanics_failed=1
  if (( mechanics_failed != 0 )); then
    PRESERVE_BACKUP=1
    deploy_warn "rollback mechanics failed before application verification; operator intervention is required"
    return 22
  fi

  if ! wait_for_liveness "${HEALTH_BASE_URL}/api/healthz" "$LIVENESS_TIMEOUT_SECONDS" \
    "$HEALTH_INTERVAL_SECONDS" "$HEALTH_REQUEST_TIMEOUT_SECONDS"; then
    PRESERVE_BACKUP=1
    deploy_warn "rollback restored the previous commit, but the application is unavailable"
    return 21
  fi
  if wait_for_readiness "${HEALTH_BASE_URL}/api/readyz" "$READINESS_TIMEOUT_SECONDS" \
    "$HEALTH_INTERVAL_SECONDS" "$HEALTH_REQUEST_TIMEOUT_SECONDS"; then
    deploy_log "automatic rollback restored a healthy previous runtime at $PREVIOUS_COMMIT"
    return 0
  fi
  if [[ "$(rollback_readiness_outcome)" == "pending" ]]; then
    PRESERVE_BACKUP=1
    deploy_warn "rollback restored the previous runtime; engine resume is still pending after the bounded readiness window"
    return 20
  fi
  PRESERVE_BACKUP=1
  deploy_warn "rollback restored the previous runtime, but readiness genuinely failed (state=$WAIT_LAST_STATE)"
  return 21
}

on_error() {
  local exit_code=$?
  local line=$1
  local rollback_code=0
  trap - ERR
  if [[ "$ROLLED_BACK" -eq 0 && "$WORKTREE_MOVED" -eq 1 ]]; then
    deploy_warn "target deployment failed at line $line"
    rollback || rollback_code=$?
    case "$rollback_code" in
      0) : ;;
      20) deploy_warn "operator follow-up required: rollback readiness remains pending, not mechanically failed" ;;
      21) deploy_warn "operator follow-up required: rollback restored the commit but application readiness failed" ;;
      22) deploy_warn "operator intervention required: rollback mechanics failed" ;;
      *) deploy_warn "operator intervention required: rollback returned unexpected status $rollback_code" ;;
    esac
  fi
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

deploy_log "advancing clean worktree from $PREVIOUS_COMMIT to exact target $TARGET_COMMIT"
git merge --ff-only "$TARGET_COMMIT"
WORKTREE_MOVED=1
[[ "$(git rev-parse HEAD)" == "$TARGET_COMMIT" ]]

deploy_log "installing the exact lockfile"
pnpm install --frozen-lockfile

deploy_log "auditing production dependencies"
pnpm audit --prod --audit-level high

deploy_log "typechecking and running the database-independent test suite"
pnpm run typecheck
pnpm --filter @workspace/api-server run test

if [[ -z "${DATABASE_URL:-}" || -z "${DATABASE_MIGRATION_URL:-}" ]]; then
  echo "DATABASE_URL (runtime) and DATABASE_MIGRATION_URL (owner) are required." >&2
  exit 1
fi
if [[ -z "${TRADECORE_DATABASE_OWNER_ROLE:-}" || -z "${TRADECORE_RUNTIME_ROLE:-}" \
  || -z "${TRADECORE_LEGACY_ROLE:-}" || -z "${TRADECORE_DATABASE_NAME:-}" ]]; then
  echo "TRADECORE_DATABASE_NAME, TRADECORE_LEGACY_ROLE, TRADECORE_DATABASE_OWNER_ROLE, and TRADECORE_RUNTIME_ROLE are required." >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required for database security installation and verification." >&2
  exit 1
fi

OWNER_INSPECTION_URL="${DATABASE_BOOTSTRAP_URL:-$DATABASE_MIGRATION_URL}"
CURRENT_DATABASE_OWNER="$(psql "$OWNER_INSPECTION_URL" -v ON_ERROR_STOP=1 -Atqc \
  "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()")"
if [[ "$CURRENT_DATABASE_OWNER" != "$TRADECORE_DATABASE_OWNER_ROLE" ]]; then
  if [[ "$CURRENT_DATABASE_OWNER" != "$TRADECORE_LEGACY_ROLE" ]]; then
    echo "Database owner is unexpected: $CURRENT_DATABASE_OWNER" >&2
    exit 1
  fi
  if [[ -z "${DATABASE_BOOTSTRAP_URL:-}" ]]; then
    echo "DATABASE_BOOTSTRAP_URL is required for the reviewed legacy ownership transfer." >&2
    exit 1
  fi
  deploy_log "transferring legacy database ownership to the migration role"
  psql "$DATABASE_BOOTSTRAP_URL" -v ON_ERROR_STOP=1 \
    -v database_name="$TRADECORE_DATABASE_NAME" \
    -v legacy_role="$TRADECORE_LEGACY_ROLE" \
    -v owner_role="$TRADECORE_DATABASE_OWNER_ROLE" \
    -v app_role="$TRADECORE_RUNTIME_ROLE" \
    -f scripts/sql/harden-database-roles.sql
fi

MIGRATION_USER="$(psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -Atqc 'SELECT current_user')"
RUNTIME_USER="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc 'SELECT current_user')"
if [[ "$MIGRATION_USER" != "$TRADECORE_DATABASE_OWNER_ROLE" ]]; then
  echo "DATABASE_MIGRATION_URL must authenticate as $TRADECORE_DATABASE_OWNER_ROLE (received $MIGRATION_USER)." >&2
  exit 1
fi
if [[ "$RUNTIME_USER" != "$TRADECORE_RUNTIME_ROLE" ]]; then
  echo "DATABASE_URL must authenticate as $TRADECORE_RUNTIME_ROLE (received $RUNTIME_USER)." >&2
  exit 1
fi

deploy_log "applying the database schema with migration authority"
apply_database_schema \
  "$DATABASE_MIGRATION_URL" \
  scripts/sql/reconcile-blacklist-constraint.sql \
  scripts/sql/verify-deployment-schema.sql \
  pnpm --filter @workspace/db run push

deploy_log "installing and verifying post-schema database security"
apply_post_schema_database_security \
  "$DATABASE_MIGRATION_URL" \
  "$TRADECORE_DATABASE_OWNER_ROLE" \
  "$TRADECORE_RUNTIME_ROLE" \
  scripts/sql/capture-grants.sql \
  scripts/sql/verify-database-roles.sql

deploy_log "building frontend and backend"
PORT="$BUILD_PORT" BASE_PATH="$BASE_PATH" pnpm --filter @workspace/tradecore-pro run build
PORT="$BUILD_PORT" pnpm --filter @workspace/tradecore-admin run build
pnpm --filter @workspace/api-server run build

if [[ "${SEED_DEMO:-}" == "1" ]]; then
  deploy_log "refreshing the read-only demo account"
  pnpm --filter @workspace/api-server run seed:demo
fi

deploy_log "restarting the service"
restart_service
wait_for_liveness "${HEALTH_BASE_URL}/api/healthz" "$LIVENESS_TIMEOUT_SECONDS" \
  "$HEALTH_INTERVAL_SECONDS" "$HEALTH_REQUEST_TIMEOUT_SECONDS"
wait_for_readiness "${HEALTH_BASE_URL}/api/readyz" "$READINESS_TIMEOUT_SECONDS" \
  "$HEALTH_INTERVAL_SECONDS" "$HEALTH_REQUEST_TIMEOUT_SECONDS"

trap - ERR
deploy_log "deployment complete at $TARGET_COMMIT"
