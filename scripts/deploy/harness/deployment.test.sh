#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../lib.sh
. "$REPO_ROOT/scripts/deploy/lib.sh"

failures=0
expect() {
  local name="$1"
  local condition="$2"
  if [[ "$condition" == "1" ]]; then
    printf '✓  %s\n' "$name"
  else
    printf '✗ FAIL  %s\n' "$name"
    failures=$((failures + 1))
  fi
}

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tradecore-deploy-test.XXXXXX")"
cleanup() { rm -rf -- "$TEST_DIR"; }
trap cleanup EXIT

responses="$TEST_DIR/readiness-responses"
state="$TEST_DIR/readiness-state"
clock="$TEST_DIR/readiness-clock"
printf '0' > "$clock"
for _ in $(seq 1 31); do
  printf '503|{"ready":false,"reason":"engine_resume_pending","checks":{"database":"ok","engineResume":{"status":"pending"}}}\n' >> "$responses"
done
printf '200|{"ready":true,"reason":"ready"}\n' >> "$responses"
export FAKE_CURL_RESPONSES="$responses"
export FAKE_CURL_STATE="$state"
export CURL_BIN="$REPO_ROOT/scripts/deploy/harness/fake-curl.sh"
export SLEEP_BIN="$REPO_ROOT/scripts/deploy/harness/fake-sleep.sh"
export DEPLOY_FAKE_CLOCK_FILE="$clock"
chmod +x "$CURL_BIN" "$SLEEP_BIN"

slow_ready=0
if wait_for_readiness "http://test/api/readyz" 180 2 5; then slow_ready=1; fi
calls="$(<"$state")"
expect "startup taking more than 60s but less than 180s succeeds" "$slow_ready"
expect "readiness test crossed the former 30-attempt limit" "$([[ "$calls" -eq 32 ]] && echo 1 || echo 0)"
expect "rollback with slow successful resume is healthy, not failed" "$([[ "$(rollback_readiness_outcome)" == "healthy" ]] && echo 1 || echo 0)"

pending_body='{"ready":false,"reason":"engine_resume_pending","checks":{"engineResume":{"status":"pending"}}}'
failed_body='{"ready":false,"reason":"engine_resume_failed","checks":{"engineResume":{"status":"degraded"}}}'
expect "readiness pending has an explicit classification" "$([[ "$(classify_readiness_response 503 "$pending_body")" == "engine_resume_pending" ]] && echo 1 || echo 0)"
expect "readiness failure has an explicit classification" "$([[ "$(classify_readiness_response 503 "$failed_body")" == "engine_resume_failed" ]] && echo 1 || echo 0)"
expect "API unavailability has an explicit classification" "$([[ "$(classify_readiness_response 000 '')" == "api_unavailable" ]] && echo 1 || echo 0)"
database_body='{"ready":false,"reason":"database_unhealthy","checks":{"database":"unreachable"}}'
expect "database failure has an explicit classification" "$([[ "$(classify_readiness_response 503 "$database_body")" == "database_unhealthy" ]] && echo 1 || echo 0)"
expect "production deployment defaults global Demo Autopilot suspension fail-closed" \
  "$([[ "$(normalize_autopilot_global_suspended '')" == "true" ]] && echo 1 || echo 0)"
expect "an explicit reviewed false suspension value is preserved" \
  "$([[ "$(normalize_autopilot_global_suspended false)" == "false" ]] && echo 1 || echo 0)"
invalid_suspension_refused=0
if ! normalize_autopilot_global_suspended invalid >/dev/null 2>&1; then invalid_suspension_refused=1; fi
expect "invalid global suspension configuration cannot fail open" "$invalid_suspension_refused"

printf '0' > "$state"
printf '0' > "$clock"
printf '503|%s\n' "$pending_body" > "$responses"
timed_out=0
if ! wait_for_readiness "http://test/api/readyz" 6 2 5 2>"$TEST_DIR/timeout.log"; then timed_out=1; fi
expect "actual readiness timeout is explicit" "$([[ "$timed_out" -eq 1 && "$WAIT_TIMED_OUT" -eq 1 ]] && echo 1 || echo 0)"
expect "timeout preserves the final pending response body" "$([[ "$WAIT_FINAL_BODY" == *engine_resume_pending* ]] && echo 1 || echo 0)"
expect "timeout logs the final readiness response" "$(grep -q 'Final readiness response' "$TEST_DIR/timeout.log" && echo 1 || echo 0)"
WAIT_LAST_STATE="engine_resume_pending"
WAIT_TIMED_OUT=1
expect "rollback pending is distinct from rollback mechanics failure" "$([[ "$(rollback_readiness_outcome)" == "pending" ]] && echo 1 || echo 0)"
WAIT_LAST_STATE="engine_resume_failed"
WAIT_TIMED_OUT=0
expect "rollback degraded resume is a genuine readiness failure" "$([[ "$(rollback_readiness_outcome)" == "readiness_failed" ]] && echo 1 || echo 0)"

fixture="$TEST_DIR/updater-fixture"
remote="$TEST_DIR/updater-remote.git"
mkdir -p "$fixture/scripts/deploy"
git -C "$fixture" init -q -b main
git -C "$fixture" config user.name "TradeCore deploy harness"
git -C "$fixture" config user.email "deploy-harness@example.invalid"
cp "$REPO_ROOT/update.sh" "$fixture/update.sh"
printf '#!/usr/bin/env bash\nprintf old > "%s"\n' "$TEST_DIR/stage-marker" > "$fixture/scripts/deploy/deploy-target.sh"
git -C "$fixture" add update.sh scripts/deploy/deploy-target.sh
git -C "$fixture" commit -q -m old
old_commit="$(git -C "$fixture" rev-parse HEAD)"
git clone -q --bare "$fixture" "$remote"
git -C "$fixture" remote add origin "$remote"
printf '#!/usr/bin/env bash\nprintf target > "%s"\n' "$TEST_DIR/stage-marker" > "$fixture/scripts/deploy/deploy-target.sh"
git -C "$fixture" add scripts/deploy/deploy-target.sh
git -C "$fixture" commit -q -m target
git -C "$fixture" push -q origin main
git -C "$fixture" reset -q --hard "$old_commit"
TRADECORE_REPO_ROOT="$fixture" bash "$fixture/update.sh" origin/main >/dev/null
marker="$(<"$TEST_DIR/stage-marker")"
expect "target revision updater executes instead of stale launcher logic" "$([[ "$marker" == "target" ]] && echo 1 || echo 0)"

security_psql="$TEST_DIR/security-psql.sh"
security_calls="$TEST_DIR/security-calls"
printf '#!/usr/bin/env bash\nprintf '\''%%s\\n'\'' "$*" >> "$DEPLOY_SECURITY_CALLS"\n' > "$security_psql"
chmod +x "$security_psql"
export DEPLOY_SECURITY_CALLS="$security_calls"
PSQL_BIN="$security_psql"
apply_post_schema_database_security \
  "postgres://redacted" owner runtime capture-grants.sql verify-database-roles.sql
expect "regular post-schema security installs grants on an already-hardened database" \
  "$(grep -q -- '-f capture-grants.sql' "$security_calls" && echo 1 || echo 0)"
expect "regular post-schema security always runs the strict verifier" \
  "$(grep -q -- '-f verify-database-roles.sql' "$security_calls" && echo 1 || echo 0)"

fake_psql="$TEST_DIR/failing-psql.sh"
printf '#!/usr/bin/env bash\nexit 4\n' > "$fake_psql"
chmod +x "$fake_psql"
PSQL_BIN="$fake_psql"
blocked=0
if ! verify_database_security "postgres://redacted" owner runtime verify.sql; then blocked=1; fi
expect "database security verification failure blocks deployment" "$blocked"

if ((failures == 0)); then
  printf '\ndeployment harness: all checks passed\n'
else
  printf '\ndeployment harness: %s FAILED\n' "$failures"
fi
exit "$failures"
