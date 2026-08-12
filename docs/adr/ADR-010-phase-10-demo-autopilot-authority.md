# ADR-010: Phase 10 Demo Autopilot Authority Boundary

- Status: Accepted
- Date: 2026-08-12
- Scope: Autonomous Demo/testnet/practice entries, immutable mandate, suspension, audit, and controlled execution

## Context

Phase 10 must let the existing unified brain act without a per-trade human click
in approved sandbox environments, but it must not create a second trading engine
or make `autopilot` synonymous with real-money authority. Research and Shadow
outputs remain non-executing. Phase 9 Co-Pilot remains human-approved. Existing
risk, portfolio, execution-intent, reconciliation, and Phase 7 ownership
boundaries remain authoritative.

## Decision

1. Autonomous authority is limited to `simulated_demo`,
   `binance_spot_testnet`, `binance_futures_demo`, and `oanda_practice`.
   Configuration and runtime checks categorically refuse autonomous Live
   authorities.
2. A brain version has an explicit lifecycle. Only the exact Brain V0 control
   implementation may currently transition from `COPILOT` to `DEMO_APPROVED`.
   Candidate versions begin in `DRAFT`; registration or Shadow observation
   grants no execution authority. Phase 10 cannot transition into
   `LIVE_RESTRICTED`.
3. An immutable, versioned mandate binds user, section, bot configuration
   fingerprint, brain version, sandbox authority, market, instruments, strategy
   configuration versions, size/leverage/portfolio/exposure/loss/drawdown/
   concurrency limits, UTC hours, Phase 7 actions, validity interval, and
   expiry. Changing terms creates a new fingerprinted mandate.
4. An autonomous entry is evaluated after the existing deterministic strategy,
   risk, portfolio, exposure, and correlation checks. It also requires healthy
   reconciliation, fresh healthy MarketState, same-scan unified-brain evidence,
   valid provider configuration, no kill switch, an enabled control projection,
   and an active unexpired mandate.
5. The service transactionally claims the mandate and deterministic decision
   once before execution. The claim generates stable idempotency, correlation,
   and provider client-order identifiers. An autonomous execution cannot cross
   the executor seam unless its durable execution intent is persisted.
6. The existing executor is the only order seam. Simulated Demo uses
   `DemoExecutor`, whose capability cannot call an external broker. Binance
   testnet/Demo and OANDA practice use the existing broker adapter and the exact
   resolved sandbox authority. Brain components never receive broker clients.
7. The position stores its mandate, brain, decision, risk, and permitted Phase
   7 action bindings. Existing Phase 7 management runs through its pinned owner
   and deterministic action validator. `HOLD`, `FREEZE`, and `EXIT` are mandatory
   mandate actions so protective behavior cannot be removed.
8. `AUTOPILOT_ENABLED`, `AUTOPILOT_PAUSED`, and `AUTOPILOT_BLOCKED` govern new
   entries only. Operator pause and automatic suspension do not stop the engine
   or revoke protective management/exits for positions already open.
9. Mandate creation/change, lifecycle transitions, decisions, refusals,
   executions, suspensions, and resumptions are durable audit events. Mandates
   and audit events are immutable to the runtime database role; account erasure
   uses the owner-defined `capture.purge_user_data(integer)` boundary.
10. Forward-soak reporting uses persisted repository evidence and explicitly
    labels confidence uncalibrated and Research drift unavailable when no
    reviewed report is bound. A report cannot promote or enable Live authority.

## Consequences

- Any missing, stale, unknown, ambiguous, mismatched, expired, or unavailable
  safety input refuses the entry and may reduce authority to `BLOCKED`.
- Resumption is a human action, but every runtime gate is evaluated again for
  the next decision. A green UI or CI result is not execution authority.
- Binance/OANDA sandbox behavior still requires post-merge VPS validation with
  authorized credentials. Repository and CI tests do not fabricate provider
  evidence.
- Phase 11 Live hardening and Phase 12 restricted Live Autopilot remain separate
  work. This ADR grants neither.

## Alternatives rejected

### A simplified paper-trading loop

Rejected because it would bypass the real decision, portfolio, intent,
reconciliation, and position-management paths and could not validate future
behavior.

### Let mode selection grant authority

Rejected because a mutable string is not a mandate. Authority requires an exact
brain lifecycle transition, immutable terms, current safety evidence, and a
single durable decision claim.

### Stop all management when Autopilot pauses

Rejected because an entry kill switch must not strand an existing position.
Protective management remains owned by the existing fixed or Phase 7 path.
