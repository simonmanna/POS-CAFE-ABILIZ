-- Align every deployment with the tenancy architecture that is actually tested.
--
-- Earlier migrations FORCEd row-level security on most organization-scoped
-- tables. The application role OWNS these tables and sets app.org_id only
-- inside interactive transactions, so FORCE makes every non-transactional read
-- return nothing and every non-transactional insert fail (42501) whenever the
-- API connects as a non-superuser owner. Databases that were hand-corrected
-- worked; a database built purely from migrations did not.
--
-- Tenant isolation is enforced by the Prisma tenancy extension (ORG_SCOPED) and
-- the raw-SQL tenancy release spec. Policies stay ENABLED so a separate
-- non-owner role (reporting, support) is still bound by them. The messaging
-- tables below keep FORCE: their writes are always transactional and they are
-- verified with FORCE in the tested database.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
    WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace AND c.relforcerowsecurity
      AND c.relname NOT IN ('CommunicationChannel', 'CommunicationDispatch', 'CommunicationRule', 'Conversation', 'ConversationChannel', 'ConversationParticipant', 'DMSWorkflowLedger', 'ExternalIdentity', 'ExternalMessage', 'Message', 'MessageAttachment', 'MessageDelivery', 'MessageTemplate', 'WhatsAppAuthState')
  LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;
