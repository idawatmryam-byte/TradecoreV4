# Architecture

TradeCore Pro is a pnpm monorepo split into a typed API contract, a backend
trading engine, and a React dashboard. This document gives a working mental
model of how the system fits together.

## Monorepo layout

```
artifacts/
  api-server/        Express API, trading engine, backtest engine, strategies
  tradecore-pro/     React dashboard (Vite + Tailwind + shadcn/ui)
lib/
  db/                Drizzle schema + client (the DB source of truth)
  api-spec/          OpenAPI spec (the API contract source of truth)
  api-zod/           GENERATED Zod schemas (from api-spec) — do not hand-edit
  api-client-react/  GENERATED typed React Query hooks — do not hand-edit
scripts/             repo tooling
```

### Contract-first API

`lib/api-spec/openapi.yaml` is the single source of truth for the HTTP API.
Running orval regenerates two packages from it:

- `@workspace/api-zod` — request/response validators used by the Express routes.
- `@workspace/api-client-react` — typed TanStack Query hooks used by the frontend.

Because both sides are generated from one spec, the frontend and backend can
never silently drift. **After editing `openapi.yaml`, always regenerate:**

```bash
pnpm --filter @workspace/api-spec exec orval
```

### Database

`lib/db` owns the Drizzle schema (`src/schema/*`) and is the source of truth for
the database shape. Apply schema changes with:

```bash
pnpm --filter @workspace/db run push
```

Every table is per-user scoped (`userId`), including `bot_config`,
`strategy_configs`, `trades`, `backtest_runs`, blacklist, and hourly stats.

## Backend: the trading engine

The core is `artifacts/api-server/src/lib/botEngine.ts` — one `BotEngine`
instance **per user** (see `engineRegistry.ts`), each isolated to that user's
config, credentials, trades, and strategy tuning.

### The scan loop

`BotEngine.start()` opens the exchange connection (ccxt: `binance` for spot,
`binanceusdm` for futures), reconciles any already-open positions, and starts
two timers:

- A **ticker poller** (fast, for the live dashboard).
- A **scan loop** (`runScan()`, every `scanIntervalSeconds`) — the heartbeat.

Each scan, for every configured symbol:

```
runScan()
  ├─ load config, refresh daily state, check circuit breaker
  ├─ fetch 1m/3m/5m/15m/1h candles (per-symbol, failures isolated)
  ├─ buildSignalRow()            → indicators, regime, macro filter, confidence
  ├─ risk pre-checks             → blacklist, cooldown, max positions, toxic hour,
  │                                circuit breaker, risk pause
  ├─ strategySelector.evaluate() → run every enabled strategy for the regime
  ├─ post-signal risk checks     → strategy concurrency, position size, portfolio risk
  ├─ enterTrade()                → market entry + SL/TP protection (see below)
  └─ SCAN_SUMMARY log            → funnel of scanned/signalled/entered/blocked
```

Every symbol's path is recorded as a **decision trace** (Market Data →
Indicators → Signal → Risk Checks → Order) exposed at `GET /bot/decisions`, and
aggregated at `GET /bot/blocking-summary` — this is what powers the dashboard's
"why is / isn't it trading" panels.

### Strategies

`artifacts/api-server/src/lib/strategies/` holds the pluggable strategies, each
implementing the `Strategy` interface (`base.ts`): a `supportedRegimes` gate and
an `evaluate()` that returns a signal or `null`. The `StrategySelector` runs
every enabled strategy whose regime matches, applies a shared
net-reward:risk-after-cost gate, and ranks the results by confidence.

Strategies never decide *where* SL/TP sits directly — they call the shared
`computeAdaptiveSLTP()` / `computePercentSLTP()` helpers, so exits are computed
identically in live and backtest.

### Order placement and protection

`enterTrade()` is the money path. In order:

1. (Futures) set leverage/margin mode; pre-check margin sufficiency.
2. Place the market entry order.
3. Re-anchor the strategy's SL/TP to the actual fill price; **if a valid stop
   can't be formed, close the position immediately** (risk guard).
4. Write the trade to the DB — **if that write fails, close the position
   immediately** so no untracked position is left on the exchange.
5. Place exchange-side protection: an atomic OCO (spot) or paired reduceOnly
   STOP_MARKET + TAKE_PROFIT_MARKET (futures). If the stop can't be placed, the
   position is monitored by price each scan **and the user is alerted**.

### Exit management

`ExitManager` (`exitManager.ts`) is the **only** place a trade is closed. It
trusts a confirmed exchange fill first, reconciles candle-wick touches of SL/TP,
performs protective market closes, and enforces the max-holding-time exit —
then does the single `status: "closed"` DB write with full P&L/fee/slippage
accounting and a planned-vs-actual risk audit. `TradeManager` runs first each
tick to manage TP1/TP2 partials, break-even moves, and trailing stops.

Risk controls layered on top: per-trade risk sizing, portfolio-risk cap,
per-strategy concurrency, daily-loss circuit breaker, post-loss symbol
blacklist, toxic-hour avoidance, and a persisted risk-pause after repeated
violations.

## Backend: the backtest engine

`backtestEngine.ts` replays historical candles through the **same** strategy
implementations and the same SL/TP/ladder/risk logic as live — that shared code
is what makes backtest/live parity structural. It additionally models fees
(maker/taker), slippage, volatility-adaptive targets, TP1/TP2 laddering,
optional maker-entry fill/miss modeling, and (for futures) isolated-margin
liquidation. It enforces the same gates live does (max positions, per-strategy
concurrency, spot has no shorts) so a backtest reflects what live could actually
take.

## Frontend

`artifacts/tradecore-pro` is a Vite + React SPA using the generated typed hooks,
Tailwind, and shadcn/ui. `AuthGate` blocks the app behind login; `Layout`
provides the responsive shell (desktop sidebar / mobile drawer). Pages: Cockpit
(dashboard), Trade Log, Analytics, Strategies, Memory Core, Backtesting Lab, and
Configuration. All server state flows through TanStack Query with polling
intervals tuned per view.

## Request flow, end to end

```
React hook (generated)  →  /api/... (Express)  →  route (zod-validated)
   →  per-user BotEngine / backtest / DB (Drizzle)  →  Binance (ccxt)
```

Auth is a session cookie; every route except health and auth resolves a
`userId` and operates only on that user's data.
