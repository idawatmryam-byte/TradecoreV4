# ADR-006: Phase 6 Portfolio Intelligence Runs in Shadow Before Execution

**Status:** Accepted  
**Date:** 2026-08-08  
**Deciders:** TradeCore founder and engineering  
**Scope:** Phase 6 portfolio context, opportunity ranking, and bounded allocation

## Context

TradeCore already enforces per-candidate limits for stop risk, symbol concentration,
net exposure, and measured correlation. Those checks are valuable, but the engine
still reaches them one symbol at a time. The first qualifying symbol can therefore
consume capacity before a later, stronger candidate is visible.

The Phase 4 Decision Council is structurally Shadow-only, and Phase 5 evidence can
only tighten decisions after explicit approval. The production VPS also has an
unresolved no-trade incident. Replacing the current Demo/Live selector while that
incident is unresolved would confound diagnosis and grant an unvalidated component
financial authority.

## Decision

Phase 6 introduces a deterministic portfolio-intelligence boundary that:

1. Builds one point-in-time portfolio context from current equity availability,
   open positions, current stops, exposure, drawdown, and correlation evidence.
2. Considers only Shadow decisions from the same scan timestamp.
3. Scores every opportunity using disclosed components rather than a fabricated
   probability or expectancy.
4. Ranks first and allocates second.
5. Reserves position slots, stop risk, strategy risk, symbol notional, net
   exposure, and correlated-cluster capacity as each ranked candidate is assessed.
6. Keeps cash as a valid allocation and records why capital was retained.
7. Returns explicit blocked, degraded, stale, waiting, rejected, and
   Shadow-allocated states.
8. Exposes the projection through a read-only API and Portfolio Intelligence UI.
9. Does not call an executor, broker, approval path, or mutate Brain V0 behavior.

The projection fingerprint includes the complete context, policy, correlations,
candidates, and allocations so the same inputs produce the same result.

## Options Considered

### A. Replace the current symbol loop immediately

| Dimension | Assessment |
|---|---|
| Complexity | High |
| Financial risk | High |
| Auditability | Medium |
| Current suitability | Rejected |

**Pros:** Delivers portfolio selection directly into execution.

**Cons:** Changes the money path during an unresolved production incident, makes
rollback attribution harder, and skips Shadow/forward validation.

### B. Compute rankings only when the UI requests them

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Financial risk | Low |
| Point-in-time fidelity | Medium |
| Auditability | Medium |

**Pros:** Small integration surface.

**Cons:** A request can arrive while a scan is still settling. This is acceptable
for the current live projection only if same-scan filtering and degraded-state
reporting are explicit; it is not yet sufficient as an execution authority.

### C. Deterministic same-scan Shadow projection

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Financial risk | Low |
| Point-in-time fidelity | High |
| Extensibility | High |

**Pros:** Exercises the complete portfolio math on real forward decisions without
touching execution. The boundary can later be persisted and promoted without
rewriting the planner.

**Cons:** It cannot improve executed allocation until a later promotion gate is
approved.

## Consequences

- Users can see portfolio capacity, ranked opportunities, simulated allocations,
  rejected candidates, correlation uncertainty, and retained-cash reasons now.
- Brain V0 remains the control and continues to own Demo/Live candidate order.
- “Expected net R” remains unavailable until a calibrated probability model
  exists. The UI shows reward/risk quality and an explicit uncalibrated label
  instead of manufacturing expectancy.
- The first promotion step after the VPS incident is resolved is append-only
  forward capture and Phase 8 portfolio backtesting; only then may the planner
  be considered for Demo execution.
- Per-strategy risk uses a conservative policy ceiling in Shadow. A future
  versioned user mandate may tighten it but cannot exceed deterministic account
  limits.

## Promotion prerequisites

- The VPS no-trade incident is diagnosed and closed.
- Fixed-fixture determinism and simultaneous-candidate tests pass.
- Portfolio projections are captured through a predefined forward window.
- Portfolio-level backtests attribute selection, allocation, and cost effects.
- Explicit human approval promotes an exact planner and policy version.
