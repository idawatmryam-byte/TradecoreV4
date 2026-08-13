# Phase 10 Prerequisite VPS Remediation and Validation

**Scope:** post-merge operator procedure for the Phase 7–9 hardening pass.

**Not Phase 10:** this runbook does not enable autonomous Demo trading, promote
Phase 8, alter trading authority, or authorize provider/financial mutations.

All commands below are examples to run on the VPS only after the operator has
confirmed the repository commit and backup destination. Never paste secrets,
tokens, webhook URLs, or database URLs into issue/PR comments or shell history.

## Corrected deployment lifecycle

Deployment is intentionally two-stage:

1. `update.sh` is a minimal launcher. It fetches `origin/main`, resolves one
   exact target commit, proves the current commit is its ancestor, records the
   previous commit and target stage-two blob identity, and extracts
   `scripts/deploy/` from that target with `git archive`.
2. The launcher replaces itself with `scripts/deploy/deploy-target.sh` from the
   target commit. Builds, database migration/security verification, restart,
   readiness, and rollback therefore use reviewed target-revision logic rather
   than the stale shell text that happened to be running before Git advanced.

The launcher and target implementation log the previous commit, exact target
commit, and target deployment-script blob. A non-fast-forward target or tracked
worktree modification is refused. Stage two verifies that `HEAD` equals the
resolved target after advancing.

For the first deployment containing this repair, do not invoke the stale
working-tree updater. Bootstrap the reviewed launcher itself from the target:

```bash
git fetch origin main
TARGET_COMMIT="$(git rev-parse origin/main)"
git show "${TARGET_COMMIT}:update.sh" > /tmp/tradecore-update-stage1.sh
chmod 700 /tmp/tradecore-update-stage1.sh
TRADECORE_REPO_ROOT="$PWD" /tmp/tradecore-update-stage1.sh "$TARGET_COMMIT"
```

After this repair is installed, normal deployments may run `bash update.sh`.
Supplying a reviewed commit as the first argument remains preferable for an
auditable change window.

### Readiness and engine resume

`/api/healthz` means only that the API process is serving. `/api/readyz` first
checks PostgreSQL, then the complete desired-engine resume accounting. It emits
one explicit reason:

- `database_unhealthy` — PostgreSQL cannot answer;
- `engine_resume_pending` — discovery/start is incomplete;
- `engine_resume_failed` — every attempt is accounted, but at least one failed,
  timed out, or returned exit-only/degraded;
- `ready` — database healthy and every required engine resumed healthy.

Pending or failed readiness remains HTTP 503. This is not weakened to make a
deployment pass.

The target updater defaults to a 180-second readiness window, two-second polls,
five-second HTTP request deadlines, and a separate 60-second liveness window.
`READINESS_TIMEOUT_SECONDS` is configurable but cannot be below 180. Every
failed wait logs the final HTTP status, classified state, and bounded final
response body.

Desired engines resume in stable `(user_id, section)` order through a bounded
worker pool. Defaults are `ENGINE_RESUME_CONCURRENCY=2` and a 90-second
per-engine deadline. Concurrency is clamped to 1–4 and the deadline to 10–170
seconds. A timed-out engine is counted failed exactly once and immediately made
exit-only. Its worker slot stays occupied until the underlying provider call
settles, so timeouts cannot create hidden parallel provider bursts. Existing
position management is preserved; new entries remain closed.

### Rollback outcomes

Rollback mechanics comprise restoring the previous Git revision and artifacts,
installing its exact lockfile, and restarting the managed service. Reporting
then distinguishes:

- previous runtime restored and healthy;
- previous runtime restored, but engine resume is still pending at the bounded
  readiness deadline;
- previous runtime restored, but API/database/engine readiness genuinely
  failed;
- rollback mechanics themselves failed.

Only the last state is called a rollback mechanics failure. A slow-but-healthy
resume is accepted inside the same 180-second default window, and a still-
pending resume is reported accurately rather than as “automatic rollback
failed.” Rollback artifacts and commit/blob metadata are retained in the logged
temporary backup path whenever mechanics or restored-runtime readiness remains
unhealthy; they are deleted only after a healthy deployment or healthy rollback.

## 1. Pre-deployment read-only capture

Do not restart or deploy yet.

```bash
git status --short --branch
git rev-parse HEAD
git fetch origin main
git rev-parse origin/main
pm2 status
pm2 describe tradecore-api
curl --fail --silent http://127.0.0.1:${PORT}/api/healthz
curl --fail --silent http://127.0.0.1:${PORT}/api/readyz
```

Record the current PM2 process start time, restart count, desired-running state,
and free disk space. Export a database backup to an operator-controlled,
encrypted location and prove it can be listed/read before any role or schema
change. Deployment/restart remains a sensitive action requiring explicit
authorization.

## 2. Stale sandbox trades 432, 434, 475, and 476

The repository does not know their provider state. Do not update or close them
from database state alone.

Read-only database inspection:

```sql
SELECT id, user_id, section, symbol, side, status, execution_target,
       execution_authority, market_type, exchange_trade_id, correlation_id,
       entry_time, entry_price, remaining_quantity, stop_loss, take_profit
FROM public.trades
WHERE id IN (432, 434, 475, 476)
ORDER BY id;
```

For Binance Spot testnet trades 432 and 434, inspect the exact sandbox account:

- current non-dust asset balances;
- open orders for each exact Spot symbol;
- order/trade history since each database `entry_time`;
- matching client/broker order IDs from the execution intent and trade record;
- any stop/take-profit/manual close fills.

For OANDA practice trades 475 and 476, inspect the exact practice account:

- open trades and positions for each instrument;
- dependent stop-loss/take-profit orders;
- transaction history since `entry_time`;
- the persisted `exchange_trade_id`, when present.

Save provider timestamps, immutable provider IDs, quantities, prices, fees, and
screenshots/exports. Authentication/network failure means **UNKNOWN**, never
“closed” or “absent.” Do not use a Live account while verifying sandbox rows.

Separately authorized remediation decision:

1. If a provider position is still open, obtain explicit financial-action
   authorization before changing/cancelling/closing anything at the provider.
2. If the provider proves it closed, derive the exact close fill(s), fees, and
   timestamp. Prepare a record-specific database correction for review; do not
   use entry price or current price as a fabricated substitute.
3. If database/provider identity cannot be matched, leave the row open and
   `legacy_unverified`; keep new entries blocked and escalate.
4. Only after provider evidence is reviewed may an authorized migration pin the
   appropriate authority (`binance_spot_testnet` or `oanda_practice`). The code
   intentionally performs no automatic backfill for broker-backed legacy rows.
5. Re-run startup reconciliation and retain its logs. A correction and a
   provider close are separate authorizations and separate audit events.

## 3. Database owner/runtime separation

Required end state:

- a migration/owner role owns the database, schemas, tables, sequences, and
  `capture.purge_user_data(integer)`;
- the API connects as a distinct non-owner runtime role;
- the runtime role cannot assume the owner role;
- capture evidence and public execution/recommendation event streams cannot be
  updated, deleted, or truncated directly by runtime;
- account erasure uses the narrow tenant-scoped SECURITY DEFINER function.

Supported legacy starting state:

- database, `public`, `capture`, and their objects are owned by `tradecore`;
- `tradecore` may also be the old API login;
- `tradecore_owner` and `tradecore_runtime` do not yet exist.

Forward procedure (explicit database/VPS authorization required):

1. Stop new entries and safely drain/reconcile open broker-backed positions.
2. Take and verify a database backup and record current owners/grants.
3. Through an administrator-approved secret-managed role procedure, create
   login roles `tradecore_owner` and `tradecore_runtime` with independently
   generated passwords. Both must be `NOSUPERUSER NOCREATEDB NOCREATEROLE
   NOREPLICATION NOBYPASSRLS`; runtime must not be a member of owner. Do not put
   password-bearing `CREATE ROLE` statements in repository files or shell
   history. Grant both roles `CONNECT` only on the exact `tradecore` database so
   the new owner connection can be verified before ownership transfer.
4. Retain a one-time `DATABASE_BOOTSTRAP_URL` whose role can reassign objects
   owned by `tradecore` and alter the database/roles. Keep `.env` mode 0600 with
   only the runtime `DATABASE_URL`. Create `.env.deploy` mode 0600 from
   `.env.deploy.example` with:

   - `DATABASE_MIGRATION_URL` authenticating as `tradecore_owner`;
   - the one-time `DATABASE_BOOTSTRAP_URL`;
   - `TRADECORE_DATABASE_NAME=tradecore`;
   - `TRADECORE_LEGACY_ROLE=tradecore`;
   - `TRADECORE_DATABASE_OWNER_ROLE=tradecore_owner`;
   - `TRADECORE_RUNTIME_ROLE=tradecore_runtime`;
   - `AUTOPILOT_GLOBAL_SUSPENDED=true` (the production fail-closed default;
     `false` requires a separately reviewed operator decision).

5. The target deployment performs the following sequence. It refuses an owner
   other than the exact legacy or target owner. The ownership hardening command
   runs only for the legacy owner; schema push, post-schema grants, and strict
   verification run on every deployment:

```bash
psql "$DATABASE_BOOTSTRAP_URL" -v ON_ERROR_STOP=1 \
  -v database_name=tradecore \
  -v legacy_role=tradecore \
  -v owner_role="$TRADECORE_DATABASE_OWNER_ROLE" \
  -v app_role="$TRADECORE_RUNTIME_ROLE" \
  -f scripts/sql/harden-database-roles.sql

DATABASE_URL="$DATABASE_MIGRATION_URL" pnpm --filter @workspace/db run push

psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 \
  -v owner_role="$TRADECORE_DATABASE_OWNER_ROLE" \
  -v app_role="$TRADECORE_RUNTIME_ROLE" \
  -f scripts/sql/capture-grants.sql

psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 \
  -v owner_role="$TRADECORE_DATABASE_OWNER_ROLE" \
  -v app_role="$TRADECORE_RUNTIME_ROLE" \
  -f scripts/sql/verify-database-roles.sql
```

6. `harden-database-roles.sql` explicitly executes `REASSIGN OWNED BY
tradecore TO tradecore_owner`, transfers the database and schema owners,
   removes database/schema creation from runtime, installs least-privilege
   table/sequence/default grants, and prevents runtime from assuming owner.
   Schema push then runs only through `tradecore_owner`. The regular
   `capture-grants.sql` step includes the idempotent Phase 10 policy: immutable
   mandates/events and claim identity cannot be updated or deleted, while the
   mutable projections and claim outcome expose only their reviewed columns.
7. Confirm `to_regprocedure('capture.purge_user_data(integer)')` is non-null,
   owned by the migration role, SECURITY DEFINER, executable by runtime, and not
   executable by PUBLIC.
8. `verify-database-roles.sql` must exit successfully before restart. It raises
   a PostgreSQL error under `ON_ERROR_STOP` for any failed invariant, so psql 12
   and later return nonzero without relying on numeric `\quit`. It fails
   the deployment unless the target migration role owns the database, schemas,
   data objects, and functions; runtime has no administrative/create/ownership
   authority; evidence is immutable; and runtime can execute only the purge
   function in `capture`, with PUBLIC execution revoked.
9. Remove `DATABASE_BOOTSTRAP_URL` from `.env.deploy` after the verified
   ownership transfer. It is not needed for subsequent deployments. The target
   updater explicitly strips both deployment URL variables from PM2/restart
   environments; the API reads only `.env` and must never receive owner or
   bootstrap credentials.
10. In a disposable test tenant/database, execute the schema-security harness.
    Do not test account erasure against production user data.

Backup and recovery procedure (explicit authorization required):

- Prefer restoring the verified backup into a separate recovery database and
  repointing the stopped service after validation.
- If an urgent permission rollback is required, keep the API stopped, restore
  the recorded prior grants/owners from the pre-change capture, verify the purge
  function and application workflows, then restart in exit-only mode. Reassigning
  ownership back to the runtime role weakens immutability and is emergency
  recovery only, not an accepted steady state.
- Never delete the new owner role until every owned object and default privilege
  has been audited.
- The ownership migration is forward-compatible with the previous application
  runtime. Application rollback does not automatically weaken database roles or
  reverse immutable-evidence grants.
- If role migration succeeds but later application verification fails, first
  verify the restored application using `tradecore_runtime`. Restore the backup
  into a separate database only if a database invariant or application workflow
  cannot be recovered safely in place.

## 4. Critical operator alerts

Store `OPS_ALERT_WEBHOOK_URL` only in the VPS secret-managed `.env`; never in
Git, PM2 command arguments, or screenshots. Restart with `--update-env` only
after deployment authorization. Verify delivery with a deliberately generated
non-financial test event in a maintenance window. Sending the test message is
an external action and requires operator approval.

Expected behavior:

- local structured `CRITICAL_OPERATOR_ALERT` log always appears first;
- webhook payload uses schema `tradecore-critical-alert-v1`;
- duplicate trade/code alerts are suppressed for five minutes;
- failed deliveries retry once, are rate limited, and remain visible in logs;
- no token, cookie, authorization header, password, account credential, or
  webhook URL appears in the payload/log.

Do not deliberately create a protective-close failure to test alerting.

## 5. PM2 log rotation without evidence deletion

Current PM2 defaults are unbounded. Before enabling rotation, record:

```bash
pm2 status
pm2 describe tradecore-api
du -h ~/.pm2/logs/*tradecore* 2>/dev/null
df -h ~/.pm2
sha256sum ~/.pm2/logs/*tradecore* 2>/dev/null
```

If incident evidence must be retained separately, copy the current files to an
access-controlled incident archive on a volume with enough free space. Do not
run `pm2 flush` and do not remove existing logs.

Recommended PM2-compatible rotation (operational dependency justified because
PM2 owns the log files):

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
pm2 set pm2-logrotate:workerInterval 30
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 set pm2-logrotate:rotateModule true
pm2 save
```

This keeps up to 14 compressed rotations per stream and rotates at 100 MB or
daily, whichever comes first. Confirm the module process is online, configuration
matches, new application lines continue to arrive, and disk growth is bounded.
The first rotation may temporarily require additional disk while compressing the
existing large file; verify capacity first.

Rollback leaves evidence intact:

```bash
pm2 uninstall pm2-logrotate
pm2 save
```

Uninstalling stops future rotation; it does not delete existing active or
rotated files. Restore prior settings from the pre-change capture if a different
site-wide PM2 policy was already present.

## 6. Post-deploy validation matrix

No provider order is required unless separately authorized.

- Phase 7: start in `fixed`, then `phase7_shadow`; prove persisted thesis and
  management events. Enable `phase7_active` only in one explicitly verified
  sandbox after reconciliation is healthy. Confirm simulated Demo manual,
  stop, target, partial, emergency, and Phase 7 exits create no provider order.
- Phase 8: run bounded Crypto and Forex provider-backed experiments. Retain
  manifest, replay, golden fingerprint, report, and failures. Recommendation
  remains `REMAIN_RESEARCH`; do not promote automatically.
- Phase 9: create one Demo-target proposal and exercise persistence, rejection,
  expiry/staleness, fresh approval revalidation, same-key replay, concurrent
  claim refusal, controlled execution reuse, and lifecycle audit. Any
  broker-backed execution needs separate testnet/practice authorization.
- Cross-market: run Spot and Futures clients simultaneously with distinct
  symbols/caches; confirm no client receives the other market's unified symbol.
- Cross-section: run Crypto and Forex together long enough to cover scans,
  restart/reconciliation, pause/resume, alerts, and log rotation. Confirm one
  section's client/config/state cannot affect the other.

Record each result as repository/local, VPS integration, or provider validated.
An unavailable credential/provider is `UNKNOWN/NOT VALIDATED`, never PASS.
