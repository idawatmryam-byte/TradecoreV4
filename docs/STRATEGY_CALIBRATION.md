# Strategy Calibration & Tuning — Operator / VPS Guide

This is the runbook for improving the strategies with data instead of guesswork.
It covers two distinct jobs, and — this is the important part — **the honest
method that keeps each one from fooling you.**

The single failure mode both jobs must avoid: **overfitting.** A parameter set
that scores brilliantly on one backtest window is usually just curve-fit to that
window's noise. It looks like edge, ships, and evaporates the moment the market
changes. Every workflow below is built to reject that — it only accepts a change
that proves itself on data it was **not** fitted to.

> ⚠️ **Run everything here on REAL historical data**, i.e. on the VPS where the
> engine can fetch Binance/OANDA history. The sandbox's synthetic candles will
> run the machinery but produce **meaningless** trading conclusions.

---

## Job 1 — Calibrate the DEFAULT strategy values (global, benefits everyone)

The 8 crypto / 6 forex strategies ship with default parameter values
(`DEFAULT_STRATEGY_CONFIGS` in `artifacts/api-server/src/lib/strategies/base.ts`).
These were hand-set and never validated. Better defaults improve every new
user's out-of-the-box result and are a legitimate quality story for a sale
("defaults are walk-forward-calibrated, not hand-waved").

### The method: multi-window walk-forward voting

`harness/calibrate-defaults.ts` splits history into **N independent folds**
(different market periods). In each fold it runs the same walk-forward the
Optimization Autopsy uses — sweep the parameter grid on that fold's TRAIN
window, then measure the winner on its held-out VALIDATION window. A fold only
yields a suggestion if a candidate **beat the current default out-of-sample.**

Then it **votes**: a default only changes when a **majority of folds
independently agree on the same direction**, and the new value is the median of
the agreeing folds. A parameter that helps in one period but not the others is
left alone. That agreement-across-periods is exactly what separates a real
default from a lucky one.

### Run it (on the VPS)

```bash
cd artifacts/api-server
export DATABASE_URL=...            # the live DB (real candles)
TSX=../../scripts/node_modules/.bin/tsx

# One strategy first (fast), a full year, 3 folds:
$TSX harness/calibrate-defaults.ts \
  --section crypto --symbols BTCUSDT,ETHUSDT,SOLUSDT \
  --start 2024-01-01 --end 2024-12-31 --folds 3 --strategy trend_pullback

# Whole catalog (slower — many backtests): drop --strategy.
$TSX harness/calibrate-defaults.ts \
  --section crypto --symbols BTCUSDT,ETHUSDT,SOLUSDT \
  --start 2024-01-01 --end 2024-12-31 --folds 3
```

Forex: `--section forex --symbols EUR_USD,GBP_USD,XAU_USD --timeframe 15m`.

It creates temporary child backtest rows and **deletes them when done**, so it
never pollutes anyone's Backtesting list. It writes full evidence to
`harness/results/calibration-<section>-<ts>.json`.

### Read the output

For each strategy it prints, per fold, `▲` (a better config survived
validation), `=` (current config not beaten), or `·` (insufficient trades).
Then the proposed changes:

```
● trend_pullback
    targetProfitUsdt: 80 → 56   (3/3 folds agreed; per-fold: 56, 48, 64)
```

- **A change only appears when the folds agreed.** Trust those.
- **"No parameter change reached majority agreement"** is a real, honest
  result — it means the defaults are already reasonable *or* the strategy's edge
  doesn't live in these knobs on this data. Do **not** force a change.

### Apply a proposed default

Edit the value in `DEFAULT_STRATEGY_CONFIGS` (`base.ts`). Changing a default
**only affects newly-seeded config rows** — existing users' saved settings are
never overwritten (the loader uses `onConflictDoNothing`). Then re-run the
calibration on a *different* year to confirm the new value still holds up before
committing.

**The VPS Claude must PROPOSE these to the human, not silently edit `base.ts`.**
Show the table, let the user approve, then apply.

---

## Job 2 — Tune one account's live configs (per-user, your account only)

Different job: improving the strategy settings on **one account** using that
account's own situation. The safe tool for this already exists in-app — the
**Optimization Autopsy** — and it must be used *instead of* raw backtests,
because the Autopsy is walk-forward: it splits the data train/validation and
**only suggests a change that beats the current config on data it never saw.**
"No improvement" is a valid answer it gives. Raw backtest-and-tweak has no such
guard and will overfit.

### Supervised loop for the VPS Claude (account-scoped)

1. For each enabled strategy on the account, start an Autopsy (POST
   `/backtests/autopsy` with `X-Section`, or `startAutopsy(userId, …)`).
2. Apply **only** the suggestions whose verdict is `improved`, **through the
   API** (`PUT /strategies/:id`) so the config bounds and (for custom
   strategies) the backtest-first gate still protect the account. Never write
   raw config to the DB.
3. Log every change and post the summary for the human to review.

### Hard prerequisites (or it's noise)

- **Enough trades.** The Autopsy needs ≥10 validation trades to reach a verdict;
  the Selection Filter needs ≥20 per cell. On thin data every tool here honestly
  says "not enough yet — keep running." Respect that; don't lower the thresholds
  to force an answer.
- **Paper first, always.** Even a validated change is *historical evidence, not
  a guarantee.* Apply, then watch it on the testnet/practice engine before it
  ever means anything.

---

## The honest ceiling (put this in front of any buyer, too)

None of this manufactures edge that isn't there. Calibration and tuning make the
strategies the **best version of themselves**; they cannot make a strategy
profitable if its underlying signal has no edge in live markets. Backtest ≠
live. The value these tools deliver is **discipline** — every change is earned
out-of-sample and every change is reviewable — not a promise of returns.
