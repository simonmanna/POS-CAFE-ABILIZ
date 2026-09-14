-- Native document sequences are tenant-prefixed. Test and deleted tenants used
-- to leave theirs behind indefinitely, bloating pg_class until pg_dump could no
-- longer acquire enough relation locks. Drop only prefixes that cannot belong
-- to a current Organization; active tenant numbering is untouched.
DO $cleanup$
DECLARE seq record;
BEGIN
  FOR seq IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
      AND c.relname ~ '^seq_[0-9a-f]{8}_'
      AND substring(c.relname from 5 for 8) NOT IN (
        SELECT substring(replace(id::text, '-', '') from 1 for 8) FROM "Organization"
      )
  LOOP
    EXECUTE format('DROP SEQUENCE IF EXISTS %I', seq.relname);
  END LOOP;
END $cleanup$;
