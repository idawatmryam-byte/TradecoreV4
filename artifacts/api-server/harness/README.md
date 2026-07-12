# Backtest-Validation Harness

A reproducible loop for validating **one engine change at a time** against a
fixed dataset, so alpha/decision-logic changes can be judged on evidence
instead of intuition — the "validate through backtesting before deploying"
discipline, made runnable.

## Why it exists

Changes to the decision core (regime detection, confidence scoring, breakout
confirmation, the macro filter) all change *which trades fire*. You cannot
tell whether such a change helped or hurt by reading the diff — you have to
run it. This harness runs the **real** backtest engine (`runBacktest`) over a
**deterministic** dataset and snapshots the metrics, so:

```
baseline  →  change ONE thing  →  variant  →  compare
```

Any metric delta is attributable to the code change alone.

## Honest limitation — read this

This sandbox cannot reach any exchange (Binance is geoblocked; all other
hosts are proxy-blocked), so the seeded candles are **synthetic**, not real
market data. Therefore:

- ✅ Valid: harness correctness, that a change runs end-to-end, and the
  **relative** effect of a one-variable change on a fixed dataset.
- ❌ Not valid: real-world profitability. Absolute P&L on synthetic data is
  meaningless — **only the delta between two runs on the same data matters.**

Everything downstream reads from the `historical_candles` table, so on
infrastructure that can reach Binance (e.g. the VPS) you swap the synthetic
seed step for `ensureCandles()` (real data) and the rest is unchanged. That
is the only step that is synthetic.

## Faithful mode

The runner passes `perStrategyConfigs: true`, so every strategy trades with
**its own** SL/TP/confidence/risk — exactly what the live bot uses. (The
interactive Backtest UI instead flattens all strategies to one run-level
SL/TP; that's a single-config sweep tool, not a live replay. See
`src/lib/backtestConfig.ts`.)

## Usage

```bash
# 0. One-time bootstrap: start PG, create DB, push schema, seed candles.
bash harness/setup.sh
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tradecore
TSX=../../scripts/node_modules/.bin/tsx   # tsx lives in the scripts workspace

# 1. Snapshot the current engine.
$TSX harness/run.ts --label baseline

# 2. Make ONE change in the engine, then snapshot it under a new label.
$TSX harness/run.ts --label unified-confidence

# 3. Compare.
$TSX harness/compare.ts baseline unified-confidence
```

`run.ts` flags: `--label` (required), `--start ISO`, `--end ISO`,
`--symbols BTCUSDT,ETHUSDT,SOLUSDT`, `--balance 1000`. Defaults match the
window `generate-data.ts` prints.

## Files

| File | Role |
|------|------|
| `setup.sh` | Idempotent DB bootstrap + seed. |
| `generate-data.ts` | Deterministic, regime-diverse synthetic 1m candles → `historical_candles`. |
| `run.ts` | Runs `runBacktest` (faithful mode), snapshots metrics → `results/<label>.json`. |
| `compare.ts` | Side-by-side diff of two snapshots, with a better/worse verdict per metric. |
| `results/` | Snapshot JSONs (gitignored — reproducible on demand). |

## Reading a comparison

A change is a genuine improvement only if it moves the headline metrics
(win rate, profit factor, expectancy, return) the right way **without**
quietly wrecking another — e.g. a higher win rate bought with a much worse
max drawdown or profit factor is not a win. The determinism check (run twice,
expect all Δ = 0) confirms the loop itself adds no noise.
