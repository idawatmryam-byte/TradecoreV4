\set ON_ERROR_STOP on

-- Drizzle 0.31.10 can lose composite-key column order during PostgreSQL
-- introspection. Reconcile this long-standing invariant explicitly before the
-- schema diff so a populated table never reaches Drizzle's truncate prompt.
DO $reconcile$
DECLARE
  table_oid oid := to_regclass('public.blacklist_entries');
  actual_columns text[];
  expected_columns constant text[] := ARRAY['user_id', 'section', 'symbol'];
  duplicate_groups bigint;
BEGIN
  IF table_oid IS NULL THEN
    RETURN;
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
      'blacklist schema reconciliation refused: % duplicate (user_id, section, symbol) groups',
      duplicate_groups;
  END IF;

  SELECT array_agg(attribute.attname ORDER BY key.ordinality)
  INTO actual_columns
  FROM pg_constraint constraint_record
  CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS key(attnum, ordinality)
  JOIN pg_attribute attribute
    ON attribute.attrelid = constraint_record.conrelid
   AND attribute.attnum = key.attnum
  WHERE constraint_record.conrelid = table_oid
    AND constraint_record.contype = 'u'
    AND constraint_record.conname = 'blacklist_user_section_symbol_unique';

  IF actual_columns IS NULL THEN
    ALTER TABLE public.blacklist_entries
      ADD CONSTRAINT blacklist_user_section_symbol_unique
      UNIQUE (user_id, section, symbol);
  ELSIF actual_columns <> expected_columns THEN
    IF actual_columns @> expected_columns AND expected_columns @> actual_columns THEN
      -- Column order changes index access characteristics but not the uniqueness
      -- invariant. Normalize it transactionally without touching table rows.
      ALTER TABLE public.blacklist_entries
        DROP CONSTRAINT blacklist_user_section_symbol_unique;
      ALTER TABLE public.blacklist_entries
        ADD CONSTRAINT blacklist_user_section_symbol_unique
        UNIQUE (user_id, section, symbol);
    ELSE
      RAISE EXCEPTION
        'blacklist schema reconciliation refused: constraint uses columns %, expected %',
        actual_columns,
        expected_columns;
    END IF;
  END IF;
END
$reconcile$;
