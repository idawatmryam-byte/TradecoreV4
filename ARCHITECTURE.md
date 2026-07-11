# TradeCore Pro — Architecture Notes: Exit & Trade-Management Pipeline (Phase 4A/4B; Backtest Config Phase 4C/5A; SL/TP Phase 5A)

This file currently covers what Phase 4A and 4B touched: the exit/risk-close
pipeline and the TP1/TP2/break-even/trailing trade-management layer on top of
it; the backtest effective-configuration pipeline (bug fix, later updated for
Phase 5A's percentage-based fields); and the Phase 5A percentage-based SL/TP
system. A full architecture doc for the rest of the engine (strategy
selection, scan loop, dashboard) is a Phase 4 final-requirements deliverable
and hasn't been written yet — flagging that gap rather than padding this file
with a description of code that didn't change.

## Where a trade's exit is decided

```
BotEngine.runScan()  (every scanIntervalSeconds)
  └─ for each open trade:
       BotEngine.checkExitCondition(trade, candles1m, now, cooldownMinutes, maxHoldingSeconds, stratConfig)
         ├─ TradeManager.manage(ex, trade, market, candles1m, stratConfig, orderIds)   ◄── Phase 4B
         │     ├─ TP1 hit? → partial close, log to trade_partial_exits, move SL to break-even
         │     ├─ TP2 hit? (only if tp3Enabled) → partial close, log to trade_partial_exits
         │     └─ trailing/emergency-trailing armed? → tighten stopLoss (never loosen)
         │          (all of the above write directly to trade.stopLoss/remainingQuantity/etc.
         │           — TradeManager never fully closes a trade)
         └─ ExitManager.evaluate(ex, trade, market, candles1m, now, cooldownMinutes, maxHoldingSeconds, orderIds)
              ├─ Step 1: checkOrderStatus()        — trust a confirmed exchange fill first
              ├─ Step 2: reconcilePriceTouch()      — candle wick touched SL/TP: cancel + inspect both
              │            └─ protectiveMarketClose() — neither leg confirmed filled → flatten at market
              ├─ Step 3: max-holding-time exit       — protectiveMarketClose(reason="timeout")
              └─ closeTrade(trade, reason, price, now, cooldownMinutes)   ◄── the ONLY place that
                     ├─ normalizeExitReason()             writes status:"closed"
                     ├─ read remainingQuantity (Phase 4B) instead of assuming full original size
                     ├─ roll in trade_partial_exits rows so pnl/fees reflect the WHOLE trade
                     ├─ compute fees / slippage / gross+net pnl / holding time
                     ├─ compare planned vs. actual SL/TP/qty → log TRADE_VALIDATION_MISMATCH
                     ├─ compare expected vs. actual max loss → log TRADE_RISK_AUDIT, flag riskViolation
                     ├─ db.update(tradesTable) — the single "closed" write
                     └─ host callbacks: recordHourlyStat, setCooldown, recordRiskViolation/recordCleanClose
```

`ExitManager` is a plain class (`artifacts/api-server/src/lib/exitManager.ts`),
not a singleton — `BotEngine` owns one instance and injects its side effects
(alerts, cooldowns, hourly stats, risk-pause counters) through an
`ExitManagerHost` interface so `ExitManager` has no direct dependency on
`BotEngine` and could be unit-tested by supplying a fake host and a fake
`ccxt`-shaped exchange object.

`TradeManager` (`artifacts/api-server/src/lib/tradeManager.ts`) follows the
same pattern via a `TradeManagerHost` interface, and follows the same
division of responsibility: **`TradeManager` only ever narrows risk (raises
`stopLoss`) or reduces size (partial closes) — it never fully closes a
trade.** That stays `ExitManager`'s job alone. Concretely, `TradeManager`
writes to `stopLoss`, `takeProfit` is left untouched (the remainder after any
partial always keeps targeting the strategy's own original target — see
Phase 4B in `CHANGES.md`), and `remainingQuantity`/`tp1Filled`/`tp2Filled`/
`breakEvenActive`/`trailingStopActive`. `ExitManager` reads all of these
fresh each tick without needing to know why they changed.

**Invariant the rest of the codebase should preserve:** nothing outside
`ExitManager.closeTrade()` should ever `db.update(tradesTable).set({ status:
"closed", ... })`. If a future route (e.g. a manual "close position" button)
needs to close a trade, it should call `ExitManager.closeManually()` — which
already exists for exactly that, just not wired to a route yet — rather than
writing the DB directly.

## Canonical exit reasons

`artifacts/api-server/src/lib/exitTypes.ts` is the single source of truth for
valid `exitReason` values. `ExitManager` normalizes every reason through it
before writing; `routes/trades.ts` re-validates on the way out for
defense-in-depth against old/corrupt rows. See the file's header comment for
why `TIME_LIMIT` is stored as `"timeout"` on the wire (backward
compatibility with the existing OpenAPI contract) rather than being renamed.

## Planned vs. actual audit trail

`trades` now stores both the strategy's original signal-time SL/TP/qty
(`plannedStopLoss`, `plannedTakeProfit`, `plannedQuantity` — written once at
entry in `BotEngine.enterTrade()`) and the actual slippage-adjusted values
placed on the exchange (`stopLoss`, `takeProfit`, `quantity`, unchanged
columns). `ExitManager` diffs these at close time so a sizing/order-placement
disagreement shows up as a `TRADE_VALIDATION_MISMATCH` log line instead of
silently affecting P/L with no trace.

## Known gaps

- **✅ True OCO orders implemented** (was previously the top-flagged gap) —
  see the "Follow-up: true OCO orders implemented" section in `CHANGES.md`'s
  Phase 4B entry for the full detail. Short version: `lib/binanceOco.ts` uses
  Binance's current `orderList/oco` endpoint (verified against their live
  docs — the older `order/oco` is deprecated) to place the SL+final-TP pair
  as one atomic order for the full position, with a runtime capability check
  and safe fallback to independent orders if the installed ccxt build lacks
  the raw method. This forced TP1/TP2 to become tick-checked triggers rather
  than resting orders (a real OCO requires both legs to share one quantity).
  **Still worth testnet-verifying** that the pinned ccxt version (4.5.63)
  actually exposes `privatePostOrderListOco` before trusting this with live
  capital — see the CHANGES.md section for exactly what is and isn't
  independently confirmed.
- **Phase 4B is implemented** (TP1/TP2/optional-TP3-via-original-target,
  break-even, ATR/percent/dynamic/emergency trailing stops, configurable
  exit priority with stop_loss always forced first) — see `CHANGES.md`.
- **Phase 4C is substantially implemented** (MFE/MAE, risk/reward, largest
  win/loss, daily/monthly returns, strategy comparison, HTML/CSV/JSON
  reports) — the one open item is extending `openapi.yaml`'s
  `BacktestRun`/`BacktestTrade` schemas + the generated zod client to match
  (routes already return the new fields in raw JSON either way).
- **Phase 4D backend groundwork is done** (`GET /trades/monitor/active`,
  `GET /trades/:id/replay`, `mapTrade()` exposing Phase 4B state) but the
  actual dashboard UI redesign across the two frontend apps
  (`artifacts/tradecore-pro`, `artifacts/mockup-sandbox`) was intentionally
  not attempted in this pass — see the Phase 4D section of `CHANGES.md` for
  exactly what's left and why.
- `ExitManager.reconcilePriceTouch()` still has the same known limitation as
  before Phase 4A: a *partially* filled TP/SL order cancels successfully for
  the unfilled remainder and is treated as "not filled," so a partial fill's
  proceeds aren't blended into the exit price. Carried over from the prior
  pass, not introduced here.
- `backtestEngine.ts` still uses its own inline exit-touch logic rather than
  calling `ExitManager`/`TradeManager` directly — it operates on historical
  candle arrays with no live exchange to place/cancel orders against, so
  sharing the live classes outright isn't possible without a mock-exchange
  abstraction (a reasonable future task, not attempted here). Its exit-reason
  strings and general SL/TP/timeout logic were checked and remain consistent
  with the canonical set, so live and backtest stay aligned in spirit even
  though the code paths are separate.

---

## Backtest configuration pipeline (bug fix; updated Phase 5A)

```
Backtest UI (backtest.tsx)
  └─ POST /backtests/run  { stopLossPercent, takeProfitPercent, confidenceThreshold, riskPercent, ... }
       └─ runBacktest(runId, params)
            ├─ dbStrategyConfigs = loadStrategyConfigs()        — same loader botEngine.ts uses (live DB state)
            ├─ effectiveConfig = buildEffectiveBacktestConfigs(dbStrategyConfigs, params)   ◄── THE FIX
            │     (clones dbStrategyConfigs; overrides stopLossPercent/takeProfitPercent/confidenceThreshold
            │      always, riskPercent only if params.riskPercent > 0; never mutates the
            │      originals or writes to strategy_configs)
            ├─ persist { summary: effectiveConfig.summary, runLevelOverrides } → backtestRunsTable.effectiveConfig (before simulating)
            └─ strategySelector.evaluateSymbol(..., effectiveConfig.configs, ...)   — NOT dbStrategyConfigs
```

**Phase 5A note:** the old `maxSlPercent` post-signal filter is gone. SL is
now `computePercentSLTP()` — a fixed % of entry set directly from
`stopLossPercent` — so the stop distance is deterministic and can no longer
drift into an unreasonable range the way an ATR-multiplier sweep could. Sane
bounds now live once, at the API/validation layer, instead of as a
runtime filter re-checked per signal.

**Invariant to preserve:** `runBacktest()` must never pass `loadStrategyConfigs()`'s
return value directly into `strategySelector.evaluateSymbol()` — it must
always go through `buildEffectiveBacktestConfigs()` first. That indirection
being skipped is exactly the bug this fix addresses; if a future change
re-introduces a direct pass-through, the override-loss bug comes back.

**Two unrelated backtest systems exist** — see the Bug Fix section of
CHANGES.md. `lib/backtestEngine.ts`'s `runBacktest()` (via `POST
/backtests/run`) is what the Backtest UI uses and is the one this fix
applies to. `botEngine.ts`'s `runLegacyBacktest()` (via `POST /bot/backtest`)
is a separate, single-strategy, global-config-only tool not reachable from
either frontend app currently. They share no code; a fix to one says nothing
about the other — Phase 5A did convert `runLegacyBacktest()` to percentage
SL/TP too (see CHANGES.md), for consistency, without merging the two systems.

**Known gap:** the backtest event loop does not simulate Phase 4B trade
management (TP1/TP2, break-even, trailing stops) — every simulated position
is a single entry/single exit. Flagged in CHANGES.md as a real but
deliberately out-of-scope gap for this fix.

## Percentage-based SL/TP (Phase 5A)

```
strategies/*.ts  evaluate()
  └─ computePercentSLTP(entryPrice, config.stopLossPercent, config.takeProfitPercent)   ◄── strategies/base.ts
       slPrice = entryPrice × (1 − stopLossPercent/100)
       tpPrice = entryPrice × (1 + takeProfitPercent/100)
  └─ computeQty(balance, riskPercent, entryPrice, slPrice, positionSizeUsdt)
       riskAmount = balance × riskPercent/100
       qty = riskAmount / (entryPrice − slPrice)         ◄── unchanged; already strategy-agnostic
```

Every one of the 6 strategies calls the same `computePercentSLTP()` — there
is exactly one place SL/TP distance is computed, not six. ATR (and, in
mean-reversion/vwap-reversion/volatility-breakout, Bollinger Bands/VWAP) is
still used inside each strategy's `evaluate()` for regime detection, squeeze
detection, and entry-confidence scoring — never for the exit price. This is
the same live/backtest parity pattern already documented above:
`botEngine.enterTrade()` and `backtestEngine.ts`'s simulation loop both
consume whatever `slPrice`/`tpPrice` the strategy returns without
recomputing it, so a strategy only has one exit-math implementation to keep
correct, exercised identically by both live trading and backtesting.

**Trailing stops are intentionally untouched.** `tradeManager.ts`'s
`"atr"`/`"dynamic"` trailing-stop modes (per-strategy, opt-in via
`strategy_configs.trailingStopMode`/`trailingStopAtrMultiplier`) still use
ATR — that's a distinct, already-existing Phase 4B mechanism that adjusts an
*already-open* trade's stop as price moves, not the initial SL/TP computed
at entry. The Phase 5A brief's "ATR must never determine trade exits" is
read here as governing the initial SL/TP; trailing-stop-triggered exits are
flagged explicitly in CHANGES.md as a scope call the user may want to
revisit in a future phase.
