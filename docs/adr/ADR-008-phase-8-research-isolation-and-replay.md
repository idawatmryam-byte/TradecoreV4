# ADR-008: Phase 8 Research Isolation and Full-Brain Replay

- Status: accepted for Phase 8 implementation
- Date: 2026-08-09
- Authority: Research only

## Context

Classic backtests replay strategy entries and exits, but they cannot validate the
complete intelligence path introduced in Phases 1–7. Phase 8 must compare the
frozen Brain V0 control with a candidate that includes market state,
specialists, council, portfolio allocation, and bounded position management.
The comparison must be point-in-time, reproducible, tenant-scoped, and unable
to acquire Demo or Live execution authority.

## Decision

Create a dedicated `intelligence/research` boundary rather than adding Research
authority to `backtestEngine.ts` or a trading engine.

The boundary has two layers:

1. Pure, versioned contracts and computations for manifests, partitions,
   replay, stress, metrics, multiple-testing accounting, golden streams, and
   promotion reports.
2. An orchestration layer that loads validated historical provider data,
   persists an append-only replay stream, resumes interrupted deterministic
   jobs, and exposes tenant-scoped Research APIs.

The runner may reuse pure strategy logic, the shared simulated fill model, and
Phase 7 policy evaluation. It must not import a bot engine, broker client, order
executor, execution adapter, or deployment/provider configuration.

One active experiment is allowed per tenant and market section. The database
enforces this with a partial unique index. A run is additionally bounded by its
symbol count, requested date range, estimated decision count, persisted event
count, page size, and validated request body.

## Replay design

Each eligible timestamp is assigned to a purged walk-forward validation fold or
the untouched holdout. Training, purge, and embargo windows do not produce
evaluation events. Positions are liquidated at partition boundaries so state
cannot cross folds.

The runner produces four accounting lanes under the same candles and scenario
costs:

- Brain V0 control.
- Candidate selection before portfolio allocation.
- Candidate allocation with fixed management.
- Candidate allocation with Phase 7 adaptive management.

These lanes make selection, allocation, execution-cost, and management deltas
separately reportable. Perception and evidence attribution remain zero until a
candidate actually changes those inputs; unavailable historical evidence is
recorded as unavailable and cannot be treated as approved.

Base replay is run twice. A mismatch in either decision or management event
fingerprints invalidates the experiment. Predeclared stress scenarios change
fees, slippage, latency penalty, missing-data availability, and ambiguous
intrabar ordering deterministically.

## Authority and promotion

Every manifest and replay frame is `mode: research` and `cannotExecute: true`.
The API contains create/read/cancel/replay operations only. There is no promote,
deploy, configure-Live, or execute operation.

A report may recommend only:

- `REJECT`
- `REMAIN_RESEARCH`
- `ELIGIBLE_FOR_HUMAN_REVIEW`

Even the last state has `humanApprovalRequired: true`. It does not alter a
brain version, strategy configuration, risk policy, Demo authority, or Live
authority.

## Recovery and failure behavior

Lifecycle state is mutable; manifests, replay events, and terminal reports are
immutable contracts. On restart, active jobs are prepared from the persisted
request. The previous manifest timestamp is reused. If provider data or the
manifest fingerprint changed, resume fails closed. Already persisted replay
prefixes must reproduce byte-for-byte before the runner appends a suffix.

Cancellation is cooperative during preparation/replay and becomes terminal.
Invalid inputs, missing provider history, event-limit breaches, non-reproducible
prefixes, and failed golden streams do not fall back to synthetic data or a
trading path.

## Consequences

- Research evolves independently from Live execution.
- Full-brain evidence is larger than classic backtest output, so storage and
  concurrency are intentionally bounded.
- A process restart may recompute the deterministic prefix, but cannot silently
  accept a changed prefix.
- The first Phase 8 candidate has no point-in-time approved memory snapshot;
  evidence therefore remains unavailable rather than fabricated.
