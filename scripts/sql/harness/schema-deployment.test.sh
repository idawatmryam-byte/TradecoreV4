#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

: "${DATABASE_MIGRATION_URL:?DATABASE_MIGRATION_URL is required}"
PSQL_BIN="${PSQL_BIN:-psql}"

psql_owner() {
  "$PSQL_BIN" "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 "$@"
}

# CI prepares a partial pre-Phase-10 database whose blacklist table is already
# populated and whose exact constraint key is valid. Its physical column order
# deliberately differs from the constraint key order. Drizzle 0.31.10's old
# constraint_column_usage query follows the former and therefore proposes a
# duplicate create_unique_constraint statement and opens the truncate prompt.
constraint_columns="$(psql_owner -Atqc "
  SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text
  FROM pg_constraint constraint_record
  CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS key(attnum, ordinality)
  JOIN pg_attribute attribute
    ON attribute.attrelid = constraint_record.conrelid
   AND attribute.attnum = key.attnum
  WHERE constraint_record.conrelid = 'public.blacklist_entries'::regclass
    AND constraint_record.conname = 'blacklist_user_section_symbol_unique'
")"
legacy_introspection_columns="$(psql_owner -Atqc "
  SELECT array_agg(column_name)::text
  FROM (
    SELECT c.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage AS ccu
      USING (constraint_schema, constraint_name)
    JOIN information_schema.columns AS c
      ON c.table_schema = tc.constraint_schema
     AND tc.table_name = c.table_name
     AND ccu.column_name = c.column_name
    WHERE tc.table_name = 'blacklist_entries'
      AND constraint_schema = 'public'
      AND constraint_name = 'blacklist_user_section_symbol_unique'
  ) legacy_query
")"
[[ "$constraint_columns" == '{user_id,section,symbol}' ]]
if [[ "$legacy_introspection_columns" == "$constraint_columns" ]]; then
  echo "FAIL: fixture did not reproduce the legacy Drizzle introspection mismatch" >&2
  exit 1
fi
printf '✓  reproduced legacy Drizzle ordering drift: constraint=%s introspection=%s\n' \
  "$constraint_columns" "$legacy_introspection_columns"

before_state="$(psql_owner -Atqc "
  SELECT count(*) || ':' || md5(string_agg(
    user_id || ':' || section || ':' || symbol || ':' || win_rate || ':' || trade_count,
    ',' ORDER BY id
  ))
  FROM public.blacklist_entries
  WHERE symbol LIKE 'PHASE10-REGRESSION-%'
")"
duplicate_groups="$(psql_owner -Atqc "
  SELECT count(*) FROM (
    SELECT user_id, section, symbol
    FROM public.blacklist_entries
    GROUP BY user_id, section, symbol
    HAVING count(*) > 1
  ) duplicates
")"
[[ "$before_state" == 38:* ]]
[[ "$duplicate_groups" == "0" ]]

# Source only pure deployment helpers; no Git, service, or production action.
# shellcheck source=../../deploy/lib.sh
. scripts/deploy/lib.sh
schema_log="$(mktemp "${TMPDIR:-/tmp}/tradecore-schema-integration.XXXXXX")"
trap 'rm -f -- "$schema_log"' EXIT
if ! apply_database_schema \
  "$DATABASE_MIGRATION_URL" \
  scripts/sql/reconcile-blacklist-constraint.sql \
  scripts/sql/verify-deployment-schema.sql \
  pnpm --filter @workspace/db run push \
  >"$schema_log" 2>&1; then
  cat "$schema_log" >&2
  exit 1
fi
cat "$schema_log"

if grep -Eiq "Do you want to truncate|You're about to add .* unique constraint|All changes were aborted" "$schema_log"; then
  echo "FAIL: schema application emitted interactive/destructive output" >&2
  exit 1
fi

after_state="$(psql_owner -Atqc "
  SELECT count(*) || ':' || md5(string_agg(
    user_id || ':' || section || ':' || symbol || ':' || win_rate || ':' || trade_count,
    ',' ORDER BY id
  ))
  FROM public.blacklist_entries
  WHERE symbol LIKE 'PHASE10-REGRESSION-%'
")"
[[ "$after_state" == "$before_state" ]]

phase10_table_count="$(psql_owner -Atqc "
  SELECT count(*)
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'brain_versions',
      'demo_autopilot_mandates',
      'autopilot_mandate_states',
      'autopilot_controls',
      'autopilot_decision_claims',
      'autopilot_events'
    )
")"
[[ "$phase10_table_count" == "6" ]]

printf '✓  populated blacklist_entries preserved exactly (%s rows)\n' "${after_state%%:*}"
printf '✓  existing unique constraint required no interactive prompt\n'
printf '✓  non-interactive schema application created all Phase 10 tables\n'
printf '\nschema deployment PostgreSQL harness: all checks passed\n'
