-- Fail-closed verification for the TradeCore production owner/runtime split.
\set ON_ERROR_STOP on

\if :{?owner_role}
\else
  \echo 'owner_role is required'
  DO $failure$ BEGIN RAISE EXCEPTION 'owner_role is required'; END $failure$;
\endif
\if :{?app_role}
\else
  \echo 'app_role is required'
  DO $failure$ BEGIN RAISE EXCEPTION 'app_role is required'; END $failure$;
\endif

SELECT
  COALESCE((SELECT pg_get_userbyid(datdba) = :'owner_role' FROM pg_database WHERE datname = current_database()), false) AS migration_owns_database,
  NOT pg_has_role(:'app_role', :'owner_role', 'MEMBER') AS runtime_not_owner_member,
  COALESCE((SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit
    FROM pg_roles WHERE rolname = :'app_role'), false) AS runtime_role_is_unprivileged,
  NOT has_database_privilege(:'app_role', current_database(), 'CREATE') AS runtime_cannot_create_schemas,
  NOT EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspname IN ('public', 'capture') AND pg_get_userbyid(nspowner) <> :'owner_role'
  ) AS migration_owns_schemas,
  NOT EXISTS (
    SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'capture') AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      AND pg_get_userbyid(c.relowner) <> :'owner_role'
  ) AS migration_owns_data_objects,
  NOT EXISTS (
    SELECT 1 FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'capture') AND pg_get_userbyid(p.proowner) <> :'owner_role'
  ) AS migration_owns_functions,
  NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'capture'
      AND (has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'UPDATE')
        OR has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'DELETE')
        OR has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'TRUNCATE'))
  ) AS capture_is_immutable,
  NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'capture'
      AND (NOT has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'SELECT')
        OR NOT has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'INSERT'))
  ) AS capture_has_required_access,
  NOT has_table_privilege(:'app_role', 'public.execution_events', 'UPDATE')
    AND NOT has_table_privilege(:'app_role', 'public.execution_events', 'DELETE')
    AND NOT has_table_privilege(:'app_role', 'public.execution_events', 'TRUNCATE') AS execution_events_are_immutable,
  NOT has_table_privilege(:'app_role', 'public.recommendation_events', 'UPDATE')
    AND NOT has_table_privilege(:'app_role', 'public.recommendation_events', 'DELETE')
    AND NOT has_table_privilege(:'app_role', 'public.recommendation_events', 'TRUNCATE') AS recommendation_events_are_immutable,
  NOT has_table_privilege(:'app_role', 'public.live_safety_events', 'UPDATE')
    AND NOT has_table_privilege(:'app_role', 'public.live_safety_events', 'DELETE')
    AND NOT has_table_privilege(:'app_role', 'public.live_safety_events', 'TRUNCATE') AS live_safety_events_are_immutable,
  (
    SELECT count(*) = 6
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'brain_versions',
        'demo_autopilot_mandates',
        'autopilot_mandate_states',
        'autopilot_controls',
        'autopilot_decision_claims',
        'autopilot_events'
      )
  ) AS phase10_tables_exist,
  (
    SELECT count(*) = 4
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'live_execution_states',
        'live_global_equity_state',
        'live_kill_switches',
        'live_safety_events'
      )
  ) AS phase11_tables_exist,
  (
    SELECT count(*) = 6
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'trading_mandates',
        'trading_mandate_states',
        'trading_mandate_events',
        'trading_mandate_authorizations',
        'trading_mandate_usage',
        'trading_mandate_decision_claims'
      )
  ) AS phase12_tables_exist,
  NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'brain_versions',
        'demo_autopilot_mandates',
        'autopilot_mandate_states',
        'autopilot_controls',
        'autopilot_decision_claims',
        'autopilot_events'
      )
      AND (
        has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'DELETE')
        OR has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'TRUNCATE')
      )
  )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('demo_autopilot_mandates', 'autopilot_events')
        AND has_column_privilege(
          :'app_role',
          format('%I.%I', table_schema, table_name),
          column_name,
          'UPDATE'
        )
    ) AS autopilot_evidence_is_immutable,
  NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'brain_versions',
        'autopilot_mandate_states',
        'autopilot_controls',
        'autopilot_decision_claims'
      )
      AND has_column_privilege(
        :'app_role',
        format('%I.%I', table_schema, table_name),
        column_name,
        'UPDATE'
      ) IS DISTINCT FROM CASE
        WHEN table_name = 'brain_versions'
          THEN column_name IN ('state', 'updated_at')
        WHEN table_name = 'autopilot_mandate_states'
          THEN column_name IN ('state', 'reason_code', 'reason', 'updated_at')
        WHEN table_name = 'autopilot_controls'
          THEN column_name IN (
            'mandate_id', 'state', 'reason_code', 'reason',
            'global_suspended', 'config_suspended', 'equity_day',
            'day_start_equity_usdt', 'high_water_equity_usdt',
            'last_evaluated_at', 'updated_at'
          )
        WHEN table_name = 'autopilot_decision_claims'
          THEN column_name IN (
            'status', 'execution_intent_id', 'trade_id',
            'outcome_reason', 'updated_at'
          )
        ELSE false
      END
  ) AS autopilot_projection_updates_are_bounded,
  NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'live_execution_states',
        'live_global_equity_state',
        'live_kill_switches',
        'live_safety_events'
      )
      AND (
        NOT has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'SELECT')
        OR NOT has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'INSERT')
        OR has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'DELETE')
        OR has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'TRUNCATE')
      )
  )
    AND NOT has_table_privilege(:'app_role', 'public.live_safety_events', 'UPDATE')
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'live_execution_states',
          'live_global_equity_state',
          'live_kill_switches'
        )
        AND has_column_privilege(
          :'app_role',
          format('%I.%I', table_schema, table_name),
          column_name,
          'UPDATE'
        ) IS DISTINCT FROM CASE
          WHEN table_name = 'live_execution_states'
            THEN column_name IN (
              'operating_mode', 'operating_mode_source',
              'reconciliation_state', 'protection_state',
              'global_drawdown_state', 'ownership_generation',
               'owner_instance_id', 'current_equity_minor',
               'peak_equity_minor', 'equity_source',
               'equity_observed_at', 'equity_fresh_until',
               'account_drawdown_state', 'account_drawdown_limit_bps',
              'global_drawdown_limit_bps', 'entry_block_reason',
              'owner_claimed_at', 'last_reconciled_at',
              'last_incident_at', 'updated_at'
             )
          WHEN table_name = 'live_global_equity_state'
            THEN column_name IN (
              'current_equity_minor', 'peak_equity_minor', 'source_count',
              'observed_at', 'fresh_until', 'drawdown_state',
              'drawdown_limit_bps', 'updated_at'
            )
          WHEN table_name = 'live_kill_switches'
            THEN column_name IN ('active', 'deactivated_at', 'updated_at')
          ELSE false
        END
  ) AS phase11_privileges_are_bounded,
  NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'trading_mandates',
        'trading_mandate_states',
        'trading_mandate_events',
        'trading_mandate_authorizations',
        'trading_mandate_usage',
        'trading_mandate_decision_claims'
      )
      AND (
        NOT has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'SELECT')
        OR NOT has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'INSERT')
        OR has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'DELETE')
        OR has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'TRUNCATE')
      )
  )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'trading_mandates',
          'trading_mandate_events',
          'trading_mandate_authorizations'
        )
        AND has_column_privilege(
          :'app_role',
          format('%I.%I', table_schema, table_name),
          column_name,
          'UPDATE'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'trading_mandate_states',
          'trading_mandate_usage',
          'trading_mandate_decision_claims'
        )
        AND has_column_privilege(
          :'app_role',
          format('%I.%I', table_schema, table_name),
          column_name,
          'UPDATE'
        ) IS DISTINCT FROM CASE
          WHEN table_name = 'trading_mandate_states'
            THEN column_name IN (
              'state', 'lifecycle_version', 'reason_code', 'reason',
              'approving_human_id', 'authorization_method',
              'authorization_id', 'authorized_at', 'updated_at'
            )
          WHEN table_name = 'trading_mandate_usage'
            THEN column_name IN (
              'aggregate_exposure', 'canary_used', 'daily_loss',
              'weekly_loss', 'monthly_loss', 'drawdown_bps',
              'open_position_count', 'open_order_count', 'last_decision_at',
              'decisions_last_hour', 'entries_last_hour', 'status',
              'stale_reasons', 'observed_at', 'updated_at'
            )
          WHEN table_name = 'trading_mandate_decision_claims'
            THEN column_name IN (
              'status', 'reason_code', 'reason', 'execution_intent_id',
              'broker_command_id', 'broker_order_id', 'trade_id', 'fill_id',
              'suspension_event_id', 'realized_slippage_bps',
              'fill_latency_ms', 'live_demo_divergence_bps', 'updated_at'
            )
          ELSE false
        END
    ) AS phase12_privileges_are_bounded,
  has_table_privilege(:'app_role', 'public.execution_events', 'SELECT')
    AND has_table_privilege(:'app_role', 'public.execution_events', 'INSERT')
    AND has_table_privilege(:'app_role', 'public.recommendation_events', 'SELECT')
    AND has_table_privilege(:'app_role', 'public.recommendation_events', 'INSERT')
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'brain_versions',
          'demo_autopilot_mandates',
          'autopilot_mandate_states',
          'autopilot_controls',
          'autopilot_decision_claims',
          'autopilot_events'
        )
        AND (
          NOT has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'SELECT')
          OR NOT has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'INSERT')
        )
    ) AS public_events_have_required_access,
  COALESCE((
    SELECT pg_get_userbyid(p.proowner) = :'owner_role'
      AND p.prosecdef
      AND has_function_privilege(:'app_role', p.oid, 'EXECUTE')
      AND NOT EXISTS (
        SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      )
    FROM pg_proc AS p WHERE p.oid = to_regprocedure('capture.purge_user_data(integer)')
  ), false) AS purge_function_is_hardened,
  NOT EXISTS (
    SELECT 1 FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'capture'
      AND p.oid <> to_regprocedure('capture.purge_user_data(integer)')
      AND has_function_privilege(:'app_role', p.oid, 'EXECUTE')
  ) AS runtime_executes_only_purge_in_capture
\gset

\if :migration_owns_database
\else
  \echo 'FAIL: migration role does not own the database'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: migration role does not own the database'; END $failure$;
\endif
\if :runtime_not_owner_member
\else
  \echo 'FAIL: runtime role can assume owner role'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: runtime role can assume owner role'; END $failure$;
\endif
\if :runtime_role_is_unprivileged
\else
  \echo 'FAIL: runtime role has administrative PostgreSQL attributes'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: runtime role has administrative PostgreSQL attributes'; END $failure$;
\endif
\if :runtime_cannot_create_schemas
\else
  \echo 'FAIL: runtime role can create schemas'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: runtime role can create schemas'; END $failure$;
\endif
\if :migration_owns_schemas
\else
  \echo 'FAIL: migration role does not own public/capture schemas'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: migration role does not own public/capture schemas'; END $failure$;
\endif
\if :migration_owns_data_objects
\else
  \echo 'FAIL: migration role does not own every public/capture data object'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: migration role does not own every public/capture data object'; END $failure$;
\endif
\if :migration_owns_functions
\else
  \echo 'FAIL: migration role does not own every public/capture function'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: migration role does not own every public/capture function'; END $failure$;
\endif
\if :capture_is_immutable
\else
  \echo 'FAIL: runtime role can mutate capture evidence'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: runtime role can mutate capture evidence'; END $failure$;
\endif
\if :capture_has_required_access
\else
  \echo 'FAIL: runtime role lacks required SELECT/INSERT access to capture evidence'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: runtime role lacks required SELECT/INSERT access to capture evidence'; END $failure$;
\endif
\if :execution_events_are_immutable
\else
  \echo 'FAIL: runtime role can mutate execution_events'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: runtime role can mutate execution_events'; END $failure$;
\endif
\if :recommendation_events_are_immutable
\else
  \echo 'FAIL: runtime role can mutate recommendation_events'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: runtime role can mutate recommendation_events'; END $failure$;
\endif
\if :live_safety_events_are_immutable
\else
  \echo 'FAIL: runtime role can mutate live_safety_events'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: runtime role can mutate live_safety_events'; END $failure$;
\endif
\if :phase10_tables_exist
\else
  \echo 'FAIL: one or more required Demo Autopilot tables are missing'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: one or more required Demo Autopilot tables are missing'; END $failure$;
\endif
\if :phase11_tables_exist
\else
  \echo 'FAIL: one or more required Phase 11 Live safety tables are missing'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: one or more required Phase 11 tables are missing'; END $failure$;
\endif
\if :phase12_tables_exist
\else
  \echo 'FAIL: one or more required Phase 12 TradingMandate tables are missing'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: one or more required Phase 12 tables are missing'; END $failure$;
\endif
\if :autopilot_evidence_is_immutable
\else
  \echo 'FAIL: runtime role can mutate immutable Demo Autopilot evidence'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: runtime role can mutate immutable Demo Autopilot evidence'; END $failure$;
\endif
\if :autopilot_projection_updates_are_bounded
\else
  \echo 'FAIL: runtime role can update unapproved Demo Autopilot columns'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: runtime role can update unapproved Demo Autopilot columns'; END $failure$;
\endif
\if :phase11_privileges_are_bounded
\else
  \echo 'FAIL: Phase 11 Live safety table privileges are broader than required'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: Phase 11 Live safety privileges are not bounded'; END $failure$;
\endif
\if :phase12_privileges_are_bounded
\else
  \echo 'FAIL: Phase 12 TradingMandate privileges are broader than required'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: Phase 12 privileges are not bounded'; END $failure$;
\endif
\if :public_events_have_required_access
\else
  \echo 'FAIL: runtime role lacks required SELECT/INSERT access to public event evidence'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: runtime role lacks required SELECT/INSERT access to public evidence'; END $failure$;
\endif
\if :purge_function_is_hardened
\else
  \echo 'FAIL: capture.purge_user_data(integer) ownership/grants are not hardened'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: capture.purge_user_data(integer) is not hardened'; END $failure$;
\endif
\if :runtime_executes_only_purge_in_capture
\else
  \echo 'FAIL: runtime role can execute an unapproved capture function'
  DO $failure$ BEGIN RAISE EXCEPTION 'database security verification failed: runtime role can execute an unapproved capture function'; END $failure$;
\endif

\echo 'PASS: database owner/runtime separation and immutable evidence privileges verified'

SELECT d.datname, pg_get_userbyid(d.datdba) AS database_owner
FROM pg_database AS d WHERE d.datname = current_database();

SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind,
       pg_get_userbyid(c.relowner) AS owner
FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'capture') AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
ORDER BY n.nspname, c.relname;

SELECT table_schema, table_name,
       has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'SELECT') AS can_select,
       has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'INSERT') AS can_insert,
       has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'UPDATE') AS can_update,
       has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'DELETE') AS can_delete,
       has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'TRUNCATE') AS can_truncate
FROM information_schema.tables
WHERE table_schema = 'capture'
   OR (table_schema = 'public' AND table_name IN (
     'execution_events',
     'recommendation_events',
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
     'live_safety_events'
   ))
ORDER BY table_schema, table_name;

SELECT p.oid::regprocedure::text AS function_name, pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       has_function_privilege(:'app_role', p.oid, 'EXECUTE') AS runtime_can_execute,
       EXISTS (
         SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS privilege
         WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
       ) AS public_can_execute
FROM pg_proc AS p WHERE p.oid = to_regprocedure('capture.purge_user_data(integer)');
