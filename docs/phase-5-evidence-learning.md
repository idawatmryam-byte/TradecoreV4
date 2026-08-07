# Phase 5 — Evidence-Based Learning and Memory

Status: implemented candidate  
Scope: Research, Shadow, and tightening-only decision influence  
Financial authority: no new authority

## Decision

TradeCore will extend its existing point-in-time knowledge and memory-influence
foundation into a versioned evidence lifecycle. It will not introduce a
self-tuning model or allow recent outcomes to rewrite strategy parameters.

The lifecycle is:

```text
closed outcomes
  -> point-in-time conditional evidence
  -> sample gate + uncertainty + BH correction
  -> chronological walk-forward validation + embargo
  -> Shadow rule version
  -> explicit human approval of the exact version
  -> ACTIVE tightening-only influence
  -> suspension or explicit rollback
```

Validation and authorization are separate state transitions. An `improved`
validation creates or refreshes a Shadow version and never writes the active
version into account configuration. Activation requires the user to confirm
`APPROVE_WITHHOLD_ONLY`; rollback requires
`ROLLBACK_TO_VALIDATED_VERSION`.

## Why this architecture

### Selected: immutable evidence plus a mutable lifecycle projection

- Append-only snapshots preserve exactly what was knowable and reviewed.
- A small lifecycle table makes approval, activation, suspension, and rollback
  operationally queryable without rewriting history.
- The engine loads the exact frozen `InfluenceState` that passed validation. It
  never rebuilds a similar-looking state at execution time.
- Demo and Live records remain separate. A version validated for one execution
  target fails closed on the other.

### Rejected: automatic approval after a good validation

This conflates a statistical result with financial authorization. It also makes
an unattended validation job capable of changing behavior. Phase 5 removes that
path for Demo and Live.

### Rejected: online parameter tuning after recent losses

Recent losses are not proof of structural change. Continuous tuning magnifies
multiple-testing and regime-noise risk, makes decisions difficult to reproduce,
and creates an unreviewed write path into strategy behavior.

### Deferred: learning that increases conviction

Positive evidence remains descriptive. Phase 5 permits only `withhold` (and
reserves `reduce-risk` for a later bounded risk adapter). Evidence cannot lower
a confidence bar, originate a plan, increase size, or widen a mandate.

## Statistical contract

- Outcomes are available only at `closedAt`; open trades never teach the model.
- Conditional views cover strategy/regime, symbol/strategy, symbol class,
  direction, volatility, session, confidence bucket, and management policy.
- A cell needs at least 30 outcomes before publishing estimates.
- Win rate includes a 95% Wilson interval.
- Expectancy and average R include 95% mean intervals when computable.
- Every eligible cell enters one Benjamini–Hochberg family with a predetermined
  false-discovery-rate budget.
- Validation is chronological, fits only the training window, applies a
  24-hour embargo, and needs at least 40 later outcomes.
- A candidate is refused when it withholds more than half the validation flow,
  fails to improve expectancy, or has degraded drift.
- Decay is displayed as evidence age/weight. It does not silently change a rule.

## Outcome fidelity

The read model records net P&L and, where source coverage is complete, gross
P&L, fees, slippage, R-multiple, MAE, and MFE. Coverage is reported explicitly.
Historical trades have no time-to-MAE/MFE timestamps; those fields remain null
instead of being reconstructed or fabricated.

## Security and operational properties

- Lifecycle endpoints are account- and section-scoped by existing middleware.
- Exact version and execution-target checks occur at the engine permission seam.
- Unknown, stale, missing, malformed, or non-active lifecycle state is inert.
- The existing kill switch suspends the active version and clears configuration.
- Every completed validation, promotion, refusal, supersession, suspension, and
  rollback writes an append-only audit event.
- At most one active rule version is selected by configuration; promoting a new
  version suspends the previous active row in the same transaction.

## UI contract

Learning & Evidence distinguishes observations, Shadow findings, validations,
and executed authority. It shows sample size, uncertainty, FDR/q-value, data
cutoff, drift, decay, economic outcome coverage, and permitted behavior. Users
must review and type an exact confirmation phrase before activation or rollback.

## Known limits

- Phase 5 does not claim profitability and cannot guarantee regime persistence.
- The current validation is one chronological train/validation run with an
  embargo. Multi-fold purged cross-validation and untouched holdouts belong to
  Phase 8's Experiment Lab.
- Drift is measured and shown; automatic suspension thresholds are introduced
  with the Demo Autopilot control plane in Phase 10.
- Evidence can tighten entry admission only. Bounded risk reduction is reserved
  until portfolio risk budgets exist in Phase 6.
