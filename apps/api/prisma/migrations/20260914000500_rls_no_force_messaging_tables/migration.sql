-- pg_dump run as the table owner refuses to dump any table whose row-level
-- security is FORCEd ("query would be affected by row-level security policy"),
-- so a single FORCEd table makes every nightly backup fail. The remaining
-- messaging/DMS tables are all organization-scoped in the Prisma tenancy
-- extension, which is the tenant boundary for every other table too.
-- Policies stay ENABLED for non-owner roles.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
    WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace AND c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;
