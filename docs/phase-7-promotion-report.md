# Phase 7 Promotion Report

**Date:** 2026-08-09

**Candidate:** `phase7-bounded-management-v1`

**Decision:** Repository implementation accepted for Demo/testnet/practice validation; real Live is **NO-GO**

## Authority decision

The owner approved Phase 7 active authority only for TradeCore Demo, Binance
testnet, and OANDA practice. `fixed` remains the default. `phase7_shadow` is an
optional counterfactual mode. Real Live active authority is refused by the API
and independently downgraded to fixed plus Shadow at runtime.

Every new trade pins exactly one owner. A database constraint permits only these
combinations:

- fixed owner with fixed mode and no thesis;
- fixed owner with Phase 7 Shadow and an immutable thesis;
- Phase 7 owner with Phase 7 active mode and an immutable thesis.

The fixed adaptive manager is skipped when Phase 7 owns the position. Baseline
stop/target/time/liquidation/emergency settlement remains active as a
deterministic safety boundary.

## Implemented evidence

- strict thesis, state, action, validation, and authority contracts;
- immutable thesis plus append-only event ledger with pre-mutation idempotency;
- deterministic `HOLD`, one-time bounded `REDUCE`, tighter-only stop,
  approved ATR trailing, invalidation `EXIT`, and uncertainty `FREEZE` policy;
- Demo and approved broker-sandbox dispatch through existing execution seams;
- real-Live configuration refusal and runtime defense in depth;
- account-erasure support for the new append-only records;
- authenticated, tenant/section-scoped thesis API and regenerated clients;
- settings authority control and position thesis/status/audit timeline;
- desktop/mobile browser regression wired into CI;
- architecture, operating, rollback, and promotion documentation.

## Validation executed in this workspace

| Gate                                         | Result                                     |
| -------------------------------------------- | ------------------------------------------ |
| Repository TypeScript typecheck              | Passed                                     |
| Full pure API harness chain                  | Passed                                     |
| Phase 7 deterministic policy/risk harness    | Passed: 24 checks                          |
| Production dependency audit at high severity | Passed: no known vulnerabilities           |
| Frontend production build                    | Passed                                     |
| Backend production build                     | Passed                                     |
| Playwright desktop Chromium                  | Passed: 3 tests                            |
| Playwright Pixel 7 emulation                 | Passed: 3 tests                            |
| OpenAPI client generation                    | Passed using the repository OpenAPI source |
| `git diff --check`                           | Passed                                     |

The browser run required temporary Windows-native Rollup/esbuild/CSS packages
because this repository intentionally locks native dependencies to Linux. Those
packages were removed immediately after validation and are not part of the
candidate dependency set.

## Validation not executed locally

The database schema application and integration suite were not runnable in this
workspace because Docker/PostgreSQL, `psql`, and `DATABASE_URL` are unavailable.
CI now applies the schema, installs the capture grants, runs the integration
suite (including the extended Phase 7 purge contract), runs both browser
projects, and builds. The candidate must not be enabled in a shared environment
until that CI run passes and the schema/grants are applied.

Real Binance testnet/OANDA practice action execution, partial-fill and protection
failure handling, concurrent Crypto/Forex soak, restart recovery, and VPS
deployment behavior remain unverified in this workspace.

## Demo/testnet/practice promotion conditions

Before selecting `phase7_active` outside a developer database:

1. pass the updated CI workflow on PostgreSQL;
2. apply the schema and rerun `scripts/sql/capture-grants.sql` with the dedicated
   non-owner application role;
3. begin in `phase7_shadow` and inspect thesis/action lineage;
4. run Demo, then one provider sandbox at a time, with bounded test positions;
5. verify stop replacement, one-time reduction, invalidation exit, provider
   rejection, timeout, restart, and reconciliation freeze evidence;
6. run Crypto and Forex concurrently and confirm section/client isolation;
7. return to `fixed` immediately on protection, reconciliation, or audit drift.

## Real-Live blockers

Real-Live Phase 7 authority remains disabled until all of the following are
closed with evidence and explicit human approval:

- VPS no-trade incident root cause and deployment/rollback proof;
- real provider testnet/practice soak and compatibility evidence;
- durable intent/reconciliation ledger for every ambiguous operation;
- multi-worker ownership fencing and concurrency safety;
- complete kill switches, no-new-entry/exit-only modes, and deployment drain;
- provider-specific partial-fill, protection-failure, restart, and chaos tests;
- production alerting, observability, access-control, and security checks;
- Phase 8 replay/ablation and forward evidence for the exact policy version.

Repository tests are not a Live promotion. No real-Live adaptive authority was
enabled or exercised by Phase 7.
