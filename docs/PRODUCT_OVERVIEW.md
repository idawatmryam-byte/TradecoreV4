# TradeCore Pro — Product Overview

A self-hosted, multi-user algorithmic trading platform for **crypto (Binance
spot + USDⓈ-M futures)** and **forex (OANDA)** — one codebase, two fully
independent trading sections that can run side by side. Built in TypeScript as
a pnpm monorepo, it pairs an autonomous multi-strategy engine with the tooling
a serious operator expects: honest backtesting, walk-forward strategy
diagnosis, per-trade forensics, and dollar-denominated risk control.

This document is for someone **evaluating or acquiring** the platform. For how
to *use* the running app, see [`USER_GUIDE.md`](./USER_GUIDE.md); for how to
*deploy* it, see [`HANDOFF.md`](./HANDOFF.md) and [`../README.md`](../README.md).

---

## What it does

- **Two markets, one platform.** Crypto trades Binance (spot and USDⓈ-M
  futures, long and short, leverage/margin aware); forex trades OANDA
  (majors, gold, and USD-quoted indices) via a ccxt-shaped adapter with
  native atomic bracket orders. Each section has its own connection, strategy
  tuning, positions, trade log, decision journal, and on/off switch.
- **Autonomous multi-strategy engine.** A curated catalog per market
  (structural strategies for both, plus a forex-native London-session
  breakout). A regime detector decides which strategy is allowed to act in the
  current market condition, so strategies don't fire out of context.
- **Risk in dollars, not jargon.** The operator states the exact dollars to
  risk and to target per trade; the engine derives position size, stop price,
  and take-profit price from that plan and the instrument's structure. A
  daily-loss circuit breaker and a consecutive-violation pause protect the
  account.
- **Backtesting with live parity.** The backtester runs the *same* decision
  code as live trading — same signals, same sizing, same fee/slippage model —
  so results reflect what the live engine would have done. Works for both
  crypto (Binance public data) and forex (OANDA candles).
- **Optimization Autopsy.** A walk-forward diagnostic that sweeps one
  strategy's real knobs on a training window and only suggests a change if it
  *also* beats the current config on a held-out validation window. "No better"
  is a first-class, honest verdict — it's a diagnostic, not a curve-fitter.
- **Edge Forensics.** Decomposes realized performance into named,
  dollar-quantified leaks (break-even scratches miscounted as losses,
  stops sitting inside market noise, negative strategy/symbol/hour cells) so
  the operator improves on evidence instead of guesswork.
- **No-code Strategy Builder.** Users compose their own strategies from the
  engine's indicator vocabulary (simple AND rules per side + a stop mode),
  stored as validated data — never user code — and run through the exact
  same risk pipeline as the built-ins. A backtest-first gate blocks live
  enablement until the current rules have been backtested; editing the
  rules re-arms the gate.
- **Full audit trail.** Every considered trade — taken, passed, or rejected —
  is logged with its reasoning; every closed trade is automatically analyzed
  and graded.
- **Multi-user by design.** Each account runs its own isolated engine against
  its own encrypted exchange keys; funds never leave the user's own exchange.
- **One-click demo.** A read-only, pre-seeded demo account lets a prospect
  explore the fully-populated product with no signup and no exchange keys.

## What's included in a sale

- Full source (this monorepo): API server, React dashboard, shared DB and
  API-spec packages, and the backtest validation harness.
- Deployment tooling: `update.sh`, a PM2 ecosystem config, an annotated
  `.env.example`, and the deployment runbook in `docs/HANDOFF.md`.
- Documentation: this overview, the end-user guide, the architecture notes
  (`ARCHITECTURE.md`), and the README.
- A professional marketing landing page (`artifacts/tradecore-pro/public/landing.html`).

## Architecture at a glance

- **`artifacts/api-server`** — Express API + the trading engine. One
  `BotEngine` instance per (user, section), keyed in an in-process registry;
  ccxt for Binance, a ccxt-shaped adapter for OANDA.
- **`artifacts/tradecore-pro`** — React/Vite dashboard (wouter + TanStack
  Query). One process serves both the API and the built SPA.
- **`lib/db`** — Drizzle ORM over PostgreSQL (the single source of truth for
  users, config, trades, decisions, backtests, and memory).
- **`lib/api-spec` → `lib/api-client-react` / `lib/api-zod`** — an OpenAPI
  spec generates the typed client and validators, so the frontend and backend
  never drift.
- Secrets are encrypted at rest (AES-256-GCM); sessions are stateless
  HMAC-signed cookies; all config comes from a gitignored `.env`.

## Honest limitations (read before buying)

This is sold on the strength of its **engineering**, not on a proven profit
record. Specifically:

- **No verified profitability.** The included strategies are a competent
  starting point, not a guaranteed edge. No live money track record is claimed
  or implied. A buyer should expect to validate and tune strategies themselves.
- **Single-process scaling ceiling.** The engine keeps live trading state in
  one Node process and must not be clustered (two instances would place
  duplicate orders). This comfortably serves tens of concurrent users on one
  box; scaling to hundreds/thousands would require a distributed-workers
  rebuild (a known, scoped piece of work, not a rewrite).
- **Forex slippage on indices.** Fast-moving index CFDs (NAS100/US30/SPX500)
  can fill stops beyond the planned distance in a spike; majors and gold
  behave to plan. The risk audit flags any such violation.
- **No built-in billing.** There is no subscription/entitlement layer — it's a
  self-hosted, single-owner product today. A SaaS sale would need billing
  added.
- **Operational tooling is lean.** Health/liveness checks and structured logs
  exist; there is no bundled error-monitoring (Sentry) or admin/user-management
  UI yet.

None of these are hidden defects — they're the honest edges of a
cleanly-built platform, disclosed up front so due diligence holds no surprises.
