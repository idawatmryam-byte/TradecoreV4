#!/usr/bin/env bash
#
# TradeCore Pro — Backtest-Validation Harness: one-command DB bootstrap.
#
# Idempotent: starts PostgreSQL, ensures a known-password superuser + the
# `tradecore` database, applies the Drizzle schema, and seeds the reproducible
# synthetic candles. Safe to re-run.
#
# Usage:  bash harness/setup.sh
# Then:   export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tradecore
#         <tsx> harness/run.ts --label baseline
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DB_URL="postgresql://postgres:postgres@127.0.0.1:5432/tradecore"

echo "[setup] starting postgresql…"
service postgresql start >/dev/null 2>&1 || true
sleep 2

echo "[setup] ensuring superuser password + database…"
sudo -u postgres psql -tAc "ALTER USER postgres PASSWORD 'postgres';" >/dev/null
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='tradecore'" | grep -q 1 \
  || sudo -u postgres createdb tradecore

echo "[setup] applying schema (drizzle-kit push)…"
( cd "$ROOT" && DATABASE_URL="$DB_URL" pnpm --filter @workspace/db run push )

echo "[setup] seeding synthetic candles…"
TSX="$ROOT/scripts/node_modules/.bin/tsx"
( cd "$ROOT/artifacts/api-server" && DATABASE_URL="$DB_URL" "$TSX" harness/generate-data.ts --days 14 --end 2025-06-01T00:00:00Z )

echo
echo "[setup] done. Now run:"
echo "  export DATABASE_URL=$DB_URL"
echo "  $TSX harness/run.ts --label baseline"
