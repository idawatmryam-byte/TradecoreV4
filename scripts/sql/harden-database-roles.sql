-- TradeCore production database authority split.
--
-- Run with the migration/administrative connection, never DATABASE_URL used
-- by the application process:
--   psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 \
--     -v database_name=tradecore -v legacy_role=tradecore \
--     -v owner_role=tradecore_owner \
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
\if :{?legacy_role}
\else
  \echo 'legacy_role is required'
  \quit 2
\endif
\if :{?app_role}
\else
  \echo 'app_role is required'
  \quit 2
\endif

SELECT current_database() = :'database_name' AS database_matches,
       :'legacy_role' <> :'owner_role' AND :'legacy_role' <> :'app_role' AS roles_are_distinct,
       COALESCE((SELECT pg_get_userbyid(datdba) = :'legacy_role' FROM pg_database WHERE datname = current_database()), false) AS legacy_is_current_owner,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'legacy_role') AS legacy_exists,
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
\if :legacy_is_current_owner
\else
  \echo 'Current database owner is not legacy_role; refusing ambiguous ownership transfer'
  \quit 3
\endif
\if :legacy_exists
\else
  \echo 'legacy_role does not exist'
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

-- Reassign every object owned by the actual former single owner/runtime role.
-- Reassigning app_role would be a no-op during the reviewed tradecore ->
-- tradecore_owner/tradecore_runtime migration because app_role is newly made.
REASSIGN OWNED BY :"legacy_role" TO :"owner_role";
ALTER DATABASE :"database_name" OWNER TO :"owner_role";
ALTER SCHEMA public OWNER TO :"owner_role";
ALTER SCHEMA capture OWNER TO :"owner_role";

ALTER ROLE :"owner_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE :"app_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
REVOKE :"owner_role" FROM :"app_role";
REVOKE :"legacy_role" FROM :"app_role";

REVOKE CREATE ON DATABASE :"database_name" FROM PUBLIC, :"app_role";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public, capture FROM :"app_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"app_role";
GRANT USAGE ON SCHEMA public, capture TO :"app_role";

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";

-- Existing immutable public evidence. Phase 10's complete table/column policy
-- is shared with the regular post-schema security installation below.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.execution_events FROM :"app_role";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.recommendation_events FROM :"app_role";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.live_safety_events FROM :"app_role";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.platform_role_assignments FROM :"app_role";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.platform_access_versions FROM :"app_role";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.platform_audit_events FROM :"app_role";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.platform_autopilot_clearance_events FROM :"app_role";
\ir phase-10-runtime-grants.sql

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
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA capture
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;

\echo 'Role split applied. Run verify-database-roles.sql with the same variables before restarting TradeCore.'
