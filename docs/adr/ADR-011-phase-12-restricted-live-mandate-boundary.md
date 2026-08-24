# ADR-011: Phase 12 Restricted Live mandate boundary

- Status: Accepted
- Date: 2026-08-24
- Decision owners: TradeCore engineering and the human financial authority
- Scope: Phase 12 only

## Context

Phase 10 permits autonomous entry only in Demo, testnet, or practice authority. Phase 11 makes every broker-backed command pass through durable intent, reconciliation, protection, drawdown, kill-switch, ownership-generation, and operating-mode controls. Phase 12 must add narrowly bounded human authority without creating a second execution engine or weakening either boundary.

A Live configuration or an approved brain version is not sufficient authority. Financial permission must name the exact brain and operational scope, have conservative monetary limits, expire, be revocable, survive restart, and be checked again at the last existing Live seam. Missing or stale evidence must not be interpreted as zero usage or healthy state.

## Decision

Introduce an immutable, revisioned `TradingMandate` plus mutable lifecycle and usage projections and append-only authorization, lifecycle, and decision evidence.

The only autonomous real-broker path remains:

`botEngine → deterministic risk → Restricted Live claim → LiveExecutor → Phase 11 authorization → mandatory intent → broker adapter`

The mandate is an additional necessary condition. It does not replace deterministic risk or the Phase 11 boundary. The brain cannot call mandate lifecycle services, write authority projections, or reach a broker adapter.

### Immutable authority

Each revision binds owner/tenant/section, server-derived opaque account identifiers, venue authority, market, symbol, exact strategy configuration version, model implementation, brain version and fingerprint, financial limits, IANA-timezone windows, effective time, exclusive hard expiry, canary allocation, suspension thresholds, and fallback policy. The server canonicalizes and fingerprints the complete record. Approved terms are never updated.

Renewal, reactivation, version change, account/symbol/strategy addition, or any risk change creates a replacement revision. Approval requires the reviewed financial role, origin checks, a current session, a fresh step-up, and a unique authorization identity tied to the exact fingerprint and session version.

### Lifecycle

`DRAFT → PENDING_APPROVAL → ACTIVE`

Authority-reducing transitions are `ACTIVE → SUSPENDED`, eligible states to `REVOKED`, `ACTIVE → EXPIRED` at the hard boundary, prior `ACTIVE → REPLACED` when its approved successor activates, and terminal evidence to `RETIRED`. Automatic systems may suspend or expire. They cannot activate, resume, renew, expand, or replace authority.

Only `ACTIVE` is executable. Suspended authority cannot be resumed in place; a new revision and new step-up are required. Revoked, expired, replaced, and retired records remain non-executable after restart.

### Financial precision and boundaries

Money uses non-negative integer atomic units at scale 8. Values derived from broker or floating-point plan data are conservatively rounded upward. Maximum risk, position notional, aggregate exposure, leverage, canary allocation, and market-data age are inclusive ceilings. Loss, drawdown, expiry, rate, spread, slippage, latency, divergence, and reconciliation-age suspension thresholds block at equality. Time windows are start-inclusive and end-exclusive. Expiry is exclusive.

The server computes current usage, realized loss windows, drawdown, and remaining capacity. Client-computed financial state is never accepted. Missing inputs fail closed.

### Boundary and races

A transactional claim binds mandate revision/fingerprint, decision and risk identities, plan and configuration fingerprints, ownership generation, reserved risk/notional, and idempotency key. The final Live callback locks both lifecycle and claim before changing the claim to `BOUNDARY_AUTHORIZED`.

Revocation/suspension and a broker command therefore have a deterministic database order. If authority reduction commits first, the command is refused. If boundary authorization commits first, that one durable in-flight command remains recorded as the final authorized command; later claims fail. Provider timeouts remain `OUTCOME_UNKNOWN` and require reconciliation. The system never resubmits merely because an outcome is unknown.

Mandatory Phase 11 intent persistence still occurs before any broker command. Exit, reduction, recovery, and protection authority remain available when new-entry authority is removed.

### Co-Pilot fallback

Only an otherwise valid opportunity refused solely for permitted account/venue/market/symbol/strategy/model or trading-window scope can become a labeled Co-Pilot proposal when the mandate selected `COPILOT_VALID_ONLY`. The proposal contains the original immutable decision and refusal reason, submits no broker command, and creates no autonomous executable intent. Tenant/user/section mismatch, malformed identity, stale data, deterministic risk refusal, kill switch, degraded safety, or exhausted limits cannot fall back.

Any later supervised execution returns through Phase 9 current-state revalidation and Phase 11 Live safety.

## Consequences

- Restricted autonomy is auditable and revocable without a parallel money path.
- Every expansion has high-friction, exact-revision human review.
- Operational availability is deliberately lower when telemetry is missing or stale.
- The runtime needs narrow column-level update grants for lifecycle, usage, and outcome projections; immutable terms and evidence have only select/insert privileges.
- The current single-process ownership model remains. Phase 12 does not authorize multiple PM2 instances or begin Phase 13 fencing work.

## Rejected alternatives

- A UI or route-only mandate check: stale workers and internal calls could bypass it.
- Direct brain-to-broker execution: duplicates the critical path and evades Phase 11.
- Editable active mandates: destroys authorization provenance and makes risk increases unauditable.
- Client-provided exposure or P&L: enables stale-state and tampering failures.
- Silent Demo-to-Live promotion: Demo evidence is a prerequisite, not financial permission.
- Automatic resume after telemetry recovery: authority increases require human review.

## Evidence boundary

Local deterministic tests, type checking, builds, and browser fixtures prove code behavior without provider access. PostgreSQL integration proves transactional and privilege behavior only when `DATABASE_URL` and the owner/runtime schema are available. Testnet/practice, VPS, provider, deployment, and real-money authorization are separate operational evidence and are not implied by this ADR or its pull request.
