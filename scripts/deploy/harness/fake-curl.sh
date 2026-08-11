#!/usr/bin/env bash
set -euo pipefail

: "${FAKE_CURL_RESPONSES:?FAKE_CURL_RESPONSES is required}"
: "${FAKE_CURL_STATE:?FAKE_CURL_STATE is required}"

output_file=""
while (($#)); do
  case "$1" in
    --output)
      output_file="$2"
      shift 2
      ;;
    --max-time|--write-out)
      shift 2
      ;;
    --silent|--show-error)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

index=0
if [[ -f "$FAKE_CURL_STATE" ]]; then index="$(<"$FAKE_CURL_STATE")"; fi
index=$((index + 1))
printf '%s' "$index" > "$FAKE_CURL_STATE"
response="$(sed -n "${index}p" "$FAKE_CURL_RESPONSES")"
if [[ -z "$response" ]]; then response="$(tail -n 1 "$FAKE_CURL_RESPONSES")"; fi
http_code="${response%%|*}"
body="${response#*|}"
printf '%s' "$body" > "$output_file"
printf '%s' "$http_code"
if [[ "$http_code" == "000" ]]; then exit 7; fi
