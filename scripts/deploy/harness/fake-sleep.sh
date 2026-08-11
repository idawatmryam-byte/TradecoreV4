#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${DEPLOY_FAKE_CLOCK_FILE:-}" ]]; then
  current="$(<"$DEPLOY_FAKE_CLOCK_FILE")"
  printf '%s' "$((current + ${1:-0}))" > "$DEPLOY_FAKE_CLOCK_FILE"
fi
