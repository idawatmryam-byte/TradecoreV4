# Phase 12 — Restricted Live Autopilot

## Outcome

Phase 12 adds a production-oriented Restricted Live authority domain. It permits one exact validated brain version to request autonomous Live entry only under an active immutable human mandate and only through the pre-existing Phase 11 Live execution path.

This implementation does not deploy, activate a production mandate, enable real-money autonomy, access providers, or change `AUTOPILOT_GLOBAL_SUSPENDED`. Repository presence is not production authorization.

## Architecture

### Authority chain

For an autonomous Live candidate, `BotEngine` first completes the normal perception, strategy, portfolio, and deterministic risk pipeline. The Phase 12 service then resolves current server state and atomically records either a refusal or a unique claim. An allowed request carries an exact `RestrictedLiveExecutionContext` and the existing Phase 11 `LiveCommandIdentity` into `LiveExecutor`.

Immediately before the broker-backed path, `LiveExecutor` runs Phase 11 safety and the final locked mandate/claim revalidation. `enterTrade` then persists the mandatory Phase 11 execution intent before sending the broker command. Intent and trade rows retain the mandate, brain, decision, risk, configuration, and ownership links.

No new broker adapter or parallel executor exists.

### Persistence

- `trading_mandates`: immutable canonical terms and revision fingerprint.
- `trading_mandate_states`: bounded lifecycle projection with one active mandate per user and section.
- `trading_mandate_events`: append-only lifecycle and suspension audit.
- `trading_mandate_authorizations`: append-only, session-bound, replay-resistant step-up evidence.
- `trading_mandate_usage`: restart-safe, server-authoritative usage projection.
- `trading_mandate_decision_claims`: unique decision/idempotency claims, reserved budgets, boundary state, intent/order/fill/trade links, and execution telemetry.

The database policy denies runtime delete/truncate on all Phase 12 tables. Mandate terms, events, and authorizations have no update permission. Lifecycle, usage, and decision outcome projections receive only enumerated column updates. Account erasure remains the owner-defined `capture.purge_user_data(integer)` path.

## Canonical mandate

All money is an integer string in 10^-8 settlement-currency units. Server calculations round possible liability upward before comparison. Canonicalization normalizes the brain fingerprint, symbol case, unique sorted scope arrays, strategy map order, and trading windows before SHA-256 fingerprinting.

An immutable revision contains:

- stable mandate key and monotonically increasing revision;
- user, tenant, and crypto/forex section;
- exact brain database identity, version, fingerprint, and model implementation;
- opaque server-derived account fingerprints—never provider keys or tokens;
- exact Live venue authorities, markets, symbols, and strategy configuration versions;
- maximum per-trade risk, position notional, aggregate exposure, leverage, concurrent positions/orders;
- daily, weekly, and monthly loss limits and maximum drawdown;
- explicit IANA timezone trading windows;
- inclusive effective time and exclusive hard expiry, limited to 30 days;
- canary allocation and predetermined automatic-suspension thresholds;
- explicit `COPILOT_VALID_ONLY` or `ABSTAIN` fallback policy.

Maximum ceilings are inclusive. Loss, drawdown, expiry, rate, spread, slippage, fill-latency, divergence, and reconciliation thresholds block at equality. Windows start inclusively and end exclusively. Missing data fails closed.

## Lifecycle and authorization

Only `ACTIVE` grants entry authority.

1. An Owner or Financial Operator creates a `DRAFT`. Creation freezes terms but grants no authority.
2. Submission moves the exact revision to `PENDING_APPROVAL`; it still grants no authority.
3. Approval validates request origin, role, current session, and password/basic step-up. A unique authorization identity, request identity, human identity, method, session version, timestamp, mandate fingerprint, and reason are stored append-only.
4. Approval makes the exact revision `ACTIVE`. If it is an authorized replacement, the prior active revision becomes `REPLACED` in the same transaction.
5. Human or automatic systems can move active authority to `SUSPENDED`; operators can irreversibly `REVOKE`. Hard expiry becomes persistent `EXPIRED` on read/claim.
6. Suspension is deliberately not resumable in place. Reactivation or renewal requires a new revision and new step-up.

Duplicate authorization, authorization replay, stale revision, and unrelated concurrent active mandates fail with conflict. The unique partial index on active `(user_id, section)` is the final concurrent-approval backstop.

## Entry enforcement

Every autonomous Live entry revalidates:

- exact mandate record, revision, fingerprint, lifecycle, effective time, expiry, and local window;
- tenant, user, section, opaque account, venue authority, market, symbol, strategy version, model, brain version/fingerprint;
- exact decision, risk-decision, plan, configuration, ownership generation, and idempotency identities;
- server-derived per-trade risk, position notional, aggregate exposure, canary consumption, leverage, open positions/orders;
- UTC realized daily/weekly/monthly losses and the canonical Phase 11 account drawdown projection;
- deterministic risk result and current market/portfolio/configuration revalidation;
- Phase 11 reconciliation, protection, ownership, drawdown, kill switches, and durable operating mode;
- market-data age, reconciliation age, spread, expected slippage, prior fill latency, protection failures, decision/entry rate, and Live-vs-Demo divergence.

Refusal is durable. Threshold violations that require suspension synchronously persist `SUSPENDED` and an audit event before the scan continues.

### Revocation and timeout behavior

The final boundary transaction locks the lifecycle row and claim. Revocation before that lock blocks the command. Boundary authorization before revocation records that one command as in flight, and revocation blocks every later claim. A provider timeout after submission becomes `OUTCOME_UNKNOWN`; reconciliation looks up the stable client-order identity. The engine does not guess and does not duplicate the order.

Protective exits, reductions, recovery closes, and reconciliation are not removed when new-entry authority is suspended, revoked, expired, or exhausted.

## Co-Pilot fallback

Fallback is a loss of authority, never an expansion. A valid scope-only refusal can be routed to `RecommendExecutor` with `RESTRICTED_LIVE_SCOPE_FALLBACK`, the original immutable decision bundle, and the mandate refusal reason. It sends no broker command and creates no autonomous execution intent.

Unsafe, stale, malformed, risk-rejected, kill-switched, cross-tenant/user/section, over-budget, or degraded candidates abstain. A human later acting on a proposal must pass Phase 9 current-state revalidation and Phase 11 safety.

## Canary monitoring

The first canary has no prior fill-latency or divergence sample; the system records `unknown` rather than inventing zero. After the first entry, missing or at-threshold latency/divergence evidence blocks and suspends. Successful Live fills capture broker order identity, fill latency, realized slippage, and divergence from the canonical configured slippage assumption. Decision claims also link intent and trade outcomes.

Automatic suspension can result from expiry, brain drift, canary exhaustion, loss/drawdown breach, Phase 11 unhealthy state, kill switch, stale market/reconciliation state, spread/slippage/latency/protection/rate/divergence thresholds, or a failed/unknown execution outcome. Automatic action can only reduce authority.

## Operator procedures

### Prepare and authorize

1. Confirm the exact brain has passed the Phase 8 scientific gate and a frozen Phase 10 Demo soak.
2. Confirm Phase 11 Execution Health is healthy and reconciliation/protection are current.
3. Configure an eligible Live account on the server. The UI displays only its opaque fingerprint.
4. Build a small, liquid-symbol, conservative-leverage mandate. Review maximum possible exposure, all limits, valid hours, expiry, canary allocation, fallback, and automatic-suspension thresholds.
5. Submit the immutable draft. Review the fingerprint and old/new diff.
6. Perform step-up authorization for the exact revision. This is a sensitive financial action.
7. Production activation and deployment require a separate, explicit operational authorization; the pull request does not perform them.

### Suspend or revoke

- Use **Suspend entries** for an incident or uncertainty. This immediately removes later new-entry authority while preserving protection and exit handling.
- Use **Revoke permanently** when the authority must never return. Reactivation requires a new revision.
- If the UI/API is unavailable, activate the appropriate Phase 11 kill switch or Exit-Only mode through the authorized emergency workflow. Do not delete mandate rows.
- For ambiguous provider outcomes, keep entries blocked and reconcile by stable client-order/broker identifiers. Never retry blindly.

### Rollback

Code rollback is safe only while new-entry authority is suspended and in-flight operations are reconciled. Revert the Phase 12 application release, retain immutable evidence, keep Phase 11 protection and Exit-Only capability running, and verify the database role policy. Schema deletion is not a runtime rollback and is not authorized by this phase.

## Security assumptions

- The runtime and migration/owner roles remain separated and the post-schema grants are reapplied after every schema push.
- Session signing, password storage, origin checks, and credential encryption remain correctly configured.
- Provider credentials remain server-side and never enter API responses, mandate terms, audit payloads, or UI fixtures.
- The deployment remains one PM2 fork until Phase 13 lease/fencing work exists.
- Server clock and IANA timezone data are reliable. Clock drift is an operational incident.
- Existing canonical Phase 11 equity/drawdown and existing trade P&L remain the source of truth; Phase 12 does not introduce an alternate P&L engine.

## Validation and evidence boundary

Deterministic harnesses cover canonicalization, fingerprints/tamper, all lifecycle and time states, categorical scope, numeric boundaries, fallback eligibility, safety precedence, cold-start telemetry, and automatic suspension. PostgreSQL integration covers idempotency, concurrent approval/claim, replay refusal, active uniqueness, audit, restart-safe projection, race ordering, and tenant/section isolation when a database exists. Browser coverage exercises builder exposure, create/submit/step-up, diff, decision/audit, suspension, revocation, expiry, degraded, and viewer states.

Testnet or OANDA practice validation of the complete restricted path still requires separate authorization and credentials. VPS/provider/production and real-money behavior remain unverified until an explicitly authorized deployment and operational validation occur.

## Known limitations and production prerequisites

- No provider-backed Phase 12 testnet/practice soak is performed by repository implementation.
- No production deployment, schema push, role verification, alert delivery, or broker telemetry is proven locally.
- A small canary cannot establish statistical profitability; Phase 8/10 evidence and ongoing human review remain required.
- Live-vs-backtest outcome comparison is currently enforced through decision/fill telemetry and thresholds; longer-horizon statistical allocation promotion remains a human review process.
- Production requires schema push followed by `capture-grants.sql` and `verify-database-roles.sql`, healthy Phase 11 reconciliation/protection, validated alerts, reviewed mandate, separate deployment approval, and separate activation approval.
- `AUTOPILOT_GLOBAL_SUSPENDED` must retain its safe operational value until those prerequisites and explicit authority are satisfied.
