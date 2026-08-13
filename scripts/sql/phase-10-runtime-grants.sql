-- Idempotent runtime privileges for the Phase 10 public-schema tables.
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
    'autopilot_events'
  )
GROUP BY table_schema, table_name
\gexec

REVOKE ALL ON TABLE
  public.brain_versions,
  public.demo_autopilot_mandates,
  public.autopilot_mandate_states,
  public.autopilot_controls,
  public.autopilot_decision_claims,
  public.autopilot_events
FROM :"app_role";

-- Every Phase 10 table is readable and insertable by the runtime. Immutable
-- evidence is never updated; account erasure uses capture.purge_user_data.
GRANT SELECT, INSERT ON TABLE
  public.brain_versions,
  public.demo_autopilot_mandates,
  public.autopilot_mandate_states,
  public.autopilot_controls,
  public.autopilot_decision_claims,
  public.autopilot_events
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

-- Serial inserts require their backing sequences. Reapplying this after every
-- schema push also covers a newly created Phase 10 sequence in an already-
-- hardened database.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
