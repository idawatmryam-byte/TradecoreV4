-- TradeCore production database authority split.
--
-- Run with the migration/administrative connection, never DATABASE_URL used
-- by the application process:
--   psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 \
--     -v database_name=tradecore -v owner_role=tradecore_owner \
--     -v app_role=tradecore_runtime -f scripts/sql/harden-database-roles.sql
--
-- Roles must already exist. Password creation/rotation belongs to the VPS
-- secret manager and is intentionally absent from repository SQL.

\set ON_ERROR_STOP on
\if :{?database_name}
\else
  \echo 'database_name is required'
  \quit 2
\endif
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

SELECT current_database() = :'database_name' AS database_matches,
       :'owner_role' <> :'app_role' AS roles_are_distinct,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner_role') AS owner_exists,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') AS app_exists
\gset

\if :database_matches
\else
  \echo 'Connected database does not match database_name; refusing role migration'
  \quit 3
\endif
\if :roles_are_distinct
\else
  \echo 'owner_role and app_role must be distinct'
  \quit 3
\endif
\if :owner_exists
\else
  \echo 'owner_role does not exist; create it through the VPS secret-managed role procedure'
  \quit 3
\endif
\if :app_exists
\else
  \echo 'app_role does not exist; create it through the VPS secret-managed role procedure'
  \quit 3
\endif

BEGIN;

-- Reassign objects in this database that the former single runtime/owner role
-- owns. This is the step that makes later REVOKEs effective.
REASSIGN OWNED BY :"app_role" TO :"owner_role";
ALTER DATABASE :"database_name" OWNER TO :"owner_role";
ALTER SCHEMA public OWNER TO :"owner_role";
ALTER SCHEMA capture OWNER TO :"owner_role";

ALTER ROLE :"app_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
REVOKE :"owner_role" FROM :"app_role";

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public, capture FROM :"app_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"app_role";
GRANT USAGE ON SCHEMA public, capture TO :"app_role";

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";

-- These public tables are immutable event evidence. Account erasure goes
-- through capture.purge_user_data(integer), not direct runtime DELETE.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.execution_events FROM :"app_role";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.recommendation_events FROM :"app_role";

REVOKE ALL ON ALL TABLES IN SCHEMA capture FROM :"app_role";
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA capture TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA capture TO :"app_role";

ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA capture
  GRANT SELECT, INSERT ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA capture
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";

COMMIT;

\echo 'Role split applied. Run verify-database-roles.sql with the same variables before restarting TradeCore.'
