# ADR-009: Phase 9 Co-Pilot Authorization Boundary

- Status: Accepted
- Date: 2026-08-10
- Scope: Co-Pilot proposal persistence, approval, revalidation, audit, and controlled execution

## Context

Co-Pilot proposals can outlive the market, portfolio, reconciliation, or risk
conditions that made them acceptable. A human click therefore cannot be treated
as a direct order instruction. Phase 8 also leaves the unified decision council
in Shadow with an implementation recommendation of `REMAIN_RESEARCH`; silently
promoting it to execution authority in Phase 9 would violate that result.

The existing execution architecture already owns broker abstraction, intent
tracking, reconciliation, deterministic risk controls, and Demo/Live target
selection. A parallel approval executor would duplicate and eventually diverge
from those safeguards.

## Decision

1. A recommendation persists an immutable, fingerprinted Phase 9 decision
   bundle. The bundle binds the Brain V0 plan to its same-scan Shadow council,
   market state, specialist evidence, portfolio projection, creation-time risk
   result, policy versions, target, creation time, expiry, and limitations.
2. Brain V0 remains the proposal and execution decision authority. Phase 8
   council output is explicitly labelled Shadow context until a later, separately
   approved promotion decision changes its authority.
3. Approval authorizes exactly one controlled execution attempt. It is bound to
   user, section, recommendation, plan fingerprint, decision-bundle fingerprint,
   frozen Demo/Live target, single-use challenge, explicit phrase, and hashed
   idempotency key.
4. A transactional compare-and-set claims `created -> executing` before any
   executor call. Concurrent or duplicate claims cannot produce a second
   execution attempt. A same-key retry returns the persisted outcome.
5. After the claim, the service freshly gathers current state and revalidates
   mode, target, expiry, plan/bundle integrity, market-data freshness, market and
   regime health, thesis validity, portfolio/position/exposure limits, sizing,
   costs, circuit breakers, reconciliation, and execution eligibility. Failure
   is terminal and fail-closed; materially changed proposals require a new
   proposal.
6. A passed approval calls the existing engine-controlled approved-plan path.
   It does not call a broker directly or create a second execution system.
7. Live cookie approvals require same-origin verification and current-password
   step-up. Basic auth is freshly password-verified on each request. OAuth-only
   accounts fail closed until a reviewed step-up mechanism exists.
8. Lifecycle transitions and refusals are append-only audit events. Passwords,
   session cookies, authorization headers, and reusable credentials are never
   included in those events.

## Alternatives considered

### Treat approval as a broker order command

Rejected. It makes a delayed approval more dangerous than normal controlled
execution because the original safety snapshot can be stale.

### Re-run the AI council at approval and mutate the proposal

Rejected. The user would approve one decision while the system executes another,
breaking traceability and meaningful consent. A materially different decision
must be a new immutable proposal.

### Promote the Phase 8 unified council now

Rejected. The committed Phase 8 report has not promoted that candidate. Phase 9
must not manufacture authority that Research did not earn.

### Add a dedicated approval executor

Rejected. It would bypass or duplicate the existing broker, reconciliation,
intent, and deterministic risk architecture.

## Consequences

- Approval can be refused after the user confirms, because current safety state
  is authoritative. The UI must explain the exact failed controls.
- A lost response is safely recoverable with the same idempotency key after the
  terminal outcome has been persisted.
- An ambiguous broker failure is terminally blocked for reconciliation; it is
  never silently retried as a fresh instruction.
- Deployment requires the recommendation and recommendation-event schema update
  before the API version is started.
- Phase 10 receives no autonomous mandate from this work. Any Demo autonomy
  remains a separate promotion and authority decision.
