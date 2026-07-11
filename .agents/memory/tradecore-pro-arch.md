---
name: TradeCore Pro Architecture
description: Key decisions, fixes, and non-obvious constraints for the TradeCore Pro trading bot
---

## Phase 1 Engine (complete)
- 12-indicator multi-timeframe voting engine in `artifacts/api-server/src/lib/strategy.ts`
- ADX uses Wilder smoothing (sum/period bug fixed — must divide by period not sum)
- `enterTrade` signature in botEngine: `(symbol, row, entry, config, now, strategyId?, strategyName?, stratAtrSl?, stratAtrTp?)`
- Reentrancy guard: `scanning` boolean in BotEngine prevents overlapping scan executions

## Phase 2 Engine (complete)
- 6 strategies in `artifacts/api-server/src/lib/strategies/` — each pure, stateless, regime-gated
- Strategy IDs use **underscores** (`momentum_breakout`, `trend_pullback`, etc.) not hyphens — both DB and frontend must match
- `strategySelector.evaluateSymbol()` always returns signals **sorted by confidence descending** — `signals[0]` is safely the best
- `enterTrade` uses per-strategy ATR multipliers (`stratAtrSl`/`stratAtrTp` params) not global bot config for post-fill SL/TP recompute
- Per-strategy `maxConcurrentPositions` is enforced in botEngine before calling `enterTrade` (count from `openTrades.filter(t => t.strategyId === ...)`)
- Backtest exits on `maxHoldingSeconds` per-strategy — `pos.strategyId` lookup against `strategyConfigs` map
- `strategy_configs` DB table seeds defaults via `loadStrategyConfigs()` using `onConflictDoNothing` to preserve user edits
- Frontend `STRATEGY_ICONS` map must use underscore keys to match API `strategyId` values

## API / OpenAPI
- api-zod export collision fix: remove `schemas: { path: "generated/types" }` from orval.config.ts; `lib/api-zod/src/index.ts` must only export `./generated/api` (not `./generated/types`)
- Codegen: `cd lib/api-spec && pnpm run codegen` — regenerates both `api-client-react` and `api-zod` packages + typechecks libs

## Phase 2.5 Risk Management (complete)
- `computeQty()` guard: `slPrice <= 0 || slPrice >= entryPrice` now returns 0; the dangerous fixed-size fallback when SL was invalid has been removed
- `enterTrade` SL/TP validity check: if `realSl <= 0 || realSl >= fillPrice` or `realTp <= fillPrice` **after a real fill**, the engine immediately issues a market sell to close the unprotected position and returns false — no trade is recorded
- SL/TP order placement uses **two separate try-catch blocks** — if TP succeeds but SL throws, the TP order ID is still saved; empty string = not placed; `checkExitCondition` guards empty IDs before calling `fetchOrder`
- `checkExitCondition` emits a `TRADE_RISK_AUDIT` structured log on every close: entryPrice, exitPrice, slPrice, tpPrice, qty, expectedMaxLoss, actualLoss, profit, estimatedFees, slippage, tolerance, pnl, riskViolation flag
- Risk violation = `actualLoss > expectedMaxLoss + max(0.10, 2%×expectedMaxLoss) + fees` AND stored SL is valid; stored SL validity is checked before the audit to skip false positives from legacy rows
- Violation counter is **consecutive**: resets to 0 on any clean, auditable close; pauses trading after 3 consecutive violations
- `alertWebhookUrl` in `bot_config` table: Discord / Telegram / Slack incoming-webhook URL; `sendAlert()` posts `{content, text}` and checks HTTP status
- `riskPaused` is part of `BotState` interface and returned by `getState()`; `POST /api/bot/reset-risk-pause` endpoint clears the pause without restart
- `updateBlacklist()` takes `alreadyBlacklisted: Set<string>` — only logs WARN for newly blacklisted symbols, not on every 15-second scan tick
- Bot state (`running=true`) is lost on PM2 restart — must call `POST /api/bot/start` after any PM2 restart

## DB Indexes (added post-Phase 2.5)
- `trades`: index on `status`, `symbol`, composite `(symbol, status, exit_time)` — covers open-position lookup and per-symbol blacklist update query
- `blacklist_entries`: index on `expires_at` — covers `WHERE expires_at >= now` on every scan
- VPS migration: must `source /home/ubuntu/TradeCore/.env` before running `drizzle-kit push` (DATABASE_URL is in .env, not in shell)
- VPS frontend path: Vite builds to `artifacts/tradecore-pro/dist/public/`; api-server expects static files at `artifacts/api-server/dist/public/`. **build.mjs now auto-copies** — the `copyFrontend()` function at the end of `buildAll()` does this automatically after each backend build. No manual cp needed.
- VPS PM2 crash loop (61 restarts): was from old app.ts using Express 4 `app.get('*', ...)` syntax. Express 5 / path-to-regexp v8 requires `/{*path}` named wildcard. Current code is correct.
- VPS deploy pattern (no rsync): `tar czf /tmp/changes.tar.gz <files> && scp ... && ssh "tar xzf ... && pnpm build && pm2 restart"`. Backend rebuild auto-copies frontend via build.mjs. If only backend src changed, no separate frontend copy step needed.
- VPS frontend rebuild needs env vars inline: `PORT=5000 BASE_PATH=/ pnpm --filter @workspace/tradecore-pro run build`. `vite.config.ts` throws if `PORT` or `BASE_PATH` are unset, and sourcing `.env` does not propagate them to the vite subprocess. Production base path is `/` (SPA served from api-server dist/public). Any PORT value works — it's a static build. Prior deploys only touched backend so this only bites when frontend src changes.
- VPS internal API port is 8080 (`curl http://localhost:8080/api/...`); the bot engine `running` flag resets on pm2 restart — POST /api/bot/start on 8080 to restore it. Check status first and only re-start if it was running.
- build.mjs wipes entire dist/ on every build (rm -rf). Frontend files in dist/public/ survive because copyFrontend() re-copies from ../tradecore-pro/dist/public after esbuild. If frontend is missing (not yet built), it logs a skip — not an error. Any cp() failure is a hard error (fails the build).

## Engine Verification Surfaces (live monitor + decision trace)
- The per-symbol scan loop records a full `SymbolDecision` (5 stages: Market Data → Indicators → Signal → Risk Checks → Order) at **every** exit point; this is instrumentation only and must stay behavior-preserving — never relax the strategy to force trades.
- **Why:** the user needs the exact blocking condition surfaced, not "Running". Block priority in the trace must mirror the real control-flow order (blacklist → cooldown → portfolio → risk pause → signal → strategy concurrency → position size → order).
- Live market monitor uses an **independent ticker poller** (`fetchTickers`, ~3s) decoupled from the 15s strategy scan, with its own single-flight guard (`tickerPolling`) mirroring the scan's `scanning` guard — any async interval poller here needs one or slow fetches overlap and pile up.
- `enterTrade` returns `{ entered: boolean; reason: string }` (not bare boolean) so the Order stage can display why an order was/wasn't placed.
- All verification data is REST-polled (no SSE/WebSocket) to match existing architecture; `stop()` clears live tickers + connection health so a stopped engine never reports stale data.

## DB Schema
- `trades` table has `strategy_id`, `strategy_name` columns (Phase 2 additions, nullable)
- `trades` table has `risk_violation` (boolean, default false) and `risk_violation_reason` (text, nullable) — Phase 2.5
- `bot_config` table has `alert_webhook_url` (text, nullable) — Phase 2.5
- `backtest_trades` table has `strategy_id`, `strategy_name`, `market_regime` columns (Phase 2 additions, nullable)
- `strategy_configs` table: per-strategy settings, seeded with defaults on first load
- Migration: `cd lib/db && pnpm drizzle-kit push --force`
