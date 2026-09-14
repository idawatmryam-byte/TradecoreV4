# TradeCore Pro

TradeCore Pro is a production-grade algorithmic trading platform for cryptocurrency (Binance Spot & Futures) and forex (OANDA). Built around an autonomous, multi-strategy engine with parity-verified backtesting, it combines institutional risk management, AI-assisted decision intelligence, and a powerful real-time dashboard to automate trade execution and validate ideas on real historical data.

## Key Features
- Dual-market architecture (Binance + OANDA, spot + futures + forex)
- 10 built-in strategies + no-code visual strategy builder
- Structural backtest/live parity (same code path)
- Dollar-centric risk management (circuit breakers, cooldowns, correlation limits)
- Optimization Autopsy (walk-forward out-of-sample validation)
- Edge Forensics (dollar-quantified leak diagnosis)
- Full decision journal with plain-English rationales
- AI specialist council and shadow decision framework
- Co-Pilot (human approval) and AutoPilot modes
- One-click demo mode (no API keys needed)
- Multi-user with AES-256-GCM encrypted credentials
- Contract-first API (OpenAPI → generated Zod + React Query hooks)

## Tech Stack
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

The trading engine (`artifacts/api-server/src/lib/botEngine.ts`) and the backtest engine (`backtestEngine.ts`) both drive the **same** strategy implementations (`src/lib/strategies/`), which is what makes backtest/live parity structural rather than aspirational. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the exit/risk pipeline in detail.

## Quick Start

### Prerequisites
- Node.js 20+ and [pnpm](https://pnpm.io/) 9+
- PostgreSQL 14+
- Binance API keys for crypto, or OANDA token for forex (practice accounts recommended)

### Setup
```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
# Set DATABASE_URL, PORT, BASE_PATH, and credential-encryption key

# 3. Apply the database schema
pnpm --filter @workspace/db run push

# 4. Build and start
PORT=3000 BASE_PATH=/ pnpm -r run build
# PM2 ecosystem config provided for production
```

### Admin Bootstrap
To grant the initial platform administrator role to an existing account (e.g., `admin@tradecore`):
```bash
export PLATFORM_ADMIN_BOOTSTRAP_USERNAME='admin@tradecore'
export PLATFORM_ADMIN_BOOTSTRAP_REASON='Initial owner platform administrator'
pnpm --filter @workspace/api-server run bootstrap:platform-admin
unset PLATFORM_ADMIN_BOOTSTRAP_USERNAME PLATFORM_ADMIN_BOOTSTRAP_REASON
```
Then log in through the normal UI and you will be redirected to the Admin Console.

## What's Included
- Complete monorepo source (TypeScript, 79 test files)
- React dashboard (Vite + Tailwind + shadcn/ui)
- Marketing landing page
- 13-section technical White Paper
- Deployment scripts (PM2, zero-downtime update.sh)
- CI/CD pipeline (GitHub Actions)
- Comprehensive documentation (Architecture, ADRs, User Guide, phase docs)

## Documentation
- [`docs/WHITE_PAPER.html`](./docs/WHITE_PAPER.html) — 13-section Architecture & Technical White Paper
- [`docs/PRODUCT_OVERVIEW.md`](./docs/PRODUCT_OVERVIEW.md) — Product evaluation guide
- [`docs/USER_GUIDE.md`](./docs/USER_GUIDE.md) — End-user dashboard guide
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — Architecture internals
- [`docs/HANDOFF.md`](./docs/HANDOFF.md) — VPS deployment runbook

## License
MIT — see [LICENSE](./LICENSE)
