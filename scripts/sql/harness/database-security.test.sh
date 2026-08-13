#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

: "${DATABASE_MIGRATION_URL:?DATABASE_MIGRATION_URL is required}"
: "${TRADECORE_DATABASE_OWNER_ROLE:?TRADECORE_DATABASE_OWNER_ROLE is required}"
: "${TRADECORE_RUNTIME_ROLE:?TRADECORE_RUNTIME_ROLE is required}"

PSQL_BIN="${PSQL_BIN:-psql}"

verify_with() {
  "$@" "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 \
    -v owner_role="$TRADECORE_DATABASE_OWNER_ROLE" \
    -v app_role="$TRADECORE_RUNTIME_ROLE" \
    -f scripts/sql/verify-database-roles.sql
}

simulate_later_schema_grant() {
  "$PSQL_BIN" "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 \
    -v app_role="$TRADECORE_RUNTIME_ROLE" \
    -f scripts/sql/harness/simulate-phase-10-privilege-drift.sql
}

apply_post_schema_security() {
  "$PSQL_BIN" "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 \
    -v owner_role="$TRADECORE_DATABASE_OWNER_ROLE" \
    -v app_role="$TRADECORE_RUNTIME_ROLE" \
    -f scripts/sql/capture-grants.sql
}

expect_verification_failure() {
  local label="$1"
  shift
  if verify_with "$@"; then
    echo "FAIL: $label verifier returned zero for an unsafe database" >&2
    exit 1
  fi
  printf '✓  %s verifier returned nonzero for unsafe privileges\n' "$label"
}

verify_with "$PSQL_BIN"
simulate_later_schema_grant
expect_verification_failure "default client" "$PSQL_BIN"
apply_post_schema_security
verify_with "$PSQL_BIN"
printf '✓  regular post-schema security repaired later-schema privilege drift\n'

if [[ "${RUN_PSQL12_COMPAT:-0}" == "1" ]]; then
  command -v docker >/dev/null 2>&1
  psql12=(docker run --rm --network host
    -v "$REPO_ROOT:/workspace:ro" -w /workspace "${PSQL12_IMAGE:-postgres:12}" psql)
  "${psql12[@]}" --version
  verify_with "${psql12[@]}"
  simulate_later_schema_grant
  expect_verification_failure "psql 12" "${psql12[@]}"
  apply_post_schema_security
  verify_with "${psql12[@]}"
  printf '✓  psql 12 pass/fail exit behavior is compatible\n'
fi

printf '\ndatabase security harness: all checks passed\n'
