# Phase 9: Co-Pilot and Human Approval Workflow

## Outcome

Phase 9 turns the existing Co-Pilot recommendation screen into the supervised
authorization boundary for a single controlled execution attempt. It does not
add autonomous behavior and it does not promote the Phase 8 Shadow council.

## Proposal record

Every new Co-Pilot proposal stores:

- the immutable Brain V0 trade plan and fingerprint;
- the same-scan Shadow unified-brain/council decision and specialist evidence;
- market/regime state and data timestamp;
- portfolio projection and creation-time risk checks;
- thesis, trigger, invalidation, target rationale, expected path, and duration;
- plan, brain, council, market-state, portfolio, risk, and management versions;
- frozen Demo/Live target, creation time, expiry, limitations, and a single-use
  approval challenge.

The bundle has its own deterministic fingerprint. Approval requires both the
plan and bundle fingerprints shown to the user.

## Approval lifecycle

The approval states presented to users are `PROPOSED`, `APPROVABLE`, `APPROVED`,
`REJECTED`, `EXPIRED`, `STALE`, `INVALIDATED`, and `EXECUTION_BLOCKED`.
Persistence keeps the corresponding deterministic lifecycle states rather than
collapsing them into a generic failure.

Approval requires an exact authorization phrase and an idempotency key. The API
atomically claims a proposal once, then performs fresh revalidation. A failed
check resolves the proposal to the appropriate terminal state. The original
challenge can never become a future execution instruction.

Bounded user changes may only reduce quantity or tighten the protective stop.
They create a new, fingerprinted child proposal and supersede—never mutate—the
original. A changed target, larger quantity, or wider stop requires a new engine
proposal.

## Fresh revalidation

Immediately before using the existing approved-plan execution path, TradeCore
checks current:

- Co-Pilot mode and the frozen execution target;
- proposal expiry and plan/bundle integrity;
- ticker freshness and market-state health;
- regime consistency and thesis invalidation;
- engine state, circuit breaker, and risk pause;
- reconciliation and executor eligibility;
- open positions, portfolio risk, symbol exposure, net exposure, and correlated
  exposure;
- sizing validity, execution-cost viability, and price drift.

Any ambiguous or unavailable financial state fails closed. Passing these checks
does not bypass downstream execution safeguards; the approved plan flows through
the existing `BotEngine.executeApprovedPlan` architecture.

## Authentication and audit

Cookie-authenticated financial mutations require a verifiable same-origin
request. Live approval additionally requires the account's current password.
Basic-auth requests are password-verified on every request. OAuth-only accounts
without a password cannot approve Live trades until a stronger reviewed step-up
method exists.

Proposal creation, approval request, authorization, rejection, expiry,
invalidation, refusal, blocking, and execution results are append-only audit
events attributed to the relevant engine, user, or system actor. Events bind the
proposal fingerprints, target, state transition, reason code, and safe validation
result. Secrets and credentials are excluded.

## Operations

Before deploying this API version, apply the database schema through the
repository's reviewed database deployment workflow. Do not start the new API
against an old recommendations schema.

Phase 8's current `REMAIN_RESEARCH` result remains a prerequisite to revisit
before giving the unified council any later execution authority. Phase 10 also
requires its own mandate, promotion evidence, soak, and operator approval.
