# Phase 10: Demo Autopilot

## Outcome

Phase 10 adds bounded autonomous entries to the existing controlled trading
path for simulated Demo, Binance Spot testnet, Binance Futures Demo, and OANDA
practice. It does not enable autonomous Live trading and it does not promote a
Research or Shadow result.

The runtime path is:

```text
MarketState + existing strategies + same-scan unified brain
  -> deterministic risk / portfolio / exposure / correlation checks
  -> exact Demo Autopilot mandate evaluation
  -> durable single decision claim
  -> existing executor seam
  -> mandatory durable execution intent
  -> simulated Demo or exact broker sandbox executor
  -> reconciliation and persisted trade
  -> pinned fixed or Phase 7 position management
```

No brain or AI component calls a broker.

## Authority and mandate

The Brain Control Center registers Brain V0 at its existing `COPILOT` stage. A
human may explicitly approve that exact controlled implementation for Demo.
Other versions begin in `DRAFT`; no registration, Research report, Shadow run,
or Co-Pilot recommendation silently grants autonomous authority.

Each immutable mandate records:

- eligible user, section, and exact bot configuration fingerprint;
- exact sandbox authority, market, instruments, and strategy config versions;
- maximum position size and leverage;
- portfolio risk, symbol, net, and correlated exposure ceilings;
- daily loss and peak-equity drawdown limits;
- maximum concurrent positions and market-data age;
- optional UTC trading windows;
- permitted Phase 7 actions;
- version, validity interval, expiry, and content fingerprint.

Mandate changes create a new record. The runtime role cannot update or delete
mandates or audit events.

## Fail-closed evaluation

New autonomous entries are refused when any required state is missing or when:

- the control is paused or blocked, or a global/config suspension is active;
- the exact brain is not `DEMO_APPROVED`;
- the mandate is absent, inactive, expired, revoked, or not yet valid;
- account, configuration, authority, market, instrument, or strategy differs;
- the execution target resolves to an unapproved or ambiguous authority;
- provider configuration, reconciliation, MarketState, or same-scan evidence is
  unavailable, unhealthy, unknown, or stale;
- a kill switch or deterministic risk check is active;
- any size, leverage, portfolio, exposure, loss, drawdown, concurrency, or UTC
  hours limit is exceeded.

Defined safety failures automatically move the entry control to
`AUTOPILOT_BLOCKED`. The operator-visible reason code and detail are retained.

## Idempotency and execution

The decision fingerprint, mandate fingerprint, user, and section create a
stable idempotency key. PostgreSQL uniqueness permits one transactional decision
claim. The same key produces the same correlation and provider client-order
identifiers, and execution intents have their own unique autopilot key.

Unlike the legacy best-effort observability path, an autonomous executor throws
before order submission if its durable intent cannot be written. The existing
Demo or broker-sandbox executor performs the order and binds the resulting
intent/trade to mandate, brain decision, and deterministic risk fingerprints.

Simulated Demo retains a market-data-only capability: attempts to call an
external order method fail before the source client can be invoked.

## Position management and suspension

`AUTOPILOT_PAUSED` and `AUTOPILOT_BLOCKED` halt only new autonomous entries.
They do not stop the engine or remove the owner pinned to an existing position.
The mandate action list is stored with each autonomous trade. Phase 7 still
validates every adaptive action and cannot exceed that list; protective
`HOLD`, `FREEZE`, and `EXIT` are mandatory.

The environment variable `AUTOPILOT_GLOBAL_SUSPENDED=true` is the deployment
global entry suspension. It is explicit in both environment templates, the
deployment process defaults it to `true`, and a production process with the
variable absent or malformed also fails closed to suspended. Setting it to
`false` requires an operator-reviewed configuration change; that override only
lifts this global gate and does not bypass mandate, control, risk, authority, or
reconciliation checks. The Control Center exposes both global and per-config
state. Resume requires an explicit human reason and exact mandate/config
revalidation; the next entry still passes all runtime gates.

## Audit and forward soak

Append-only events cover brain registration/transitions, mandate creation and
lifecycle, autonomous claims/refusals/execution outcomes, and suspension/resume.
The forward-soak endpoint calculates decision frequency, executions, refusals,
failures, costs, realized P&L, protection coverage, risk violations, and regime
mix from persisted evidence under the selected mandate.

The report states its limitations: Brain V0 confidence is uncalibrated, no
Research report is silently attached, repository evidence is not provider
validation, the current balance/equity projection does not reconstruct
unavailable provider unrealized equity, and no result grants Live authority.

## Deployment and VPS validation after merge

Apply the schema and reviewed database-role scripts before starting the new API.
Then, with explicit operator authorization and no real-Live orders:

1. Capture deployed commit, clean status, PM2 single-fork topology, migration
   output, `/api/healthz`, `/api/readyz`, and database connectivity.
2. Verify all six Phase 10 tables and new execution/trade bindings exist. The
   regular deployment must run `capture-grants.sql` after every schema push,
   including on an already-hardened database, then run
   `verify-database-roles.sql`. Prove mandate terms, audit events, and decision
   claim identity are runtime-immutable; prove lifecycle projections expose
   only their reviewed update columns; and prove account purge removes Phase 10
   rows.
3. Confirm `AUTOPILOT_GLOBAL_SUSPENDED=true` is explicitly configured before
   restart. Any later `false` override requires a separate operator review.
   Exercise
   global and per-config pause/resume and verify new entries halt immediately
   while an existing Demo position continues protective management.
4. For simulated Crypto Demo, create/approve/activate an expiring mandate,
   observe one autonomous entry through intent/trade/reconciliation/Phase 7,
   prove no broker credential or provider order is used, and close safely.
5. With separately authorized sandbox credentials, repeat on Binance Spot
   testnet, Binance Futures Demo, and OANDA practice. Capture resolved authority,
   provider account/environment, client-order id, durable intent, fill,
   protection, reconciliation, and close. A credential/provider failure remains
   `UNKNOWN` and blocks; do not report it as a pass.
6. Exercise missing/expired mandate, stale data, reconciliation `UNKNOWN`, kill
   switch, risk breach, duplicate decision, and restart/resume. Capture the
   durable reason and audit event for each.
7. Attempt to configure real-Live Autopilot and confirm
   `AUTOPILOT_LIVE_AUTHORITY_DISABLED` without placing an order. Confirm Phase 9
   Live Co-Pilot approval behavior is unchanged.
8. Export the frozen forward-soak report and reconcile its counts/fingerprints
   to persisted claims, intents, and trades. Treat it as Demo evidence only.

Provider-backed validation is unresolved until those VPS checks actually run.
