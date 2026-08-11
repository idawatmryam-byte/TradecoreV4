-- Read-only verification for the TradeCore production owner/runtime split.
\set ON_ERROR_STOP on

SELECT
  COALESCE((SELECT pg_get_userbyid(datdba) <> :'app_role' FROM pg_database WHERE datname = current_database()), false) AS runtime_not_database_owner,
  NOT pg_has_role(:'app_role', :'owner_role', 'MEMBER') AS runtime_not_owner_member,
  NOT EXISTS (
    SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'capture') AND c.relkind IN ('r', 'p', 'S')
      AND pg_get_userbyid(c.relowner) = :'app_role'
  ) AS runtime_owns_no_data_objects,
  NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'capture'
      AND (has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'UPDATE')
        OR has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'DELETE')
        OR has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'TRUNCATE'))
  ) AS capture_is_immutable,
  NOT has_table_privilege(:'app_role', 'public.execution_events', 'UPDATE')
    AND NOT has_table_privilege(:'app_role', 'public.execution_events', 'DELETE')
    AND NOT has_table_privilege(:'app_role', 'public.execution_events', 'TRUNCATE') AS execution_events_are_immutable,
  NOT has_table_privilege(:'app_role', 'public.recommendation_events', 'UPDATE')
    AND NOT has_table_privilege(:'app_role', 'public.recommendation_events', 'DELETE')
    AND NOT has_table_privilege(:'app_role', 'public.recommendation_events', 'TRUNCATE') AS recommendation_events_are_immutable,
  COALESCE((
    SELECT pg_get_userbyid(p.proowner) = :'owner_role'
      AND p.prosecdef
      AND has_function_privilege(:'app_role', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
    FROM pg_proc AS p WHERE p.oid = to_regprocedure('capture.purge_user_data(integer)')
  ), false) AS purge_function_is_hardened
\gset

\if :runtime_not_database_owner
\else
  \echo 'FAIL: runtime role owns the database'
  \quit 4
\endif
\if :runtime_not_owner_member
\else
  \echo 'FAIL: runtime role can assume owner role'
  \quit 4
\endif
\if :runtime_owns_no_data_objects
\else
  \echo 'FAIL: runtime role still owns public/capture data objects'
  \quit 4
\endif
\if :capture_is_immutable
\else
  \echo 'FAIL: runtime role can mutate capture evidence'
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
\if :purge_function_is_hardened
\else
  \echo 'FAIL: capture.purge_user_data(integer) ownership/grants are not hardened'
  \quit 4
\endif

\echo 'PASS: database owner/runtime separation and immutable evidence privileges verified'

SELECT d.datname,
       pg_get_userbyid(d.datdba) AS database_owner,
       pg_get_userbyid(d.datdba) <> :'app_role' AS runtime_is_not_database_owner
FROM pg_database AS d
WHERE d.datname = current_database();

SELECT NOT pg_has_role(:'app_role', :'owner_role', 'MEMBER') AS runtime_cannot_assume_owner;

SELECT n.nspname AS schema_name,
       c.relname AS object_name,
       c.relkind,
       pg_get_userbyid(c.relowner) AS owner,
       pg_get_userbyid(c.relowner) <> :'app_role' AS runtime_is_not_owner
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'capture')
  AND c.relkind IN ('r', 'p', 'S')
ORDER BY n.nspname, c.relname;

SELECT table_schema, table_name,
       has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'SELECT') AS can_select,
       has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'INSERT') AS can_insert,
       has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'UPDATE') AS can_update,
       has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'DELETE') AS can_delete,
       has_table_privilege(:'app_role', format('%I.%I', table_schema, table_name), 'TRUNCATE') AS can_truncate
FROM information_schema.tables
WHERE table_schema = 'capture'
   OR (table_schema = 'public' AND table_name IN ('execution_events', 'recommendation_events'))
ORDER BY table_schema, table_name;

SELECT p.oid::regprocedure::text AS function_name,
       pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       has_function_privilege(:'app_role', p.oid, 'EXECUTE') AS runtime_can_execute,
       has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute
FROM pg_proc AS p
WHERE p.oid = to_regprocedure('capture.purge_user_data(integer)');
