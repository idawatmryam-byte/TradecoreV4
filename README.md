# TradeCore Pro

A self-hosted, multi-user algorithmic trading platform for **two markets, side by
side**: cryptocurrency on Binance (**Spot** and **USDⓈ-M Futures**) and **forex on
OANDA** (currency majors, gold, US index CFDs) — built around a **rigorous,
parity-verified backtesting engine**. Automate strategy execution, manage risk, and
validate ideas on real historical data before a single live order — all from a
clean real-time dashboard.

> **Honest by design.** The backtesting engine models maker/taker fees, slippage,
> and every live risk gate, so a backtest reflects what the *live* engine can
> actually achieve — not an inflated, over-fit fantasy. It is built to tell you the
> truth about a strategy, including when a strategy has no edge.

---

## Features

- **Live trading** on Binance Spot and USDⓈ-M Futures (long + short, leverage,
  isolated/cross margin) via [ccxt](https://github.com/ccxt/ccxt).
- **Independent forex section** on OANDA (v20 REST) — currency majors, gold/silver,
  and US index CFDs, running **simultaneously** with the crypto section under the
  same strategy brains and risk model. Entries are placed as a single atomic order
  with stop-loss and take-profit attached (a position can never exist unprotected),
  with DST-aware market-hours gating (weekend close, metals/index daily break),
  practice/live environments, restart-safe reconciliation, and support for any
  account home currency (non-USD balances are converted at live FX rates).
- **Multi-strategy engine** — seven pluggable strategies (trend pullback, momentum
  breakout, volatility breakout, mean reversion, VWAP reversion, micro scalping,
  1-minute scalp reversion), each with its own regime gate and risk profile.
- **Multi-timeframe market analysis** — a weighted-indicator signal builder over
  1m/3m/5m/15m/1h with market-regime detection (trend / range / volatility) and
  hysteresis to prevent whipsaw.
- **Professional risk management** — per-trade risk sizing, portfolio-risk cap,
  per-strategy concurrency limits, daily-loss circuit breaker, post-loss symbol
  cooldowns, liquidation-distance guards, and a persisted risk-pause state.
- **Rigorous backtesting** — the real engine replayed over historical candles with
  volatility-adaptive SL/TP, TP1/TP2 laddering, maker-entry fill modeling, and a
  cost-aware reward:risk gate. Live and backtest share the same strategy code for
  true parity.
- **Explainable decisions** — a per-symbol decision trace (Market Data → Indicators
  → Signal → Risk Checks → Order) and a per-scan funnel summary, so you always know
  *exactly* why a trade was or wasn't taken.
- **Real-time dashboard** — balance, open positions with live unrealized P&L, a live
  market monitor, strategy configuration, trade log with CSV export, and analytics.
- **Secure multi-user** — DB-backed accounts, hashed passwords, and encrypted
  per-user broker credentials (Binance API keys and OANDA tokens, AES-256-GCM at
  rest).
- **Fully typed end-to-end** — a single OpenAPI spec generates the Zod validators and
  the typed React Query client, so the frontend and backend can never drift.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query |
| Backend | Node.js, Express 5, TypeScript, ccxt, pino |
| Database | PostgreSQL via Drizzle ORM |
| API contract | OpenAPI → orval (generated Zod + React Query client) |
| Tooling | pnpm workspaces (monorepo), esbuild, tsx |

## Architecture

A pnpm monorepo with a clean, contract-first boundary:

```
artifacts/
  api-server/       Express API + trading engine, backtest engine, strategies
  tradecore-pro/    React dashboard (Vite)
lib/
  db/               Drizzle schema + migrations (source of truth for the DB)
  api-spec/         OpenAPI spec — the single source of truth for the API contract
  api-zod/          Generated Zod schemas (do not edit by hand)
  api-client-react/ Generated typed React Query hooks (do not edit by hand)
```

The trading engine (`artifacts/api-server/src/lib/botEngine.ts`) and the backtest
engine (`backtestEngine.ts`) both drive the **same** strategy implementations
(`src/lib/strategies/`), which is what makes backtest/live parity structural rather
than aspirational. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the exit/risk
pipeline in detail.

## Getting started

### Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io/) 9+
- PostgreSQL 14+
- Binance API keys for the crypto section (use **testnet / Demo Trading** keys first)
- Optionally, an OANDA personal access token + account ID for the forex section
  (start with a free **practice** account)

### Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment (see .env.example for every variable)
cp .env.example .env
#    set DATABASE_URL, PORT, BASE_PATH, and the credential-encryption key

# 3. Apply the database schema
pnpm --filter @workspace/db run push

# 4. Type-check the whole workspace
pnpm run typecheck

# 5. Build
PORT=3000 BASE_PATH=/ pnpm -r run build
```

Then start the API server and serve the built frontend (a sample
[`ecosystem.config.cjs`](./ecosystem.config.cjs) is provided for pm2, and
[`update.sh`](./update.sh) is a one-command deploy/update helper for a VPS).

Register an account in the UI, add your broker credentials on the Settings page
(Binance keys on the Crypto section, OANDA token + account ID on the Forex
section — use the sidebar switcher), configure your strategies and risk limits,
and start on **testnet / practice** first. The two sections are fully independent:
separate configs, positions, trade logs, decisions, and stats, and both engines
can run at the same time.

## Backtesting

The Backtest page runs the real engine over historical data. Key controls:

- **Match live** — each strategy uses its own live configuration (true parity).
- **Maker mode** — model post-only maker entries and maker-rate take-profits with
  honest fill/miss logic (a limit that price never revisits is a *missed* entry).
- **R:R, pure exits, hold multiplier** — reshape the reward:risk profile and holding
  style for experiments without ever touching your live configuration.

Every run records the exact effective configuration used and exports full trade
data as CSV for external analysis.

Backtesting covers **both** sections: crypto uses Binance public data, and forex
downloads OANDA candles (with your connected account) and models forex costs and
market hours. The **Optimization Autopsy** — a walk-forward diagnostic that only
suggests a change when it beats your current config out-of-sample — works for
both markets too.

## Documentation

- [`docs/PRODUCT_OVERVIEW.md`](./docs/PRODUCT_OVERVIEW.md) — what the platform is,
  what's included, and its honest limitations (for evaluators/buyers).
- [`docs/USER_GUIDE.md`](./docs/USER_GUIDE.md) — plain-language guide to using the
  dashboard and reading the Decisions / Autopsy / Forensics tools.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the exit/risk pipeline internals.
- [`docs/HANDOFF.md`](./docs/HANDOFF.md) — the VPS deployment runbook.

## Disclaimer

This software is provided for educational and research purposes. Trading
cryptocurrency, forex, and other leveraged products carries substantial risk of
loss. **This project does not guarantee profit
and is not financial advice.** Backtested results do not guarantee future
performance. You are solely responsible for any use of this software, including any
live trading you choose to enable. Always test on exchange testnet / Demo Trading
before risking real capital.

## License

[MIT](./LICENSE)
