-- Model a new Phase 10 table created after the one-time role hardening. Public
-- schema defaults give it broad runtime mutation until the regular post-schema
-- security step is reapplied.
\set ON_ERROR_STOP on
\if :{?app_role}
\else
  DO $failure$ BEGIN RAISE EXCEPTION 'app_role is required'; END $failure$;
\endif

GRANT UPDATE, DELETE, TRUNCATE ON TABLE
  public.demo_autopilot_mandates,
  public.autopilot_events,
  public.autopilot_decision_claims
TO :"app_role";

GRANT UPDATE (mandate_fingerprint)
  ON TABLE public.autopilot_decision_claims TO :"app_role";
