# Trading engine, risk and brain audit — 6 September 2026

## Assessment and evidence boundary

TradeCore has concrete defects in decision inputs, simulation and exit accounting. Those defects can reject valid setups, distort plans and make historical or Demo performance misleading. They must be corrected before strategy tuning is meaningful.

The active entry brain is principally a deterministic strategy selector with hand-designed indicator scores. The LLM/council path runs beside it in Shadow; it is not an independently validated professional trader controlling the entry selector. Good engineering safeguards do not demonstrate positive trading expectancy.

This audit inspected `<REPO_ROOT>`, local HEAD `a8259a9ab6f434c772574d7f6689eced21d44b3b` plus the owner's existing edits. The deployed revision and account configuration were not verified. No actual account trade history, broker fills or historical database were available to this run. Consequently, these are verified source defects and reproduced mechanisms, not a quantified attribution of the owner's actual losses.

## Corrections implemented locally

| Issue | Reproduction or source evidence | Correction |
|---|---|---|
| Future data in higher-timeframe backtests | Both ordinary backtest and full-brain research selected precomputed aggregates by opening timestamp. Changing only the 10:59 candle changed the hourly input seen by a 10:05 decision from 100 to 999. | A shared `closedCandleWindow` selects only bars whose closing time is at or before the decision cutoff. Research processing latency cannot admit later candles. Ordinary backtests abstain when higher-timeframe warmup is insufficient instead of substituting primary candles. |
| Live entry signals consume unfinished candles | The scan passed raw provider OHLCV to `buildSignalRow`; only the observational MarketState closed its own copy. | Signal construction now uses closed candles in all five timeframes. Fetching 101 bars retains up to 100 closed bars. Current raw candles remain available for existing-position exit monitoring. Capture timestamps now use the last signal candle's closing time. |
| Market prices rounded before planning | `0.000012345` became zero; `0.00012345` became `0.0001`. Strategies consume `row.lastPrice`. | Preserve the numeric market price in the decision layer. Exchange precision handling still belongs at the order boundary. |
| Valid bearish micro-scalps silently rejected | RSI 45–55 was assigned to long first; bearish MACD then rejected it without trying the documented short case. | Confirmed MACD direction chooses between the overlapping RSI zones. Existing RSI, volume, trend, slope and confidence thresholds remain unchanged. |
| Partial profits booked before an existing stop | With entry 100, stop 95, TP1 105 for half the size, a bar spanning 94–106 booked +2.50 instead of the original full-size −5 stop loss. The mirrored short failed too. | If the original stop or liquidation threshold is touched, fixed simulated management defers to settlement before booking partials or changing the stop. The existing final-exit priority remains in effect. |
| TP1 gives back existing stop protection | A long trailing stop at 102 was reset to entry 100 on TP1; short 98 was reset to 100. | Both the simulated and broker-facing managers preserve whichever of the existing stop and break-even is tighter. Tests cover persisted and replacement stop values for both directions. |
| Demo partial exits omit entry fees | The Demo adapter constructed `fees: 0`. TP1/TP2 therefore omitted their entry-fee share; final settlement charged only the remainder's share. | Supply the original full-size taker entry fee to the shared fill model for prorating. In the reload fixture, net profit changes from 4.789980 to 4.739955; total fees are 0.205045. The full entry fee is charged exactly once. |

Implementation sources: `artifacts/api-server/src/lib/candleWindows.ts`, `backtestEngine.ts`, `botEngine.ts`, `intelligence/research/runner.ts`, `strategy.ts`, `strategies/micro-scalping.ts`, `execution/fillModel.ts`, `execution/demoExit.ts`, and `tradeManager.ts`.

These are correctness changes to existing functions. No risk limit, strategy threshold, leverage setting, authority gate, account setting or deployed service was changed. Existing unrelated worktree edits were preserved. The initial audit performed no commit, push, PR, merge, deployment or broker order. The subsequently requested PR is described below.

## What still prevents a professional trading claim

### 1. Confidence is a heuristic score, not a probability of profit

`strategies/micro-scalping.ts` computes confidence from a base of 52 plus volume, slope and macro bonuses. `strategy.ts` blends strategy and structure scores with weights 0.7 and 0.3. `strategies/selector.ts` ranks plans by this score. This does not establish that a score of 80 wins 80% of the time, nor that an 80-score setup has higher net expectancy than a 65-score setup. Several indicators are transformations of the same price series, so agreement is not automatically independent evidence.

`botEngine.ts` evaluates the council after the selector and records its Shadow output. Approved memory influence can tighten admission rules, but that is not the same as a learned and calibrated replacement for the entry policy.

**Solution:** use the existing journal and research pipeline to measure realized net R by strategy, side, regime and score band. Compare ranking by score against ranking by validated expected net return and downside. Preserve an abstention outcome when evidence is insufficient. Do not route an LLM directly to orders on the assumption that language reasoning creates an edge.

### 2. Nominal reward/risk does not describe the full exit policy

The selector's `netRewardRisk` uses the final TP distance. Actual payoffs include TP1/TP2 reductions, break-even, trailing, timeouts and costs. For illustration, half exited at +1R and half at +2R yields +1.5R gross even if the final target is labelled +2R. Moving the remaining stop to entry is also not a cost-free exit.

The current source's spot assumptions are 0.1% fees and 0.05% slippage per leg: approximately 0.30% round trip. Its futures taker assumptions imply approximately 0.20%. These are code assumptions, not verified fees or spreads for the user's account. Small targets leave little room after those costs. The repository already has a cost-aware floor; passing it alone does not establish profitable expectancy.

**Solution:** evaluate the existing entry with its complete realized exit distribution. Compare current ladder, full-position exit and current trailing behavior on identical causal data, without tuning against the final evaluation period. Do not widen stops, increase leverage or lower admission thresholds merely to increase activity.

### 3. Some adaptive blocking rules use weak evidence

`botEngine.ts::updateBlacklist` recomputes the last ten genuine closes and sets expiration to `now + 24 hours` every scan when win rate is below 40%. Since a blocked symbol cannot generate a new trade to change that sample, continued scans can keep renewing the same evidence indefinitely.

The same rule ignores payoff magnitude: three large winners and seven small losses can be profitable despite a 30% win rate. `isToxicHour` blocks an hour when aggregate P&L over the recent date window is negative, without requiring a minimum outcome sample. A single loss can therefore influence admission.

**Solution:** anchor temporary blacklist expiry to the latest newly evaluated outcome so old evidence cannot renew itself. Separately validate a net-expectancy and sample-aware rule before changing the current risk policy. These rules remain unchanged in this patch; changing their financial admission behavior needs a separately reviewed risk-policy correction.

### 4. Broker and replay exits still have material differences

`exitManager.ts::evaluate` attempts a timeout market close before cancelling protection. Its own `closeManually` method documents why Spot OCO protection must release reserved inventory before a market sell. The timeout path therefore has a concrete reservation-ordering defect that can prevent its configured deadline from taking effect.

`TradeManager.fillPartial` submits a market partial and charges taker fees. The shared simulated fill model assumes a trigger-level partial with slippage and maker fees. This can flatter futures replay relative to actual partial execution. Final settlement also uses estimated costs, not a complete broker fill ledger.

**Solution:** repair timeout cancellation, fill-race reconciliation and protection restoration together, then verify them against the broker sandbox. Align replay partials with the existing actual order type and observed execution prices. The timeout order path and partial fee policy were not changed here because changing reservation handling or cost assumptions without those checks would leave a material unresolved boundary.

### 5. Allocation depends on scan order

`botEngine.ts` processes `candleResults` in configured pair order, selects a plan within each symbol and executes before assessing later symbols. Earlier qualifying symbols can consume available slots. Although `StrategySelector.rankAll` exists, it is not the scan's allocation path. This is not proof that the chosen trades lose money; it is a reason the current system may not select the best available portfolio opportunity.

**Solution:** compare the current sequential allocation with collecting eligible candidates and ranking them by validated net expectancy under the same portfolio limits. Implement only if the comparison supports it; this is a sequencing change, not a reason to add more strategies.

### 6. Percentage risk is not necessarily an all-in loss budget

`strategies/base.ts::computeQty` divides the percentage risk amount by entry-to-stop distance, then applies the notional cap. Fees and adverse execution are absent from that denominator. The separate dollar-risk model has different semantics and must not be conflated with this path.

**Solution:** define the configured budget explicitly as price risk or all-in loss. If it is intended as all-in loss, size against stop distance plus conservative costs, then enforce exchange rounding and portfolio limits again. Keep existing configured limits; validate the accounting meaning before changing sizing behavior.

## Remaining evidence limitations

- Existing backtest and Demo results must be treated as pre-fix measurements. This patch does not rewrite historical results or demonstrate improved future returns.
- Coarse backtests still reuse primary candles in finer timeframe slots. A 15-minute replay is not an exact reproduction of the live 1/3/5/15/60-minute strategy. Exact alpha validation should use the existing 1-minute data route.
- Ordinary replay uses 101 primary candles and 100 aggregate candles; research retains 101-bar windows while the live signal path retains 100. This warmup difference remains and must be resolved before claiming exact decision parity.
- Ordinary replay timestamps and intrabar management assumptions still merit a complete event-clock comparison. The causal-window correction alone does not certify every aspect of replay.
- OHLC cannot establish whether a bar's high or low occurred first. The fixed-manager correction is conservative for a pre-existing stop; adaptive management and newly moved stops still need event-level parity assessment.
- Stale/missing history, actual spreads, funding, market impact, broker fills, connectivity and production account state were not measured here.

## Improvement sequence using existing capabilities

1. Review and validate these correctness fixes against the actual deployed revision. Run the DB and broker-dependent checks before deployment.
2. Resolve the remaining reservation, cost and clock discrepancies. Freeze the resulting code, configuration, costs and dataset identities so the same strategy means the same thing in replay and forward Demo.
3. Recompute existing strategy results on causal historical data. Attribute net R, average win/loss, profit factor, drawdown, cost share, exposure and turnover by strategy/side/regime. Review entry quality separately from exit damage.
4. Use purged chronological walk-forward evaluation, an untouched final period, and selection-bias controls across all tried candidates. Do not repeatedly optimize against the final holdout. Backtest overfitting can select patterns that fit historical noise rather than future returns; see Bailey et al., [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).
5. Keep only existing strategies with defensible positive net expectancy and tolerable downside; retain abstention for unsupported conditions. Forward-test the exact same code and limits before any human-approved financial promotion.

The decisive account evidence is a read-only export for one identified deployment and period: trades and partials, original plans, signal/capture timestamps, strategy/config identities, actual entry/exit fills, fees/funding, exit reasons, equity and rejected decisions. Separate internal Demo, testnet and real Live. Without this, no honest analysis can rank the user's actual sources of loss or give a measured profitability forecast.

## Executed verification

- Before corrections: signal regression had 7 failing assertions; fill regression had 6; Demo partial-fee and final-net assertions reproduced missing costs. Both old replay window functions reproduced the future-tail mutation.
- After corrections: all 49 programs in the API `test` script passed, including 3 newly registered harnesses. Coverage includes sizing, dollar risk, portfolio risk, authority, fills, management, research validation, metrics and signal determinism.
- The separate `pretest` Phase 10 program initially failed its CLI smoke checks because direct Node execution lacked `npm_execpath`. It passed on retry with the installed pnpm path and a temporary dependency-auto-install override. No dependency manifests or lockfile were changed to repair the environment.
- API TypeScript check passed: `node node_modules/typescript/lib/tsc.js -p artifacts/api-server/tsconfig.json --noEmit` from the repository root.
- `git diff --check` passed. New helper/test files were formatted; broad pre-existing source formatting was not rewritten.
- Tests used the existing tsx runtime with a temporary `ESBUILD_BINARY_PATH` pointing to the already installed Windows executable. No real trading was exercised. Manager/accounting tests use isolated test doubles at the persistence/provider boundary.
- PostgreSQL integration, provider sandbox, live broker execution, full historical replay and production deployment were not executed. No measured alpha or profitability result is claimed.

New regression files: `backtest-causality.test.ts`, `trading-signal-regressions.test.ts`, and `trade-manager-stop-regressions.test.ts`. Existing `fill-model.test.ts` and `demo-management-persistence.test.ts` now cover the additional regressions.

## PR preparation

The owner subsequently requested publication of these fixes. They were transferred as a focused patch onto remote main `bd5b00fd1ad9135bbcaec0ba758ae67116c48049` in a separate worktree. Unrelated edits from the original checkout were excluded.

Validation on that PR branch passed the full workspace `pnpm run typecheck` and the current API `pnpm --filter @workspace/api-server run test`: 52 main harness programs plus the separate Phase 10 precheck. Dependencies were installed from the unchanged frozen lockfile using pnpm 10.34.5, with lifecycle scripts disabled for the local Windows installation and the existing Windows esbuild binary supplied temporarily. Deployment, provider testing and measured profitability remain outside this publication step.
