-- scripts/sql/migrate-owner-from-postgres.sql
-- One-time migration: transfer TradeCore database/schema/object ownership
-- from postgres superuser to tradecore_owner.
-- Run ONLY via: sudo -u postgres psql -d tradecore -v ON_ERROR_STOP=1 \
--   -v owner_role=tradecore_owner -v app_role=tradecore_runtime \
--   -f scripts/sql/migrate-owner-from-postgres.sql

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

-- ============================================================
-- PRE-CONDITION ASSERTIONS
-- ============================================================

-- 1. Current database is tradecore
SELECT current_database() = 'tradecore' AS db_is_tradecore \gset
\if :db_is_tradecore
\else
  \echo 'FAIL: Connected database is not tradecore'
  \quit 3
\endif

-- 2. Target roles exist
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner_role') AS owner_exists \gset
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') AS app_exists \gset
\if :owner_exists
\else
  \echo 'FAIL: owner_role does not exist'
  \quit 3
\endif
\if :app_exists
\else
  \echo 'FAIL: app_role does not exist'
  \quit 3
\endif

-- 3. Current owners match expected state (postgres for all target objects)
SELECT pg_get_userbyid(datdba) = 'postgres' AS db_owner_is_postgres
FROM pg_database WHERE datname = 'tradecore' \gset
\if :db_owner_is_postgres
\else
  \echo 'FAIL: Database owner is not postgres (unexpected state)'
  \quit 3
\endif

-- Check that both schemas exist and are owned by postgres
SELECT count(*) = 2 AS schemas_ok
FROM pg_namespace
WHERE nspname IN ('public', 'capture')
  AND pg_get_userbyid(nspowner) = 'postgres' \gset
\if :schemas_ok
\else
  \echo 'FAIL: Expected 2 schemas (public, capture) owned by postgres'
  \quit 3
\endif

-- 4. Verify ALL tables/sequences in public/capture are owned by postgres
SELECT count(*) = 0 AS non_postgres_tables
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'capture')
  AND c.relkind IN ('r', 'S')
  AND pg_get_userbyid(c.relowner) <> 'postgres' \gset
\if :non_postgres_tables
\else
  \echo 'FAIL: Some tables/sequences in public/capture are not owned by postgres'
  \quit 3
\endif

-- 5. Verify no objects in public/capture are owned by tradecore or tradecore_owner yet
SELECT count(*) = 0 AS premature_owned
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'capture')
  AND c.relkind IN ('r', 'S')
  AND pg_get_userbyid(c.relowner) IN (:'owner_role', :'app_role') \gset
\if :premature_owned
\else
  \echo 'FAIL: Some objects already owned by target roles (unexpected state)'
  \quit 3
\endif

-- 6. Verify capture.purge_user_data is owned by owner_role
SELECT pg_get_userbyid(p.proowner) = :'owner_role' AS purge_owner_ok
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'capture' AND p.oid = to_regprocedure('capture.purge_user_data(integer)') \gset
\if :purge_owner_ok
\else
  \echo 'FAIL: capture.purge_user_data not owned by owner_role'
  \quit 3
\endif

\echo 'All pre-condition assertions passed. Starting ownership migration...'

-- ============================================================
-- OWNERSHIP TRANSFER
-- ============================================================

BEGIN;

-- 1. Database ownership
ALTER DATABASE tradecore OWNER TO :"owner_role";
\echo 'ALTER DATABASE tradecore OWNER TO ' :"owner_role";

-- 2. Schema ownership
ALTER SCHEMA public OWNER TO :"owner_role";
ALTER SCHEMA capture OWNER TO :"owner_role";
\echo 'ALTER SCHEMA public, capture OWNER TO ' :"owner_role";

-- 3. Tables (relkind='r') - explicit per-schema to ensure scope
SELECT format('ALTER TABLE %I.%I OWNER TO %I', n.nspname, c.relname, :'owner_role') AS cmd
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'capture')
  AND c.relkind = 'r'
  AND pg_get_userbyid(c.relowner) = 'postgres'
ORDER BY n.nspname, c.relname \gexec
\echo 'Transferred all tables in public/capture';

-- 4. Sequences (relkind='S') - explicit per-schema
SELECT format('ALTER SEQUENCE %I.%I OWNER TO %I', n.nspname, c.relname, :'owner_role') AS cmd
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'capture')
  AND c.relkind = 'S'
  AND pg_get_userbyid(c.relowner) = 'postgres'
ORDER BY n.nspname, c.relname \gexec
\echo 'Transferred all sequences in public/capture';

-- 5. Views, materialized views, foreign tables, partitioned tables
-- (none currently exist, but handle defensively)
SELECT CASE c.relkind
         WHEN 'v' THEN format('ALTER VIEW %I.%I OWNER TO %I', n.nspname, c.relname, :'owner_role')
         WHEN 'm' THEN format('ALTER MATERIALIZED VIEW %I.%I OWNER TO %I', n.nspname, c.relname, :'owner_role')
         WHEN 'f' THEN format('ALTER FOREIGN TABLE %I.%I OWNER TO %I', n.nspname, c.relname, :'owner_role')
         WHEN 'p' THEN format('ALTER TABLE %I.%I OWNER TO %I', n.nspname, c.relname, :'owner_role')
       END AS cmd
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'capture')
  AND c.relkind IN ('v', 'm', 'f', 'p')
  AND pg_get_userbyid(c.relowner) = 'postgres'
ORDER BY n.nspname, c.relname \gexec
\echo 'Transferred views/materialized views/foreign tables/partitioned tables (if any)';

-- 6. Functions/Procedures (excluding capture.purge_user_data already owned by owner_role)
SELECT CASE p.prokind
         WHEN 'f' THEN format('ALTER FUNCTION %I.%I(%s) OWNER TO %I', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), :'owner_role')
         WHEN 'p' THEN format('ALTER PROCEDURE %I.%I(%s) OWNER TO %I', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), :'owner_role')
       END AS cmd
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'capture')
  AND pg_get_userbyid(p.proowner) = 'postgres'
  AND NOT (n.nspname = 'capture' AND p.oid = to_regprocedure('capture.purge_user_data(integer)'))
ORDER BY n.nspname, p.proname \gexec
\echo 'Transferred functions/procedures (if any)';

-- 7. Types/Domains (domains only; composite/array types auto-transfer with tables)
SELECT format('ALTER DOMAIN %I.%I OWNER TO %I', n.nspname, t.typname, :'owner_role') AS cmd
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname IN ('public', 'capture')
  AND t.typtype = 'd'  -- domains only
  AND pg_get_userbyid(t.typowner) = 'postgres'
ORDER BY n.nspname, t.typname \gexec
\echo 'Transferred domains (if any)';

COMMIT;

-- ============================================================
-- POST-MIGRATION HARDENING (from harden-database-roles.sql)
-- ============================================================

BEGIN;

-- Role attributes
ALTER ROLE :"owner_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE :"app_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
REVOKE :"owner_role" FROM :"app_role";
-- Legacy role 'tradecore' may not exist; ignore if missing
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tradecore') THEN
    EXECUTE 'REVOKE tradecore FROM ' || quote_ident(:'app_role');
  END IF;
END $$;

-- Database/schema privileges
REVOKE CREATE ON DATABASE tradecore FROM PUBLIC, :"app_role";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public, capture FROM :"app_role";
GRANT CONNECT ON DATABASE tradecore TO :"app_role";
GRANT USAGE ON SCHEMA public, capture TO :"app_role";

-- Public tables/sequences
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";

-- Phase 10 immutable evidence tables
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.execution_events FROM :"app_role";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.recommendation_events FROM :"app_role";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.live_safety_events FROM :"app_role";
\ir phase-10-runtime-grants.sql

-- Capture schema: append-only
REVOKE ALL ON ALL TABLES IN SCHEMA capture FROM :"app_role";
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA capture TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA capture TO :"app_role";

-- Default privileges for future objects
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA capture
  GRANT SELECT, INSERT ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA capture
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA capture
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;

\echo 'Migration and hardening complete. Run verify-database-roles.sql to confirm.'