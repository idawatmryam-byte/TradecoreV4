# Phase 7: Professional Trade Thesis and Bounded Position Management

**Status:** Implemented; repository validation complete, operational soak pending

**Policy version:** `phase7-bounded-management-v1`

**Live authority:** Disabled

## Objective

Connect every Phase 7-managed entry to a persistent, versioned thesis and use
later closed-market evidence to make bounded, deterministic management decisions.
Research/Shadow records counterfactual actions. Demo, Binance testnet, and OANDA
practice can actively manage positions when explicitly configured. Real Live
contains the interface and safety gates but cannot activate Phase 7 authority.

## Components

- `intelligence/position/types.ts`: strict thesis, evaluation, action, and
  validation contracts.
- `authority.ts`: deterministic environment and sole-owner resolution.
- `thesis.ts`: immutable entry-time thesis creation from the accepted plan and
  point-in-time MarketState.
- `evaluator.ts`: `VALID`, `WEAKENING`, `INVALIDATED`, `TARGET_DEGRADED`, and
  `DATA_UNCERTAIN` classification.
- `policy.ts`: bounded action selection and maximum-loss validation.
- `store.ts`: immutable thesis and append-only management-event persistence.
- `botEngine.ts`: entry pinning and exclusive management dispatch.
- `tradeManager.ts` and `exitManager.ts`: approved provider-backed mutation
  seams; Phase 7 does not call brokers directly.
- `demoExit.ts`: equivalent Demo execution semantics with fixed-manager exclusion.
- OpenAPI, generated clients, and the Position Thesis UI expose authority,
  evidence, validation, and executed outcome.

## Deterministic policy

| Thesis state / condition            | Action           | Bound                                                    |
| ----------------------------------- | ---------------- | -------------------------------------------------------- |
| Uncertain data                      | `FREEZE`         | No adaptive mutation; baseline protection remains active |
| Invalidated thesis                  | `EXIT`           | Only deterministic invalidation can authorize it         |
| Degraded target                     | `REDUCE`         | At most 50%, once per position                           |
| Weakening after sufficient progress | `TIGHTEN_STOP`   | Break-even or tighter; never increases maximum loss      |
| Valid and at least 1R progress      | `APPLY_TRAILING` | Approved ATR trail; tighter-only                         |
| Otherwise                           | `HOLD`           | No mutation                                              |

The validator refuses any action that widens risk, increases quantity, repeats a
reduction, lacks required protection, violates policy/state alignment, or uses
non-finite values. The action catalog has no add-to-position operation.

## Audit and idempotency

The thesis stores the original market-state fingerprint, invalidation rules,
target rationale, expected path/duration, permitted actions, and policy version.
Each management cycle records the evaluation, proposed action, deterministic
validation, result stage, source fingerprint, and timestamp. `PROPOSED` is
inserted before a mutation and is unique by trade, action fingerprint, and stage.
A duplicate proposal freezes rather than acting twice.

## Operational modes

- `fixed`: existing fixed manager owns mutations; Phase 7 is disabled.
- `phase7_shadow`: fixed manager owns mutations; Phase 7 appends Shadow events.
- `phase7_active`: Phase 7 owns adaptive mutations only for Demo/testnet/practice.
- real Live: API refuses active configuration and runtime independently falls
  back to fixed plus Shadow.

Positions retain their entry-time assignment. Changing the account configuration
does not transfer an open position between managers.

## Validation contract

Phase 7 is complete only when the following are recorded:

- full TypeScript project-reference and artifact typecheck;
- deterministic authority, state, action, idempotency, and risk-invariant tests;
- schema application and database integration tests;
- Demo and provider-adapter management integration/error-path tests;
- OpenAPI generation and client compatibility;
- desktop/mobile browser regression for authority labels, Live refusal, thesis
  timeline, uncertain-data freeze, keyboard access, and non-color status;
- production dependency audit and application builds;
- a promotion report listing executed checks, remaining unverified assumptions,
  and all real-Live blockers.

## Known promotion boundary

Passing repository tests does not promote the policy to real Live. VPS/provider
soak, deployment behavior, complete reconciliation, concurrency fencing, kill
switches, chaos/recovery coverage, and explicit human approval remain mandatory.
