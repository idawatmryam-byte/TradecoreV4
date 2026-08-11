#!/usr/bin/env bash
# Shared, sourceable deployment helpers. No function in this file mutates Git.

deploy_log() { printf '\n\033[1;36m[update:stage2]\033[0m %s\n' "$*"; }
deploy_warn() { printf '\n\033[1;33m[update:stage2] WARNING:\033[0m %s\n' "$*"; }

require_positive_integer() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$name must be a positive integer (received: $value)" >&2
    return 1
  fi
}

redact_readiness_body() {
  local body="$1"
  # Health responses are intentionally non-secret, but cap logged output so a
  # broken proxy cannot flood deployment logs with an arbitrary response.
  printf '%s' "${body:0:8192}" | tr '\r\n' ' '
}

classify_readiness_response() {
  local http_code="$1"
  local body="$2"
  if [[ "$http_code" == "200" ]] && [[ "$body" =~ \"ready\"[[:space:]]*:[[:space:]]*true ]]; then
    printf 'ready'
  elif [[ "$http_code" == "000" ]]; then
    printf 'api_unavailable'
  elif [[ "$body" =~ \"reason\"[[:space:]]*:[[:space:]]*\"database_unhealthy\" ]] \
    || [[ "$body" =~ \"database\"[[:space:]]*:[[:space:]]*\"unreachable\" ]]; then
    printf 'database_unhealthy'
  elif [[ "$body" =~ \"reason\"[[:space:]]*:[[:space:]]*\"engine_resume_pending\" ]] \
    || [[ "$body" =~ \"status\"[[:space:]]*:[[:space:]]*\"pending\" ]]; then
    printf 'engine_resume_pending'
  elif [[ "$body" =~ \"reason\"[[:space:]]*:[[:space:]]*\"engine_resume_failed\" ]] \
    || [[ "$body" =~ \"status\"[[:space:]]*:[[:space:]]*\"degraded\" ]]; then
    printf 'engine_resume_failed'
  else
    printf 'readiness_failed'
  fi
}

WAIT_LAST_STATE="not_checked"
WAIT_FINAL_BODY=""
WAIT_FINAL_HTTP_CODE="000"
WAIT_TIMED_OUT=0

deploy_now_seconds() {
  if [[ -n "${DEPLOY_FAKE_CLOCK_FILE:-}" ]]; then
    printf '%s' "$(<"$DEPLOY_FAKE_CLOCK_FILE")"
  else
    printf '%s' "$SECONDS"
  fi
}

read_endpoint() {
  local url="$1"
  local max_time_seconds="$2"
  local body_file
  local http_code
  body_file="$(mktemp "${TMPDIR:-/tmp}/tradecore-health.XXXXXX")"
  if http_code="$("${CURL_BIN:-curl}" --silent --show-error --max-time "$max_time_seconds" \
    --output "$body_file" --write-out '%{http_code}' "$url")"; then
    :
  else
    http_code="000"
  fi
  WAIT_FINAL_BODY="$(<"$body_file")"
  WAIT_FINAL_HTTP_CODE="$http_code"
  rm -f -- "$body_file"
}

wait_for_liveness() {
  local url="$1"
  local timeout_seconds="$2"
  local interval_seconds="$3"
  local request_timeout_seconds="$4"
  local deadline=$(( $(deploy_now_seconds) + timeout_seconds ))
  local now
  local remaining
  local request_timeout

  WAIT_LAST_STATE="api_unavailable"
  WAIT_TIMED_OUT=0
  while true; do
    now="$(deploy_now_seconds)"
    if (( now >= deadline )); then break; fi
    remaining=$((deadline - now))
    request_timeout="$request_timeout_seconds"
    if (( request_timeout > remaining )); then request_timeout="$remaining"; fi
    read_endpoint "$url" "$request_timeout"
    if [[ "$WAIT_FINAL_HTTP_CODE" == "200" ]]; then
      WAIT_LAST_STATE="live"
      return 0
    fi
    WAIT_LAST_STATE="api_unavailable"
    now="$(deploy_now_seconds)"
    if (( now >= deadline )); then break; fi
    remaining=$((deadline - now))
    if (( interval_seconds > remaining )); then
      "${SLEEP_BIN:-sleep}" "$remaining"
    else
      "${SLEEP_BIN:-sleep}" "$interval_seconds"
    fi
  done
  WAIT_TIMED_OUT=1
  echo "API unavailable after ${timeout_seconds}s: $url (HTTP $WAIT_FINAL_HTTP_CODE)" >&2
  echo "Final liveness response: $(redact_readiness_body "$WAIT_FINAL_BODY")" >&2
  return 1
}

wait_for_readiness() {
  local url="$1"
  local timeout_seconds="$2"
  local interval_seconds="$3"
  local request_timeout_seconds="$4"
  local deadline=$(( $(deploy_now_seconds) + timeout_seconds ))
  local now
  local remaining
  local request_timeout

  WAIT_LAST_STATE="not_checked"
  WAIT_TIMED_OUT=0
  while true; do
    now="$(deploy_now_seconds)"
    if (( now >= deadline )); then break; fi
    remaining=$((deadline - now))
    request_timeout="$request_timeout_seconds"
    if (( request_timeout > remaining )); then request_timeout="$remaining"; fi
    read_endpoint "$url" "$request_timeout"
    WAIT_LAST_STATE="$(classify_readiness_response "$WAIT_FINAL_HTTP_CODE" "$WAIT_FINAL_BODY")"
    if [[ "$WAIT_LAST_STATE" == "ready" ]]; then return 0; fi

    # Engine discovery/start completed with a real failure. Waiting longer does
    # not turn that boot attempt healthy and would hide the actionable state.
    if [[ "$WAIT_LAST_STATE" == "engine_resume_failed" ]]; then
      echo "Readiness failed: engine resume is degraded (HTTP $WAIT_FINAL_HTTP_CODE)." >&2
      echo "Final readiness response: $(redact_readiness_body "$WAIT_FINAL_BODY")" >&2
      return 1
    fi
    now="$(deploy_now_seconds)"
    if (( now >= deadline )); then break; fi
    remaining=$((deadline - now))
    if (( interval_seconds > remaining )); then
      "${SLEEP_BIN:-sleep}" "$remaining"
    else
      "${SLEEP_BIN:-sleep}" "$interval_seconds"
    fi
  done

  WAIT_TIMED_OUT=1
  echo "Readiness timed out after ${timeout_seconds}s; final state=$WAIT_LAST_STATE (HTTP $WAIT_FINAL_HTTP_CODE)." >&2
  echo "Final readiness response: $(redact_readiness_body "$WAIT_FINAL_BODY")" >&2
  return 1
}

verify_database_security() {
  local migration_url="$1"
  local owner_role="$2"
  local app_role="$3"
  local verify_script="$4"
  "${PSQL_BIN:-psql}" "$migration_url" -v ON_ERROR_STOP=1 \
    -v owner_role="$owner_role" -v app_role="$app_role" -f "$verify_script"
}

rollback_readiness_outcome() {
  if [[ "$WAIT_LAST_STATE" == "ready" ]]; then
    printf 'healthy'
  elif [[ "$WAIT_TIMED_OUT" -eq 1 && "$WAIT_LAST_STATE" == "engine_resume_pending" ]]; then
    printf 'pending'
  else
    printf 'readiness_failed'
  fi
}
