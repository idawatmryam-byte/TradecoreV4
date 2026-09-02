-- Idempotent runtime privileges for the Phase 10/11/12 public-schema tables.
--
-- This fragment is included by both the one-time ownership migration and the
-- regular post-schema security installation. The second path is authoritative:
-- a table added after the database was hardened initially must still lose the
-- broad UPDATE/DELETE privileges inherited from the public-schema defaults.

\if :{?app_role}
\else
  \echo 'app_role is required'
  DO $failure$ BEGIN RAISE EXCEPTION 'app_role is required'; END $failure$;
\endif

-- Remove both table-level UPDATE and any column-level UPDATE left by an older
-- policy before installing the exact current policy. REVOKE UPDATE ON TABLE
-- alone does not remove independently granted column privileges.
SELECT format(
  'REVOKE UPDATE (%s) ON TABLE %I.%I FROM %I',
  string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position),
  table_schema,
  table_name,
  :'app_role'
)
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'brain_versions',
    'demo_autopilot_mandates',
    'autopilot_mandate_states',
    'autopilot_controls',
    'autopilot_decision_claims',
    'autopilot_events',
    'trading_mandates',
    'trading_mandate_states',
    'trading_mandate_events',
    'trading_mandate_authorizations',
    'trading_mandate_usage',
    'trading_mandate_decision_claims',
    'live_execution_states',
    'live_global_equity_state',
    'live_kill_switches',
    'live_safety_events',
    'platform_role_assignments',
    'platform_access_versions',
    'platform_audit_events',
    'platform_autopilot_clearance_events'
  )
GROUP BY table_schema, table_name
\gexec

REVOKE ALL ON TABLE
  public.brain_versions,
  public.demo_autopilot_mandates,
  public.autopilot_mandate_states,
  public.autopilot_controls,
  public.autopilot_decision_claims,
  public.autopilot_events,
  public.trading_mandates,
  public.trading_mandate_states,
  public.trading_mandate_events,
  public.trading_mandate_authorizations,
  public.trading_mandate_usage,
  public.trading_mandate_decision_claims,
  public.live_execution_states,
  public.live_global_equity_state,
  public.live_kill_switches,
  public.live_safety_events,
  public.platform_role_assignments,
  public.platform_access_versions,
  public.platform_audit_events,
  public.platform_autopilot_clearance_events
FROM :"app_role";

-- Every Phase 10 table is readable and insertable by the runtime. Immutable
-- evidence is never updated; account erasure uses capture.purge_user_data.
GRANT SELECT, INSERT ON TABLE
  public.brain_versions,
  public.demo_autopilot_mandates,
  public.autopilot_mandate_states,
  public.autopilot_controls,
  public.autopilot_decision_claims,
  public.autopilot_events,
  public.trading_mandates,
  public.trading_mandate_states,
  public.trading_mandate_events,
  public.trading_mandate_authorizations,
  public.trading_mandate_usage,
  public.trading_mandate_decision_claims,
  public.live_execution_states,
  public.live_global_equity_state,
  public.live_kill_switches,
  public.live_safety_events
TO :"app_role";

-- UI redesign tables. Strategy assignments are a tenant-owned mutable
-- preference. Platform role/access records are provisioned by the owner and
-- are runtime-readable only. Operator evidence is append-only.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.strategy_mode_assignments
TO :"app_role";
GRANT SELECT ON TABLE
  public.platform_role_assignments,
  public.platform_access_versions
TO :"app_role";
GRANT SELECT, INSERT ON TABLE
  public.platform_audit_events,
  public.platform_autopilot_clearance_events
TO :"app_role";

-- Mutable projections receive only the columns their existing state machines
-- update. Identity, mandate terms, decision fingerprints, and audit payloads
-- remain runtime-immutable.
GRANT UPDATE (state, updated_at)
  ON TABLE public.brain_versions TO :"app_role";
GRANT UPDATE (state, reason_code, reason, updated_at)
  ON TABLE public.autopilot_mandate_states TO :"app_role";
GRANT UPDATE (
  mandate_id,
  state,
  reason_code,
  reason,
  global_suspended,
  config_suspended,
  equity_day,
  day_start_equity_usdt,
  high_water_equity_usdt,
  last_evaluated_at,
  updated_at
) ON TABLE public.autopilot_controls TO :"app_role";
GRANT UPDATE (status, execution_intent_id, trade_id, outcome_reason, updated_at)
  ON TABLE public.autopilot_decision_claims TO :"app_role";

-- Phase 12 immutable terms, authorizations, and lifecycle events receive no
-- UPDATE path. Only their projections and outcome telemetry are mutable.
GRANT UPDATE (
  state,
  lifecycle_version,
  reason_code,
  reason,
  approving_human_id,
  authorization_method,
  authorization_id,
  authorized_at,
  updated_at
) ON TABLE public.trading_mandate_states TO :"app_role";
GRANT UPDATE (
  aggregate_exposure,
  canary_used,
  daily_loss,
  weekly_loss,
  monthly_loss,
  drawdown_bps,
  open_position_count,
  open_order_count,
  last_decision_at,
  decisions_last_hour,
  entries_last_hour,
  status,
  stale_reasons,
  observed_at,
  updated_at
) ON TABLE public.trading_mandate_usage TO :"app_role";
GRANT UPDATE (
  status,
  reason_code,
  reason,
  execution_intent_id,
  broker_command_id,
  broker_order_id,
  trade_id,
  fill_id,
  suspension_event_id,
  realized_slippage_bps,
  fill_latency_ms,
  live_demo_divergence_bps,
  updated_at
) ON TABLE public.trading_mandate_decision_claims TO :"app_role";

-- Phase 11 safety events are immutable. State and switch rows are projections:
-- the runtime may move only their operational fields, never their ownership or
-- scope identity. Account erasure remains behind capture.purge_user_data.
GRANT UPDATE (
  operating_mode,
  operating_mode_source,
  reconciliation_state,
  protection_state,
  global_drawdown_state,
  ownership_generation,
  owner_instance_id,
  current_equity_minor,
  peak_equity_minor,
  equity_source,
  equity_observed_at,
  equity_fresh_until,
  account_drawdown_state,
  account_drawdown_limit_bps,
  global_drawdown_limit_bps,
  entry_block_reason,
  owner_claimed_at,
  last_reconciled_at,
  last_incident_at,
  updated_at
) ON TABLE public.live_execution_states TO :"app_role";
GRANT UPDATE (
  current_equity_minor,
  peak_equity_minor,
  source_count,
  observed_at,
  fresh_until,
  drawdown_state,
  drawdown_limit_bps,
  updated_at
) ON TABLE public.live_global_equity_state TO :"app_role";
GRANT UPDATE (
  active,
  reason,
  activated_by_user_id,
  activated_at,
  deactivated_at,
  resume_request_id,
  resume_requested_by_user_id,
  resume_requested_at,
  resume_request_expires_at,
  resume_request_reason,
  updated_at
)
  ON TABLE public.live_kill_switches TO :"app_role";

-- Serial inserts require their backing sequences. Reapplying this after every
-- schema push also covers a newly created Phase 10 sequence in an already-
-- hardened database.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
