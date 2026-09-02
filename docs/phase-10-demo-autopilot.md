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

The database-backed platform switch is the normal global entry suspension. A
missing or unreadable switch fails closed to suspended. One qualified platform
operator may suspend new entries immediately. Resume requires a time-limited
request from one qualified operator and approval by a second, distinct qualified
operator; both actions require recent Admin step-up, a reason, permissions, and
append-only audit evidence.

`AUTOPILOT_GLOBAL_SUSPENDED=true` is a deployment emergency hard stop. It
overrides every database-backed control and cannot be cleared in the Admin
Console. In production, an absent, malformed, or explicit `true` value keeps the
bounded-clearance gate suspended; an explicit `false` only delegates to the
database-backed controls.

Broker-backed testnet and practice AutoPilot therefore require two independent
platform gates to be clear: the persisted safety switch must receive its
time-limited, two-operator resume, and an unexpired bounded clearance must be
requested by one `PLATFORM_ADMIN` and approved by a different
`PLATFORM_ADMIN`. Clearance lasts from 15 minutes to 24 hours, is append-only,
and may be revoked immediately by `PLATFORM_ADMIN` or `OPERATIONS_RISK`.
Internal simulated Demo does not use this broker control plane, and Live
AutoPilot remains unavailable. No platform action bypasses mandate, control,
risk, reconciliation, kill-switch, or execution checks.

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
3. Confirm the database-backed platform switch is suspended before restart.
   Exercise the two-operator Admin resume and immediate suspension workflow.
   Separately verify `AUTOPILOT_GLOBAL_SUSPENDED=true` overrides a resumed
   database switch and cannot be cleared in Admin. Verify new entries halt
   immediately while an existing Demo position continues protective management.
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

## Deterministic simulated Demo completion validation

The operator CLI provides a deterministic market/decision fixture for the one
case that cannot be scheduled reliably: a naturally qualifying strategy
signal. It is not an executor and it is not an API endpoint. After producing
the fixture, it calls the normal scan path, unified Brain V0 contract,
deterministic risk and portfolio checks, exact active mandate evaluation,
reconciliation, atomic claim, executor seam, `DemoExecutor`, intent/trade
persistence, and Phase 7 management.

The path has categorical and operational locks:

- `PHASE10_VALIDATION_ENABLED=true`, a secret token of at least 32 characters,
  the exact confirmation phrase, and a UUID run id are all required;
- only crypto Spot `executionTarget=demo`, `mode=autopilot`, and
  `executionAuthority=simulated_demo` are accepted;
- the normal engine must be stopped with `engineDesiredRunning=false`;
- the exact short-lived mandate must already be active and must pin the bot
  configuration, Brain V0, symbol, strategy version, risk limits, and Phase 7
  actions;
- entry starts only when that isolated user/section has no open position;
- executor overrides are refused and the fixture exchange contains no order,
  credential, balance, position, or provider method;
- Binance testnet/Demo, OANDA practice, every Live authority, global/config
  suspension, reconciliation ambiguity, risk/portfolio refusal, kill switches,
  mandate mismatch, and duplicate claims all fail closed.

The CLI never creates a mandate, inserts a trade, calls an executor directly,
or modifies a provider. Create and activate the expiring mandate through the
existing Brain Control Center after human review. Use a dedicated validation
user/config so the zero-open-position invariant does not disturb protected
legacy positions.

### Exact VPS workflow

Run this only after the reviewed commit has merged and an operator has approved
the VPS deployment and temporary simulated Demo activation. Set every shell
variable to its reviewed value. Do not store or print the token.

1. Deploy the exact merged revision through the target-revision deployment and
   verify the revision, single PM2 fork, health, readiness, schema, and roles:

   ```bash
   cd /path/to/TradecoreV4
   TARGET_COMMIT=0123456789abcdef0123456789abcdef01234567
   ./update.sh "$TARGET_COMMIT"
   git rev-parse HEAD
   git status --short
   pm2 status
   curl --fail --silent http://127.0.0.1:8080/api/healthz
   curl --fail --silent http://127.0.0.1:8080/api/readyz
   ```

2. In the Brain Control Center, use a dedicated crypto Spot simulated Demo
   config, stop its normal engine, approve exact Brain V0, and create a
   short-lived mandate with the intended risk/portfolio/Phase 7 limits. After
   the separate temporary activation approval, ensure the deployment emergency
   hard stop is absent or explicitly `false`, complete the two-operator Admin
   resume, request and obtain bounded dual-operator clearance in Admin Console,
   verify readiness, and only then activate that exact mandate. Confirm
   `engineDesiredRunning=false` before continuing.

3. In an access-controlled operator shell, arm only the CLI process and run the
   pre-restart stage once:

   ```bash
   export PHASE10_VALIDATION_ENABLED=true
   read -rsp 'Phase 10 validation token: ' PHASE10_VALIDATION_TOKEN; echo
   export PHASE10_VALIDATION_TOKEN
   export AUTOPILOT_GLOBAL_SUSPENDED=false
   VALIDATION_USER_ID=123
   VALIDATION_MANDATE_ID=456
   VALIDATION_SYMBOL=BTCUSDT
   VALIDATION_STRATEGY_ID=trend_pullback
   RUN_ID="$(node -e 'console.log(require("crypto").randomUUID())')"
   pnpm --filter @workspace/api-server run validate:phase10 before-restart \
     --user-id "$VALIDATION_USER_ID" --mandate-id "$VALIDATION_MANDATE_ID" \
     --symbol "$VALIDATION_SYMBOL" --strategy-id "$VALIDATION_STRATEGY_ID" \
     --run-id "$RUN_ID" \
     --confirmation RUN_ONE_SIMULATED_DEMO_PHASE10_VALIDATION
   ```

   The command succeeds only after one accepted claim, one durable duplicate
   refusal, one protected intent, one simulated trade, and a persisted Phase 7
   management projection. Retain its JSON output and the run id.

4. Exercise process restart/reload, keeping the normal engine stopped, then run
   the post-restart stage with the same shell token and run id:

   ```bash
   pm2 restart tradecore-api --update-env
   curl --fail --silent http://127.0.0.1:8080/api/readyz
   pnpm --filter @workspace/api-server run validate:phase10 after-restart \
     --user-id "$VALIDATION_USER_ID" --mandate-id "$VALIDATION_MANDATE_ID" \
     --symbol "$VALIDATION_SYMBOL" --strategy-id "$VALIDATION_STRATEGY_ID" \
     --run-id "$RUN_ID" \
     --confirmation RUN_ONE_SIMULATED_DEMO_PHASE10_VALIDATION
   ```

   This stage reads the persisted evidence with fresh engine instances, proves
   the claim is still `EXECUTED`, proves exactly one trade exists, verifies the
   management projection fingerprint, reconciles/manages once more, closes via
   the normal simulated Demo fill/accounting path, and pauses the config.

5. Immediately suspend the database-backed platform switch in Admin. For this
   deterministic emergency-override check, also set the managed API environment
   to `AUTOPILOT_GLOBAL_SUSPENDED=true`, restart with `--update-env`, verify
   readiness, and durably confirm the restored suspension:

   ```bash
   export AUTOPILOT_GLOBAL_SUSPENDED=true
   pm2 restart tradecore-api --update-env
   curl --fail --silent http://127.0.0.1:8080/api/readyz
   pnpm --filter @workspace/api-server run validate:phase10 confirm-suspended \
     --user-id "$VALIDATION_USER_ID" --mandate-id "$VALIDATION_MANDATE_ID" \
     --symbol "$VALIDATION_SYMBOL" --strategy-id "$VALIDATION_STRATEGY_ID" \
     --run-id "$RUN_ID" \
     --confirmation RUN_ONE_SIMULATED_DEMO_PHASE10_VALIDATION
   unset PHASE10_VALIDATION_TOKEN PHASE10_VALIDATION_ENABLED RUN_ID \
     VALIDATION_USER_ID VALIDATION_MANDATE_ID VALIDATION_SYMBOL \
     VALIDATION_STRATEGY_ID
   ```

6. Reconcile the run-scoped append-only events, claim, intent, trade, position
   management events, final closed status, paused control, and restored global
   suspension. Verify no provider-side order, position, balance, or credential
   changed. Retain the evidence as simulated Demo evidence only.

### Independent provider completion status

Classify each sandbox authority independently. A missing credential or provider
permission is `BLOCKED`, not `FAIL`, when the authority remains disabled, its
provider state remains `UNKNOWN`, authority-isolation tests pass, and there is
no fallback to Live. `PASS` requires real provider-backed VPS evidence; `FAIL`
means a tested safety or correctness invariant actually failed.

| Authority            | Allowed status without usable credentials | Required safety state                          |
| -------------------- | ----------------------------------------- | ---------------------------------------------- |
| Binance Spot testnet | `BLOCKED`                                 | disabled, provider `UNKNOWN`, no Live fallback |
| Binance Futures Demo | `BLOCKED`                                 | disabled, provider `UNKNOWN`, no Live fallback |
| OANDA practice       | `BLOCKED`                                 | disabled, provider `UNKNOWN`, no Live fallback |

The deterministic simulated Demo run does not upgrade any provider authority to
`PASS` and never substitutes fabricated database evidence for provider proof.
