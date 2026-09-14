# Internal Development Notes

> Note: These development and debugging notes were moved from the main README.md to preserve history while keeping the public presentation clean.

## Current focus: engine profitability (Phase 10)

The founder-reported symptom — the engine fires too few trades and isn't
profitable — traced to a real bug, not a strategy-quality problem: the
dollar-risk sizing model **hard-rejected** any signal whose target the
coin's volatility couldn't reach inside the hold window, where the
percentage model has always **adapted** the target down instead. That
asymmetry produced both the low trade count (thousands of same-stage
rejections) and the weak win/loss profile (trades that did fire were
scraped out before target).

Shipped so far:

- **Confidence integrity fix + signal funnel** (merged) — both executors
  were stamping the wrong confidence value on stored trades; a new
  `GET /decisions/funnel` endpoint and dashboard panel now surface
  considered → rejected-by-stage → executed counts, so a 100%-rejection run
  is visible instead of silently reading as "the engine is lazy."
- **Dollar-risk model now adapts unreachable targets instead of rejecting
  them** (merged) — `adaptTargetToReachable()` shrinks only the profit
  target to what the coin can deliver, holding the user's configured max
  loss and leverage exactly fixed; every adaptation is written into the
  trade's `DecisionReport` in plain dollars, never applied silently. Fixed
  in the legacy dollar-plan path (`selector.ts`) and in the two
  strategies (`momentum_breakout`, `twenty_min_momentum`) whose own
  `decide()` methods had an identical, independently-duplicated hard-reject.
  Harness evidence: an isolated run of `twenty_min_momentum` — the
  strategy behind most of a real account's trades — went from 0 trades
  (100% rejected at this exact stage) to trading normally after the fix.

Still open:

- Correcting `momentum_breakout`'s oversized default risk-per-trade and
  auditing every strategy's max-loss/trade-amount ratio for consistency.
- Closing the win/loss size asymmetry (small wins, larger losses) via
  harness-validated, one-variable-at-a-time changes to trailing-stop
  eagerness, hold-window length, and break-even timing.
- A Demo-mode soak on real market data comparing trade count, take-profit
  hit rate, and win/loss R against the pre-fix baseline, before any of this
  reaches Live.
