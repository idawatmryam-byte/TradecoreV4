# Demo trading audit — 2026-09-07

TradeCore's demo trading is not yet validated as consistently profitable.
This change fixes execution reliability and measurement errors; it does not
increase leverage, loosen risk limits, activate a mandate, or deploy code.

Work remains uncommitted and is not a deployment authorization. All local
development/test processes for this audit have ended. Running trading accounts
were not stopped or changed. The isolated validation database and evidence were
retained; no account data was deleted.

## Findings from the existing account database

Read-only inspection excluded the shared showroom account. Ten closed
simulated trades had a combined recorded net P&L of $486.56. A single trade
contributed $457.66, so the total is not evidence of a repeatable edge.
These are existing ledger values, not independently reconciled performance.

The decision journal recorded 64 eligible plans blocked by a missing immutable
AutoPilot mandate. Co-Pilot configurations require approval to execute.
Several accounts and both markets are configured, so selecting the intended
account is necessary before preparing its bounded demo trial.

The idle sweeper could stop a demo with open positions after 30 minutes
without dashboard activity. That prevents timely simulated stops and exits.
Separately, the deployed schema snapshot lacks newer safety columns such as
`live_kill_switches.resume_request_id`. A deployment must apply the repository's
schema and privilege checks before enabling AutoPilot.

## Changes

| Files under `artifacts/api-server/`                                                                                                                              | Behavior                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/botEngine.ts`, `src/lib/engineRegistry.ts`                                                                                                              | Preserve monitoring for open positions and enabled AutoPilot during inactivity. Refuse idle shutdown when exposure cannot be checked or a scan is active. Report only actual pauses.                                                                                                                      |
| `src/lib/candleTiming.ts`, `src/lib/botEngine.ts`                                                                                                                | Entry indicators use at most 100 closed candles per timeframe; incomplete, invalid, or stale entry data cannot authorize a new trade. Existing positions still receive exit checks when indicator history is unavailable.                                                                                 |
| `src/lib/backtestEngine.ts`                                                                                                                                      | Build all timeframes from one-minute source data; the selected timeframe is the entry evaluation cadence. Exits run every minute. Expose aggregate bars only at their close, reject incomplete aggregates, remove substitutes for missing higher-timeframe history, and timestamp decisions at bar close. |
| `src/lib/execution/demoExit.ts`                                                                                                                                  | Ignore pre-entry candle ranges and allocate entry fees to partial exits.                                                                                                                                                                                                                                  |
| `src/lib/execution/fillModel.ts`                                                                                                                                 | Preserve the original stop and full quantity when a bar touches both the stop and a partial target; do not assume the profitable partial happened first.                                                                                                                                                  |
| `harness/candle-timing.test.ts`, `harness/demo-idle-safety.test.ts`, `harness/demo-management-persistence.test.ts`, `harness/fill-model.test.ts`, `package.json` | Add deterministic timing, lifecycle, isolation, error-path, and accounting regressions to the standard suite.                                                                                                                                                                                             |

Provider candle timestamps denote opening time. A current candle can still
change until it closes: see the [CCXT OHLCV documentation](https://github.com/ccxt/ccxt/wiki/Manual#ohlcv-candlestick-charts).

## Historical evidence

The real `runBacktest` engine was run in the isolated local database
`tradecore_demo_validation_20260907`. Only schema and cached historical candles
were copied from the existing database; existing accounts and trades were not
modified. Every selected candle was tagged `source=exchange`; source tags
were checked, but the cache was not independently re-downloaded from Binance.
Each window had complete one-minute coverage, including six days of preroll.

The profile was fixed before these runs: BTCUSDT, ETHUSDT, BNBUSDT, spot,
one-minute entry cadence, $10,000 initial balance per window, $300 global
position cap, five maximum positions, $100 daily loss limit, per-strategy
repository defaults, 0.1% fees per side, and 0.05% adverse slippage per fill.
There was no parameter optimization. This is historical simulation, not
forward-demo evidence, futures evidence, or a broker compatibility test.

| UTC window (end exclusive) | Trades | Net P&L |   Fees | Profit factor |
| -------------------------- | -----: | ------: | -----: | ------------: |
| Aug 1–8, 2026              |     28 | -$23.39 | $16.80 |        0.1227 |
| Aug 8–15, 2026             |      7 |  -$8.58 |  $4.20 |        0.0298 |
| Aug 15–22, 2026            |     50 | -$16.89 | $30.03 |        0.5682 |
| Aug 22–28, 2026            |     69 | -$60.18 | $41.40 |        0.2487 |

Across these four windows, 154 trades lost $109.04 after approximately $92.43
in fees. The tested spot defaults therefore fail a basic profitability check.
Trend Pullback contributed the largest strategy-level loss (about $71.13 over
97 trades), while positive windows for Volatility Breakout or VWAP Reversion
were isolated and inconsistent. No strategy is promoted from this sample;
increasing size or enabling more frequent entries is not supported by this
evidence.
The older backtest results must be rerun because their indicator timing was
different and could include future higher-timeframe values.

## Operational limits and next decision

The follow-up accounting audit found that partial fills and remaining position
size were previously separate writes, and some persistence failures were
swallowed. `demoExit.ts` now commits the ledger rows and management projection
in one transaction. It locks and checks the stored Demo position before writing,
refuses stale or mismatched-account snapshots, and publishes caller state only
after commit. Failed persistence is surfaced so the next scan reloads state.
It also refuses non-Demo input at the simulation boundary.

`harness/demo-management-atomicity.test.ts` exercises real PostgreSQL rollback,
concurrent partial-fill attempts, safe retry, account isolation, and Live refusal.
It is included in `test:integration`; the deterministic persistence harness
also covers failed partial inserts and failed projection updates.

Validation state at stop:

- Backend deterministic harnesses — all listed harnesses passed across the
  initial run through `graceful-drain.test.ts` and a resumed run covering the
  remaining harnesses. The execution-authority fixture was corrected to include
  the nullable management fields used by persisted production rows. The exact
  single-command uninterrupted full-suite run was not repeated after that
  fixture correction.
- `pnpm run typecheck` — passed across the workspace.
- `demo-management-persistence.test.ts` — passed with rollback and stale
  snapshot regressions; `demo-management-atomicity.test.ts` — passed against
  isolated PostgreSQL, including concurrent attempts and actual rollback.
- `demo-lifecycle.test.ts`, `demo-autopilot-integration.test.ts`, and
  `phase10-deterministic-validation-integration.test.ts` — passed against the
  isolated PostgreSQL database. The last test exercises entry, duplicate
  refusal, restart recovery, management persistence, close, and Live refusal.
  The Phase 10 test was rerun successfully after the atomic persistence change;
  the lifecycle and AutoPilot results predate that change.
- `git diff --check` and formatting checks for the new files — passed.

The initial isolated integration setup had the copied older schema and an
owner connection. After applying the current Drizzle schema and the repository's
runtime/capture grants in that database, the restricted-role checks passed.
This does not verify the running deployment's schema or broker compatibility.
External Binance/OANDA order placement, the full provider integration suite,
and sustained forward-demo profitability were not verified.

Closed-candle signals can arrive later than intrabar signals and can change
which trades qualify. Higher-timeframe backtests now need one-minute history,
increasing download and storage requirements. Preserving unattended monitoring
increases the runtime cost of demos with positions or enabled AutoPilot.

OHLC simulation still cannot establish tick ordering, queue position, or actual
broker fills. Demo recovery across missing scans and historical same-bar
trailing-stop ordering need further validation before treating simulated
performance as deployment evidence. This change does not certify those paths.

Choose the intended account and market, then prepare an expiring Demo-only
mandate with explicit size/loss limits through the existing approval workflow.
Keep live authority disabled. Strategy selection needs additional independent
market periods and a forward trial with fees, drawdown, and rejection reasons
recorded. A strategy that fails these checks should remain in research.
