\set ON_ERROR_STOP on

DO $verify$
DECLARE
  actual_blacklist_columns text[];
  duplicate_groups bigint;
  missing_objects text[];
BEGIN
  IF to_regclass('public.blacklist_entries') IS NULL THEN
    RAISE EXCEPTION 'deployment schema verification failed: blacklist_entries is missing';
  END IF;

  SELECT array_agg(attribute.attname ORDER BY key.ordinality)
  INTO actual_blacklist_columns
  FROM pg_constraint constraint_record
  CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS key(attnum, ordinality)
  JOIN pg_attribute attribute
    ON attribute.attrelid = constraint_record.conrelid
   AND attribute.attnum = key.attnum
  WHERE constraint_record.conrelid = 'public.blacklist_entries'::regclass
    AND constraint_record.contype = 'u'
    AND constraint_record.conname = 'blacklist_user_section_symbol_unique';

  IF actual_blacklist_columns IS DISTINCT FROM ARRAY['user_id', 'section', 'symbol']::text[] THEN
    RAISE EXCEPTION
      'deployment schema verification failed: blacklist constraint columns are %, expected {user_id,section,symbol}',
      actual_blacklist_columns;
  END IF;

  SELECT count(*)
  INTO duplicate_groups
  FROM (
    SELECT user_id, section, symbol
    FROM public.blacklist_entries
    GROUP BY user_id, section, symbol
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_groups <> 0 THEN
    RAISE EXCEPTION
      'deployment schema verification failed: blacklist_entries has % duplicate groups',
      duplicate_groups;
  END IF;

  WITH required_objects(object_name, column_name) AS (
    VALUES
      ('brain_versions', 'fingerprint'),
      ('demo_autopilot_mandates', 'fingerprint'),
      ('autopilot_mandate_states', 'state'),
      ('autopilot_controls', 'global_suspended'),
      ('autopilot_decision_claims', 'idempotency_key'),
      ('autopilot_events', 'reason_code'),
      ('execution_intents', 'autopilot_idempotency_key'),
      ('execution_intents', 'command_idempotency_key'),
      ('execution_intents', 'ownership_generation'),
      ('execution_intents', 'recovery_client_order_id'),
      ('live_execution_states', 'reconciliation_state'),
      ('live_execution_states', 'equity_fresh_until'),
      ('live_execution_states', 'global_drawdown_state'),
      ('live_global_equity_state', 'drawdown_state'),
      ('live_kill_switches', 'scope'),
      ('live_safety_events', 'reason_code'),
      ('live_safety_events', 'event_key'),
      ('trades', 'autopilot_phase7_actions')
  )
  SELECT array_agg(format('%I.%I', required.object_name, required.column_name)
                   ORDER BY required.object_name, required.column_name)
  INTO missing_objects
  FROM required_objects required
  LEFT JOIN information_schema.columns present
    ON present.table_schema = 'public'
   AND present.table_name = required.object_name
   AND present.column_name = required.column_name
  WHERE present.column_name IS NULL;

  IF missing_objects IS NOT NULL THEN
    RAISE EXCEPTION
      'deployment schema verification failed: missing expected Phase 10/11 objects %',
      missing_objects;
  END IF;
END
$verify$;

\echo 'PASS: deployment schema and Phase 10/11 objects verified'
