# TradeCore Pro

A Binance Spot algorithmic trading bot dashboard with real-time scanner, adaptive learning engine, risk management, and performance analytics.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/tradecore-pro run dev` — run the frontend (port 19691)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: see `.env.example` — `DATABASE_URL`, `BINANCE_API_KEY`/`BINANCE_API_SECRET`, `API_AUTH_TOKEN`, `SESSION_SECRET` (production only). Server refuses to boot if any are missing/invalid (`lib/env.ts`).

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, TailwindCSS, Recharts, React Query
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth)
- `lib/db/src/schema/` — DB tables: trades, botConfig, botMemory (blacklist + hourlyStats)
- `artifacts/api-server/src/lib/botEngine.ts` — Trading bot engine (scanner, entry/exit, adaptive learning)
- `artifacts/api-server/src/routes/` — API route handlers
- `artifacts/tradecore-pro/src/` — React frontend (cockpit, trade log, analytics, memory core, settings)

## Architecture decisions

- Bot engine runs as an in-process singleton inside the API server; simulates Binance market data in testnet/demo mode without requiring API keys.
- Adaptive learning: blacklist (win rate < 40% over last 10 trades → 24h ban) and toxic hour filter (negative cumulative PnL in last 3 days → skip that UTC hour).
- Circuit breaker: daily PnL ≤ -dailyLossLimitUsdt halts NEW entries only until midnight UTC — existing open positions keep getting full exit-monitoring (SL/TP/timeout/trailing/reconciliation) the whole time (Phase 5B fix; previously the whole scan returned early and existing positions went unmonitored too — see CHANGES.md).
- Startup reconciliation (Phase 5B): on every `start()`, before the scan loop begins, the bot compares Exchange ⟷ Database ⟷ in-memory order tracking for every DB "open" trade, restores in-memory order-ID tracking (which is otherwise empty after any restart), re-places protection if a position is found completely unprotected, and closes (reason `reconciled_missing`) any DB-open trade the exchange balance no longer backs. See `botEngine.reconcileOnStartup()`.
- Hourly stats use a single atomic upsert (ON CONFLICT DO UPDATE) to prevent double-counting.
- All API contracts defined in OpenAPI first; codegen produces React Query hooks and Zod schemas.
- Security (Phase 5B): every route except `/healthz` and `/auth/*` requires a session cookie (web dashboard, via `POST /auth/login`) or `Authorization: Bearer <API_AUTH_TOKEN>` (scripts). Single shared operator credential, not multi-user RBAC — see `middleware/auth.ts`. CORS is an explicit allow-list (`ALLOWED_ORIGINS`, empty by default), not `cors()` with no options.

## Product

- **Cockpit (`/`)**: Bot start/stop, live scanner table (updates every 15s), open positions, daily PnL/win rate.
- **Trade Log (`/trades`)**: Full trade history filterable by status (open/closed/stopped).
- **Analytics (`/stats`)**: Win rate, total PnL, max drawdown, hourly heatmap (toxic hours highlighted), streak tracker.
- **Memory Core (`/memory`)**: Active blacklisted symbols and blocked toxic hours.
- **Configuration (`/settings`)**: All bot parameters — position size, max positions, daily loss limit, Stop Loss %/Take Profit %, pairs list, testnet toggle.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- After any `lib/*` schema change, run `pnpm run typecheck:libs` before leaf artifact typechecks.
- After any OpenAPI spec change, run `pnpm --filter @workspace/api-spec run codegen` then `pnpm run typecheck:libs`.
- Bot engine state (running/stopped) resets on API server restart — trades and config persist in DB, and `reconcileOnStartup()` (Phase 5B) rebuilds in-memory order tracking and verifies exchange state for any trade that was open when the process stopped. Before Phase 5B, in-memory order-ID tracking silently started empty on restart, breaking trailing-stop/TP1/TP2 order replacement for pre-existing positions until reconciliation next touched them.
- The unique constraint `(date, hour)` on `hourly_stats` is required for correct PnL aggregation; always use the upsert pattern.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
