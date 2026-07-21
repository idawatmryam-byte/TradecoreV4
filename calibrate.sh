#!/usr/bin/env bash
#
# calibrate.sh — one-command wrapper for the default strategy calibration.
#
# Fills in sensible defaults so you (or the VPS Claude) don't have to remember
# the flags. It only PROPOSES better default values — it never changes code or
# live configs. Read docs/STRATEGY_CALIBRATION.md for the full method.
#
#   ./calibrate.sh                         # crypto, all strategies, last 12 months
#   ./calibrate.sh crypto                  # same
#   ./calibrate.sh forex                   # forex catalog
#   ./calibrate.sh crypto trend_pullback   # just one strategy (much faster — start here)
#
# Override any default with an env var:
#   SYMBOLS=BTCUSDT,ETHUSDT  TIMEFRAME=15m  FOLDS=4  MONTHS=18  ./calibrate.sh crypto
#   START=2023-01-01 END=2023-12-31 ./calibrate.sh crypto   # explicit window
#
# ⚠ Run this on the VPS against REAL data. In a sandbox with synthetic candles
#   the machinery runs but the trading conclusions are meaningless.
set -euo pipefail

SECTION="${1:-crypto}"
STRATEGY="${2:-}"

if [[ "$SECTION" != "crypto" && "$SECTION" != "forex" ]]; then
  echo "Usage: ./calibrate.sh [crypto|forex] [optional-strategy-id]" >&2
  echo "  e.g. ./calibrate.sh crypto trend_pullback" >&2
  exit 2
fi

# Resolve paths relative to THIS script, so it works from any directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$SCRIPT_DIR/artifacts/api-server"
TSX="$SCRIPT_DIR/scripts/node_modules/.bin/tsx"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set — point it at your live database." >&2
  echo "  export DATABASE_URL=postgresql://...   then re-run." >&2
  exit 1
fi
if [[ ! -x "$TSX" ]]; then
  echo "ERROR: tsx not found at $TSX — run 'pnpm install' first." >&2
  exit 1
fi

# Per-section sensible defaults (override via env).
if [[ "$SECTION" == "forex" ]]; then
  SYMBOLS="${SYMBOLS:-EUR_USD,GBP_USD,XAU_USD}"
  TIMEFRAME="${TIMEFRAME:-15m}"
else
  SYMBOLS="${SYMBOLS:-BTCUSDT,ETHUSDT,SOLUSDT}"
  TIMEFRAME="${TIMEFRAME:-5m}"
fi
FOLDS="${FOLDS:-3}"
MONTHS="${MONTHS:-12}"
# End the window a few days BACK, not today: the most recent candles are often
# partial or not-yet-downloaded, and the final fold runs right up to the cutoff
# — so a trailing-to-today window calibrates that last fold on thin, half-formed
# data. A small buffer keeps the last fold honest. Set BUFFER_DAYS=0 to run
# right up to now.
BUFFER_DAYS="${BUFFER_DAYS:-7}"

# Trailing window, ending BUFFER_DAYS ago, unless START/END are given explicitly.
END="${END:-$(date -u -d "${BUFFER_DAYS} days ago" +%Y-%m-%d 2>/dev/null || date -u -v-"${BUFFER_DAYS}"d +%Y-%m-%d)}"
START="${START:-$(date -u -d "${END} -${MONTHS} months" +%Y-%m-%d 2>/dev/null || date -u -v-"${MONTHS}"m +%Y-%m-%d)}"

echo "─────────────────────────────────────────────────────────────"
echo " Default calibration"
echo "   section:    $SECTION"
echo "   symbols:    $SYMBOLS"
echo "   timeframe:  $TIMEFRAME"
echo "   window:     $START → $END   (${FOLDS} folds)"
[[ -n "$STRATEGY" ]] && echo "   strategy:   $STRATEGY (single)"
echo "   proposes only — nothing is applied automatically."
echo "─────────────────────────────────────────────────────────────"
echo

cd "$API_DIR"
exec "$TSX" harness/calibrate-defaults.ts \
  --section "$SECTION" \
  --symbols "$SYMBOLS" \
  --timeframe "$TIMEFRAME" \
  --start "$START" \
  --end "$END" \
  --folds "$FOLDS" \
  ${STRATEGY:+--strategy "$STRATEGY"}
