# ADR-012: Safe manual trading architecture gate

- Status: Proposed - not implemented
- Date: 2026-08-27
- Decision owners: TradeCore engineering and the human financial authority
- Scope: Future manual order entry only

## Context

The Cactus AI Dashboard includes Manual as a target trader-intelligence mode, but the audited baseline has no safe user-originated entry contract. A browser form or a direct broker-adapter route would create a parallel financial path that bypasses durable intent, deterministic risk, protection, reconciliation, recovery, and audit.

The redesign must not make an unsupported capability look available. Manual therefore remains absent from the selector until the backend capability is complete, independently reviewed, and enabled by the server.

## Proposed decision

If approved, introduce a deterministic three-stage contract:

1. `preview` validates symbol, side, order type, quantity or bounded risk instruction, protective levels, account context, market state, broker capability, and current deterministic risk without creating execution authority.
2. `revalidate` binds the reviewed preview to fresh market/account/risk state, canonicalizes all financial fields, and returns an expiring immutable fingerprint.
3. `submit` accepts the exact fingerprint and one idempotency key, performs Live step-up where applicable, then creates the existing mandatory execution intent and continues through the existing execution, protection, reconciliation, recovery, and audit path.

The user instruction is an origin of intent, not a risk bypass. The server computes size, exposure, leverage, loss, freshness, and authorization. Unknown or stale evidence fails closed. A timeout after dispatch remains an ambiguous outcome that requires reconciliation; the UI does not resubmit automatically.

Manual entry must not call a broker adapter directly and must not introduce a second executor. Position reduction, protective exit, and recovery authority retain their existing semantics.

## Required approval and evidence

This ADR does not approve implementation. Before work begins, decision owners must review the exact API, data model, idempotency scope, state machine, Live step-up, origin/CSRF boundary, provider ambiguity handling, and audit evidence.

Acceptance requires deterministic unit tests, database-backed concurrency and intent tests, Live authorization refusal tests, protection and recovery tests, stale/unknown-state tests, provider sandbox evidence when separately authorized, accessible browser confirmation tests, and explicit proof that no parallel broker path exists.

Until then, `GET /api/capabilities` reports Manual unsupported and the frontend renders no order ticket.

## Rejected alternatives

- Frontend-only validation: client state is not authoritative.
- Direct REST-to-broker submission: bypasses the existing financial safety path.
- Reusing Co-Pilot approval with fabricated recommendations: destroys provenance and authority semantics.
- Optimistic submission success: conceals ambiguous provider outcomes.
- Enabling Manual behind a local-storage flag: UI state cannot grant execution authority.
