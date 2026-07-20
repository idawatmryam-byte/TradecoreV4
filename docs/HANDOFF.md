# TradeCore Pro — Handoff to the VPS session

Paste this whole file (or point `git pull` at it) into the Claude Code
session running on the VPS so it can pick up where the cloud session left
off. The cloud session that built this could not reach any exchange or the
VPS (Binance geoblocked, SSH not available from its sandbox), so deployment
and live/real-data validation are yours to do — you are *on* the machine.

---

## 1. What this project is

TradeCore Pro — a multi-user Binance **spot + USDⓈ-M futures** algorithmic
trading platform (Node/TypeScript, pnpm monorepo). Multi-strategy engine,
regime-aware strategy selection, professional risk management, a backtest
engine with backtest/live parity, and a per-user encrypted-credentials
account system.

## 2. Where the code is

- Repo: `idawatmryam-byte/TradecoreV3`
- Working branch: **`claude/project-setup-29b81c`** (PR #1)
- Everything below is already committed there. `git pull` and you have it.
- **Rule: keep pushing to this branch.** Git is the single source of truth
  that keeps the cloud session and this VPS session in sync. Don't leave work
  only on the VPS.

## 3. What's already built (don't rebuild)

- **Accounts**: register/login, scrypt password hashing, DB-backed signed
  session cookies.
- **Per-user Binance credentials**: each user enters their own API key/secret
  on the Settings page; stored **AES-256-GCM encrypted** at rest. Each user's
  bot instance connects with their own keys only. No global API key exists.
- **Spot + Futures (long AND short)**: leverage, isolated/cross margin,
  liquidation-price safety checks, per-symbol leverage clamping, margin
  pre-check. Futures uses independent STOP_MARKET/TAKE_PROFIT_MARKET orders
  (Binance USDⓈ-M has no atomic OCO).
- **6 strategies**, each regime-gated: momentum-breakout, trend-pullback,
  mean-reversion, vwap-reversion, micro-scalping, volatility-breakout. All
  symmetric long/short.
- **Risk management**: risk-% position sizing, per-trade + portfolio-level
  risk caps, daily-loss circuit breaker, consecutive-violation pause
  (persisted across restarts), TP1/TP2 ladder, break-even, trailing stops,
  net reward:risk quality gate.
- **Backtest engine** with a **validation harness** (see §6).

Full reasoning is in the commit history.

## 4. Deploy on the VPS (safely — other sites live here)

> ⚠️ The owner said this VPS hosts other websites. **Do not touch them.**
> Use a **unique PORT**, this project's **own Postgres database**, its **own**
> systemd/pm2 service, and its **own** reverse-proxy vhost. Never edit or
> restart unrelated services.

Prerequisites: Node 20+, `pnpm`, PostgreSQL.

```bash
# 1. Get the code
git clone -b claude/project-setup-29b81c https://github.com/idawatmryam-byte/TradecoreV3.git
cd TradecoreV3
pnpm install

# 2. Create a dedicated database (do NOT reuse another app's DB)
sudo -u postgres createdb tradecore
sudo -u postgres psql -c "CREATE USER tradecore WITH PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE tradecore TO tradecore;"

# 3. Environment (see .env.example for the full annotated list)
export PORT=8090                     # a free port NOT used by another site
export NODE_ENV=production
export DATABASE_URL="postgres://tradecore:CHANGE_ME@127.0.0.1:5432/tradecore"
export SESSION_SECRET="$(openssl rand -hex 32)"
export CREDENTIALS_ENCRYPTION_KEY="$(openssl rand -hex 32)"   # 64 hex = 32 bytes
# ↑ Save CREDENTIALS_ENCRYPTION_KEY permanently. Rotating it makes every
#   stored Binance credential undecryptable (users must re-enter keys).

# 4. Apply the schema
DATABASE_URL="$DATABASE_URL" pnpm --filter @workspace/db run push

# 5. Build — frontend FIRST (backend build copies it into dist/public)
PORT="$PORT" BASE_PATH=/ pnpm --filter @workspace/tradecore-pro run build
pnpm --filter @workspace/api-server run build

# 6. Run (put this under systemd or pm2 for real; foreground to smoke-test)
pnpm --filter @workspace/api-server run start
# Express serves both the API and the built SPA on $PORT.
```

Then point a **new** nginx/caddy vhost (its own server block) at
`127.0.0.1:$PORT` with TLS. Leave existing vhosts alone.

The server refuses to boot if any required env var is missing and prints
exactly what's wrong — trust that message.

## 5. First live steps (do this before real money)

1. Open the site, register an account.
2. Settings → enter **Binance Testnet** API keys, leave the Testnet toggle ON.
3. Settings → Market Type: start with **spot**, then try **futures** small.
4. Start the bot; watch the scanner + trades. The VPS can reach Binance, so
   this is the first time any of this touches a real exchange — **futures
   order placement has never been exercised against a live/testnet account**,
   so validate on testnet thoroughly before switching Testnet off.

## 6. Backtest-validation harness (now with REAL data)

The harness lives in `artifacts/api-server/harness/` (see its README). On the
cloud sandbox it had to use **synthetic** candles (no exchange access). On the
VPS you can feed it **real Binance data** — that's the big upgrade.

- Real candles load via `ensureCandles()` in `src/lib/historicalData.ts`
  (Binance public REST → cached in the `historical_candles` table). Everything
  downstream already reads from that table, so real data is a drop-in for the
  synthetic seed step.
- Workflow: snapshot the current engine (`run.ts --label baseline`), change
  ONE thing, snapshot again, `compare.ts baseline variant`. It runs in
  **faithful mode** (each strategy uses its own live config).
- The loop is deterministic (verified: two runs → all deltas 0), so any metric
  change is attributable to the code change alone.

## 7. Deferred work — the disciplined next moves

These are real decision-quality improvements the cloud session **deliberately
did not deploy blind**, because each changes which trades fire and should be
validated on the harness (with real data now) first. Priority order:

1. **Unify confidence (highest value).** `buildSignalRow` computes a 12-indicator
   weighted confidence, but each strategy ignores it and re-derives its own
   ad-hoc confidence. The sophisticated engine barely informs the actual
   trade. Wire `row.confidence`/`row.shortConfidence` into the strategies.
2. **Regime hysteresis.** `detectMarketRegime` can flip every 15s tick; add
   stability so a strategy isn't eligible one scan and not the next.
3. **Breakout confirmation.** Momentum enters on a single tick above the level
   (false-breakout trap). Require a candle close beyond it, or a retest.
4. **Macro no-trade buffer.** `macroBullish = close > 1h EMA50` exactly — price
   sitting on the EMA50 whipsaws the directional gate. Add a neutral band.
5. **Regime volatility baseline** is mildly self-referential (its ATR average
   includes the current elevated reading). Minor, but real.

For each: run baseline → implement → run variant → compare → keep only if it
improves the headline metrics without wrecking drawdown/profit factor.

## 8. Guardrails already enforced (keep them)

- **Net reward:risk gate** (`tradingCosts.ts`, floor 0.5) rejects structurally
  poor trades in both engines.
- **Validate before deploy**: don't ship alpha changes without a harness
  comparison. This is the project's core discipline.
- **Quality over quantity**: the goal is high-probability trades with defined
  risk/reward, not trade count.

## 9. Known limitations / open risks

- Futures live/testnet order flow is **code-complete but never exchange-tested**.
- No automated test suite and no CI yet.
- Backtest does not model funding rates or (for futures) leverage/liquidation
  P&L — trade-direction parity only.
- Harness data was synthetic in the cloud; switch it to real Binance data here.
