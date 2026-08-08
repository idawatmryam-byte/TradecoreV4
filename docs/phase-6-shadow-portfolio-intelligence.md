# Phase 6 — Shadow Portfolio Intelligence

Status: **implemented as a Shadow candidate; not authorized for financial execution**

Phase 6 changes the unit of analysis from an isolated symbol to one complete
same-scan opportunity set. It ranks opportunities first, then projects bounded
risk allocations while accounting for existing positions and reservations made
earlier in the same cycle.

It does **not** change the Brain V0 scan loop, Demo execution, Co-Pilot, or Live
execution. The portfolio module imports no broker or executor and every public
projection contains:

- `mode: "shadow"`
- `cannotExecute: true`
- immutable policy, context, source, and projection fingerprints

The VPS no-trade incident reported after the server update remains a separate,
deferred operational incident. Phase 6 must not be used to mask it by lowering
thresholds, bypassing risk gates, or changing execution behavior.

## Decision flow

```text
latest complete Shadow council scan
+ open position stop-risk state
+ deterministic account risk configuration
+ pair-correlation observations
        |
        v
validate point-in-time inputs and freshness
        |
        v
rank the complete opportunity set
        |
        v
allocate sequential bounded Shadow budgets
        |
        v
Portfolio Intelligence projection + UI
        |
        v
NO execution path
```

## Contracts

The implementation lives under
`artifacts/api-server/src/lib/intelligence/portfolio/`:

- `types.ts` — versioned input, policy, assessment, risk-usage, and projection
  contracts.
- `planner.ts` — pure deterministic ranking, clustering, constraint, and
  reservation logic.
- `assemble.ts` — adapts current Shadow council runs, open positions, account
  state, configuration, and correlations into one point-in-time input.
- `index.ts` — public module boundary.

The read-only route is `GET /api/intelligence/portfolio`. It is protected by
the existing authentication and market-section middleware. The OpenAPI 3.1
source is authoritative and includes every Phase 6 response schema.

## Ranking

Ranking and allocation are deliberately separate. The score is a conservative
weighted composite of:

| Component | Weight | Meaning |
|---|---:|---|
| Reward/risk quality | 22% | Cost-aware planned reward/risk, capped to a stable range |
| Decision support | 20% | Deterministic council strength |
| Regime suitability | 15% | Suitability of the opportunity for the observed regime |
| Diversification | 14% | Benefit after known reinforcing portfolio exposure |
| Liquidity quality | 10% | Current volume-based liquidity proxy |
| Cost quality | 10% | Penalty for projected fee/slippage burden |
| Uncertainty quality | 9% | Explicit uncertainty penalty |

Ties are resolved deterministically by symbol and decision identifier.
Correlation values that are absent remain unknown; they are never converted to
zero.

The API exposes `estimatedNetR: null` until a calibrated expectancy model
exists. Confidence is not relabeled as expected return.

## Allocation controls

For each ranked `ENTER_NOW` opportunity, the planner computes the strictest
allowable allocation across:

- portfolio stop-risk budget;
- per-strategy stop-risk budget;
- symbol notional concentration;
- signed net exposure;
- reinforcing correlation-cluster notional;
- remaining position slots;
- drawdown de-risking;
- stale/expired decision refusal;
- data-health and mixed-scan refusal;
- unknown-correlation policy;
- executable plan and stop-geometry validation.

An accepted Shadow allocation is immediately reserved in the projection before
the next candidate is considered. This prevents simultaneous candidates from
reusing the same risk budget.

`WAIT_FOR_TRIGGER`, `OBSERVE`, and `REJECTED` are first-class outcomes and
reserve no risk. Cash/no-trade is always available.

## Current limitations

The UI surfaces these limitations rather than hiding them:

- broker free balance currently supplies both equity and available balance;
  unrealized equity is not yet authoritative;
- drawdown is a current-day realized-P&L proxy, not peak-to-equity drawdown;
- liquidity uses observed volume, not order-book depth;
- correlation coverage depends on sufficient closed daily candle history;
- the projection is process-local and represents the current engine's latest
  settled council scan;
- projected allocation does not reserve real broker or database funds;
- the exposure scenario is a linear directional estimate and is not a
  guaranteed loss.

A limitation makes the projection degraded or blocked according to whether
safe Shadow analysis remains possible.

## UI/UX

The Portfolio navigation now opens `/portfolio`, with the existing Trade Log
and Journal retained as subordinate routes. The workspace includes:

- a permanent **Shadow — cannot execute** banner;
- healthy, degraded, and blocked data states;
- open, pre-reserved, Shadow-reserved, and remaining stop-risk budget;
- strategy allocation and correlation-cluster summaries;
- the ranked opportunity set with disposition and reason codes;
- explicit “Unavailable — uncalibrated” net expectancy;
- retained-cash reasons;
- a clearly bounded exposure scenario control;
- loading, empty, failure, responsive table, and refresh behavior.

## Verification

The deterministic harness covers:

- identical-input fingerprints and deterministic identifiers;
- source-decision lineage;
- same-strategy and portfolio-wide simultaneous reservations;
- rank-before-allocate behavior;
- correlation-cap reductions and unknown-correlation policy;
- drawdown hard stops;
- stale decisions and mixed scans;
- waiting/observing with zero reservation;
- open-position stop risk, including favorable trailing stops;
- non-finite inputs, conflicting correlations, invalid stop geometry, and
  policy validation;
- structural `cannotExecute` and untouched cash guarantees.

## Promotion requirements

Phase 6 may influence Demo or Live only after a separate reviewed promotion
change proves all of the following:

1. The deferred VPS no-trade incident has a documented root cause and verified
   fix.
2. Authoritative equity, unrealized P&L, current marks, and stop state are
   available point-in-time.
3. Reservations are durable and concurrency-safe across workers.
4. Portfolio-level backtests and walk-forward attribution pass predetermined
   gates.
5. Shadow/forward performance, calibration, costs, and drift are acceptable.
6. Approval-time risk and market state are revalidated.
7. Deterministic risk remains the final veto authority.
8. The promoted version and bounded mandate receive explicit human approval.

Until then, Phase 6 is an observable research capability only.
