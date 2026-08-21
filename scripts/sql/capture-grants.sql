-- TradeCore Pro — make the capture log append-only in the database
--
-- The capture schema is the historical asset: features → decision → outcome,
-- the substrate every later statistic is computed from. "Append-only" is worth
-- nothing as a code convention — one well-meaning UPDATE in a future migration
-- silently rewrites history, and nothing surfaces it. So the guarantee lives
-- in a GRANT instead: the application role can INSERT and SELECT, and that is
-- all. An attempted UPDATE or DELETE is a permission error at the database.
--
-- Run through the dedicated migration/owner connection AFTER
-- `pnpm --filter @workspace/db run push` has created the schema:
--
--   psql "$DATABASE_MIGRATION_URL" -v app_role=tradecore_runtime \
--     -v owner_role=tradecore_owner -f scripts/sql/capture-grants.sql
--
-- Re-running is safe, and you SHOULD re-run it after any schema push that adds
-- a capture table (P8 added capture.memory_influences). The ALTER DEFAULT
-- PRIVILEGES below covers tables created afterwards by the same role, but
-- re-running is the cheap way to be certain rather than reasoning about which
-- role ran which migration.
--
-- NOTE: if the application currently connects as the database OWNER (common in
-- single-role setups, including the harness), these grants have no effect —
-- an owner bypasses them, and Postgres has no way to revoke privileges from an
-- owner short of reassigning ownership. Production should use a dedicated,
-- non-owner application role. Verify with the query at the bottom.

\if :{?app_role}
\else
  \echo 'app_role is required'
  \quit 2
\endif
\if :{?owner_role}
\else
  \echo 'owner_role is required'
  \quit 2
\endif

BEGIN;

-- Account erasure is the one deliberate exception to append-only retention.
-- Keep DELETE away from the application role and expose only a parameterized,
-- owner-defined purge of rows belonging to one user. The API invokes this
-- inside the same transaction as deletion of the account's public-schema
-- rows, so erasure is complete or rolled back as a unit.
CREATE OR REPLACE FUNCTION capture.purge_user_data(target_user_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, capture
AS $$
DECLARE
  purge_user_id ALIAS FOR $1;
BEGIN
  -- Public-schema lifecycle projections are mutable, but their event streams
  -- are append-only. Account erasure is their only runtime deletion path.
  DELETE FROM public.execution_events AS event
  USING public.execution_intents AS intent
  WHERE event.intent_id = intent.id
    AND intent.user_id = target_user_id;

  DELETE FROM public.recommendation_events WHERE user_id = target_user_id;

  DELETE FROM public.live_safety_events WHERE target_user_id = purge_user_id;
  DELETE FROM public.live_kill_switches
  WHERE owner_user_id = purge_user_id;
  DELETE FROM public.live_execution_states WHERE user_id = purge_user_id;
  UPDATE public.live_global_equity_state
  SET current_equity_minor = NULL,
      peak_equity_minor = NULL,
      source_count = 0,
      observed_at = NULL,
      fresh_until = NULL,
      drawdown_state = 'UNKNOWN';

  DELETE FROM public.autopilot_events WHERE user_id = target_user_id;
  DELETE FROM public.autopilot_decision_claims WHERE user_id = target_user_id;
  DELETE FROM public.autopilot_mandate_states WHERE user_id = target_user_id;
  DELETE FROM public.autopilot_controls WHERE user_id = target_user_id;
  DELETE FROM public.demo_autopilot_mandates WHERE user_id = target_user_id;
  DELETE FROM public.brain_versions WHERE user_id = target_user_id;

  DELETE FROM capture.research_replay_events WHERE user_id = target_user_id;

  DELETE FROM capture.position_management_events WHERE user_id = target_user_id;
  DELETE FROM capture.position_theses WHERE user_id = target_user_id;

  DELETE FROM capture.brain_evidence_references AS evidence
  USING capture.brain_decisions AS decision
  WHERE evidence.brain_decision_id = decision.id
    AND decision.user_id = target_user_id;

  DELETE FROM capture.shadow_council_runs WHERE user_id = target_user_id;
  DELETE FROM capture.brain_decisions WHERE user_id = target_user_id;
  DELETE FROM capture.strategy_opinions WHERE user_id = target_user_id;
  DELETE FROM capture.evidence_rule_events WHERE user_id = target_user_id;
  DELETE FROM capture.evidence_snapshots WHERE user_id = target_user_id;
  DELETE FROM capture.memory_influences WHERE user_id = target_user_id;
  DELETE FROM capture.decisions WHERE user_id = target_user_id;
END;
$$;

ALTER FUNCTION capture.purge_user_data(integer) OWNER TO :"owner_role";

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA capture FROM PUBLIC, :"app_role";
GRANT EXECUTE ON FUNCTION capture.purge_user_data(integer) TO :"app_role";

-- The role must be able to see and write the schema, and nothing more.
GRANT USAGE ON SCHEMA capture TO :"app_role";

REVOKE ALL ON ALL TABLES IN SCHEMA capture FROM :"app_role";
GRANT INSERT, SELECT ON ALL TABLES IN SCHEMA capture TO :"app_role";

-- serial primary keys need the sequence.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA capture TO :"app_role";

-- Phase 10 lives in public rather than capture. Reapply its exact runtime
-- policy after every schema push so later tables cannot retain the broader
-- public-schema defaults installed during the one-time role migration.
\ir phase-10-runtime-grants.sql

-- Tables added to the schema later inherit the same shape automatically, so a
-- future capture table cannot accidentally ship as mutable.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA capture
  GRANT INSERT, SELECT ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA capture
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA capture
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;

-- Verification. Expect INSERT and SELECT only — no UPDATE, no DELETE, no
-- TRUNCATE. An owner role will show everything; that is the caveat above.
SELECT table_name,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.table_privileges
WHERE table_schema = 'capture'
  AND grantee = :'app_role'
GROUP BY table_name
ORDER BY table_name;
