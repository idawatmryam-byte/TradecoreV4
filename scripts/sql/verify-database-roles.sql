-- Fail-closed verification for the TradeCore production owner/runtime split.
\set ON_ERROR_STOP on

\if :{?owner_role}
\else
  \echo 'owner_role is required'
  \quit 2
\endif
\if :{?app_role}
\else
  \echo 'app_role is required'
  \quit 2
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
  NOT has_table_privilege(:'app_role', 'public.autopilot_events', 'UPDATE')
    AND NOT has_table_privilege(:'app_role', 'public.autopilot_events', 'DELETE')
    AND NOT has_table_privilege(:'app_role', 'public.autopilot_events', 'TRUNCATE')
    AND NOT has_table_privilege(:'app_role', 'public.demo_autopilot_mandates', 'UPDATE')
    AND NOT has_table_privilege(:'app_role', 'public.demo_autopilot_mandates', 'DELETE')
    AND NOT has_table_privilege(:'app_role', 'public.demo_autopilot_mandates', 'TRUNCATE') AS autopilot_evidence_is_immutable,
  has_table_privilege(:'app_role', 'public.execution_events', 'SELECT')
    AND has_table_privilege(:'app_role', 'public.execution_events', 'INSERT')
    AND has_table_privilege(:'app_role', 'public.recommendation_events', 'SELECT')
    AND has_table_privilege(:'app_role', 'public.recommendation_events', 'INSERT')
    AND has_table_privilege(:'app_role', 'public.autopilot_events', 'SELECT')
    AND has_table_privilege(:'app_role', 'public.autopilot_events', 'INSERT')
    AND has_table_privilege(:'app_role', 'public.demo_autopilot_mandates', 'SELECT')
    AND has_table_privilege(:'app_role', 'public.demo_autopilot_mandates', 'INSERT') AS public_events_have_required_access,
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
  \quit 4
\endif
\if :runtime_not_owner_member
\else
  \echo 'FAIL: runtime role can assume owner role'
  \quit 4
\endif
\if :runtime_role_is_unprivileged
\else
  \echo 'FAIL: runtime role has administrative PostgreSQL attributes'
  \quit 4
\endif
\if :runtime_cannot_create_schemas
\else
  \echo 'FAIL: runtime role can create schemas'
  \quit 4
\endif
\if :migration_owns_schemas
\else
  \echo 'FAIL: migration role does not own public/capture schemas'
  \quit 4
\endif
\if :migration_owns_data_objects
\else
  \echo 'FAIL: migration role does not own every public/capture data object'
  \quit 4
\endif
\if :migration_owns_functions
\else
  \echo 'FAIL: migration role does not own every public/capture function'
  \quit 4
\endif
\if :capture_is_immutable
\else
  \echo 'FAIL: runtime role can mutate capture evidence'
  \quit 4
\endif
\if :capture_has_required_access
\else
  \echo 'FAIL: runtime role lacks required SELECT/INSERT access to capture evidence'
  \quit 4
\endif
\if :execution_events_are_immutable
\else
  \echo 'FAIL: runtime role can mutate execution_events'
  \quit 4
\endif
\if :recommendation_events_are_immutable
\else
  \echo 'FAIL: runtime role can mutate recommendation_events'
  \quit 4
\endif
\if :autopilot_evidence_is_immutable
\else
  \echo 'FAIL: runtime role can mutate immutable Demo Autopilot evidence'
  \quit 4
\endif
\if :public_events_have_required_access
\else
  \echo 'FAIL: runtime role lacks required SELECT/INSERT access to public event evidence'
  \quit 4
\endif
\if :purge_function_is_hardened
\else
  \echo 'FAIL: capture.purge_user_data(integer) ownership/grants are not hardened'
  \quit 4
\endif
\if :runtime_executes_only_purge_in_capture
\else
  \echo 'FAIL: runtime role can execute an unapproved capture function'
  \quit 4
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
   OR (table_schema = 'public' AND table_name IN ('execution_events', 'recommendation_events', 'autopilot_events', 'demo_autopilot_mandates'))
ORDER BY table_schema, table_name;

SELECT p.oid::regprocedure::text AS function_name, pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       has_function_privilege(:'app_role', p.oid, 'EXECUTE') AS runtime_can_execute,
       EXISTS (
         SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS privilege
         WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
       ) AS public_can_execute
FROM pg_proc AS p WHERE p.oid = to_regprocedure('capture.purge_user_data(integer)');
