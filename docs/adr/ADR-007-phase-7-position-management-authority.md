# ADR-007: Single-owner Phase 7 position-management authority

**Status:** Accepted

**Date:** 2026-08-09

**Deciders:** Product owner and TradeCore architecture owner

## Context

Before Phase 7, position management had implicit authority. Every broker-backed
open position passed through `TradeManager.manage`, followed by
`ExitManager.evaluate`; Demo positions passed through the fixed `manageBar`
simulation before settlement. There was no persisted owner field. Adding an
adaptive manager beside those calls would allow two policies to modify the same
position during one management cycle.

The Phase 7 roadmap originally recommended Research/Shadow-only authority until
the broader production money-path gates were complete. On 2026-08-09 the owner
explicitly approved active Phase 7 management for Demo, Binance testnet, and
OANDA practice, while preserving the real-Live prohibition and all deterministic
risk and reconciliation controls.

## Decision

Persist one management mode and one resolved owner on every new position:

| Configured mode | Environment                       | Mutating owner | Phase 7 behavior                                              |
| --------------- | --------------------------------- | -------------- | ------------------------------------------------------------- |
| `fixed`         | Any                               | Fixed manager  | Disabled                                                      |
| `phase7_shadow` | Any                               | Fixed manager  | Evaluate and append `SHADOW`; never mutate                    |
| `phase7_active` | Demo                              | Phase 7        | Bounded active management                                     |
| `phase7_active` | Binance testnet or OANDA practice | Phase 7        | Bounded active management through the existing execution path |
| `phase7_active` | Real Live                         | Fixed manager  | Defensive downgrade to Shadow; active authority refused       |

The assignment is pinned to the trade at entry with its thesis and policy
version. Runtime dispatch reads the pinned owner. It never chooses an owner from
an AI response or a mutable narrative.

When Phase 7 owns a position, the fixed adaptive manager is skipped. The
existing deterministic settlement layer remains active for stop loss, take
profit, liquidation, maximum duration, and emergency protection. That layer is
a safety boundary, not a competing adaptive owner.

Phase 7 may emit only `HOLD`, `REDUCE`, `TIGHTEN_STOP`, `APPLY_TRAILING`, `EXIT`,
or `FREEZE`. A deterministic validator checks every proposed mutation before the
approved `TradeManager`/`ExitManager` path can act. The policy permits one
bounded reduction, tighter-only stop changes, an approved ATR trailing policy,
and exit only on deterministic thesis invalidation. Missing, stale, degraded,
contradictory, or non-finite market data produces `DATA_UNCERTAIN` and `FREEZE`.

Every evaluation, proposal, validation verdict, and result is stored as an
append-only management event with fingerprints and policy lineage. Mutation is
preclaimed with a unique action fingerprint so a retry cannot repeat a reduction
or stop change.

## Options considered

### Run fixed and Phase 7 managers sequentially

Rejected. Order of execution would become an accidental priority rule, outcomes
would depend on timing, and two managers could replace protection or close the
same position.

### Use a process-local owner flag

Rejected. Restarts and horizontally scaled workers would not share the same
authority decision, and historical actions would not be reproducible.

### Persist one owner per position with fail-closed environment resolution

Accepted. It makes authority explicit, auditable, restart-safe, and independent
of UI state. It also provides a clean future seam for a durable ownership lease
without changing the position policy contract.

## Security and financial-safety implications

- AI and narrative fields have no broker or executor capability.
- Phase 7 cannot widen a stop, remove required protection, increase quantity, or
  increase the approved maximum loss.
- Broker-backed changes use the existing provider adapters and execution path.
- Testnet/practice mutations freeze when reconciliation is unhealthy.
- A failed protection replacement attempts restoration; if protection cannot be
  confirmed after reduction, the existing emergency-close path is used.
- Ownership, tenant, open-trade identity, thesis ID, policy version, environment,
  data quality, and action fingerprint are revalidated at the mutation boundary.
- Real-Live active mode is rejected by configuration and defensively downgraded
  again at runtime.

## Scalability and concurrency

The persisted owner removes fixed-versus-Phase7 competition inside one process.
The unique append-only proposal fingerprint makes repeated actions idempotent.
It does not claim to solve multi-worker broker ownership: the durable intent
ledger, fencing tokens, leases, reconciliation worker, and deployment draining
remain Phase 11/13 prerequisites for real Live authority.

## Rollback

Set new positions to `fixed`; existing positions retain their pinned owner so a
configuration change cannot silently switch policy mid-trade. A controlled
position migration requires a separate audited operation and is intentionally
not part of Phase 7. Real Live remains fixed regardless of the configured Phase
7 mode.

## Consequences

Easier:

- deterministic authority inspection and audit;
- faithful Shadow comparison against the fixed manager;
- Demo/testnet/practice validation using the production execution seams;
- policy replay in Phase 8;
- future fenced Live ownership without rewriting the domain contract.

Harder:

- trades opened before the schema change remain fixed and have no thesis;
- two management implementations must remain supported during comparison;
- provider and database failure paths require integration and soak evidence;
- real Live promotion still requires the unresolved operational gates.

## Required evidence before real Live promotion

- VPS health and no-trade incident root cause;
- real Binance testnet and OANDA practice concurrent soak;
- durable intent/reconciliation ledger and ownership fencing;
- complete kill switches, exit-only modes, deployment drain, and recovery tests;
- provider-specific protection and partial-fill chaos tests;
- browser, accessibility, security, and production deployment evidence;
- an explicit human-approved promotion report for the exact policy version.
