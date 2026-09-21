-- =====================================================================
-- CAFE DISCOVERY - read-only.
--
-- Run this against the LIVE cafe database before anything else. It writes
-- nothing: every statement is a SELECT, and the session is forced read-only on
-- the first line, so a mistake cannot become a change.
--
--   psql "postgresql://<user>@<host>:5432/POS-CAFE" -f 00-cafe-discovery.sql > discovery-<date>.txt
--
-- What it answers, in the order the runbook needs it:
--   1. server, database, encoding, TIMEZONE (the -07 question)
--   2. the connecting role, and whether it bypasses RLS
--   3. who owns the tables (the new API must not run as a superuser)
--   4. migration history (expect the 7 cafe rows)
--   5. object inventory, to compare against the dump
--   6. data volumes
--   7. open operational state - all of it must be zero at the FINAL backup
--   8. document numbering, so continuity can be proved after the migration
--   9. backup lock capacity (pg_dump needs one lock per relation)
--  10. drawer ledger per register (the first new shift depends on it)
-- =====================================================================

\set ON_ERROR_STOP on
SET default_transaction_read_only = on;

\echo ''
\echo '== 1. server and database =='
SELECT version() AS server_version;
SELECT current_database()                                AS database,
       pg_size_pretty(pg_database_size(current_database())) AS size,
       current_setting('TimeZone')                       AS session_timezone,
       current_setting('log_timezone')                   AS log_timezone,
       (SELECT datcollate FROM pg_database WHERE datname = current_database()) AS collation,
       pg_encoding_to_char((SELECT encoding FROM pg_database WHERE datname = current_database())) AS encoding;

-- The dump renders timestamptz at -07 while the organization is Africa/Kampala.
-- These three rows are the evidence for that investigation.
SELECT 'server timezone GUC' AS what, current_setting('TimeZone') AS value
 UNION ALL SELECT 'now() as text', now()::text
 UNION ALL SELECT 'utc now as text', (now() AT TIME ZONE 'UTC')::text;

\echo ''
\echo '== 2. connecting role =='
SELECT current_user AS connected_as, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
  FROM pg_roles WHERE rolname = current_user;

\echo ''
\echo '== 3. table ownership (the app should run as a non-superuser owner) =='
SELECT tableowner, count(*) AS tables
  FROM pg_tables WHERE schemaname = 'public'
 GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '== 4. migration history =='
SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count
  FROM "_prisma_migrations" ORDER BY started_at;

\echo ''
\echo '== 5. object inventory =='
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') AS tables,
       (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e') AS enums,
       (SELECT count(*) FROM pg_indexes WHERE schemaname='public')        AS indexes,
       (SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype='f') AS foreign_keys,
       (SELECT count(*) FROM pg_policies WHERE schemaname='public')       AS rls_policies,
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind='S')                      AS sequences,
       (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND NOT t.tgisinternal)                 AS triggers;

SELECT extname, extversion FROM pg_extension ORDER BY 1;

\echo ''
\echo '== 6. data volumes =='
SELECT 'Organization' AS entity, count(*)::text AS rows FROM "Organization"
 UNION ALL SELECT 'User',            count(*)::text FROM "User"
 UNION ALL SELECT 'Role',            count(*)::text FROM "Role"
 UNION ALL SELECT 'Product',         count(*)::text FROM "Product"
 UNION ALL SELECT 'Order',           count(*)::text FROM "Order"
 UNION ALL SELECT 'Invoice',         count(*)::text FROM "Invoice"
 UNION ALL SELECT 'Payment',         count(*)::text FROM "Payment"
 UNION ALL SELECT 'Receipt',         count(*)::text FROM "Receipt"
 UNION ALL SELECT 'CashSession',     count(*)::text FROM "CashSession"
 UNION ALL SELECT 'CashMovement',    count(*)::text FROM "CashMovement"
 UNION ALL SELECT 'JournalEntry',    count(*)::text FROM "JournalEntry"
 UNION ALL SELECT 'JournalLine',     count(*)::text FROM "JournalLine"
 UNION ALL SELECT 'InventoryLedger', count(*)::text FROM "InventoryLedger"
 UNION ALL SELECT 'File',            count(*)::text FROM "File"
 ORDER BY 1;

-- The number every reconciliation starts from.
SELECT coalesce(sum(l."baseDebit"), 0)::text  AS posted_debit,
       coalesce(sum(l."baseCredit"), 0)::text AS posted_credit,
       (coalesce(sum(l."baseDebit"),0) = coalesce(sum(l."baseCredit"),0)) AS balanced
  FROM "JournalLine" l
  JOIN "JournalEntry" e ON e.id = l."journalEntryId"
 WHERE e.status = 'posted';

SELECT min("createdAt")::text AS first_order, max("createdAt")::text AS last_order FROM "Order";

\echo ''
\echo '== 7. open operational state (must ALL be zero at the final backup) =='
SELECT 'open shifts' AS item, count(*)::text AS rows FROM "CashSession" WHERE status::text = 'open'
 UNION ALL SELECT 'orders not invoiced', count(*)::text FROM "Order"
    WHERE "invoiceId" IS NULL AND status::text NOT IN ('closed','cancelled')
 UNION ALL SELECT 'parked carts', count(*)::text FROM "PosHold"
 UNION ALL SELECT 'KDS tickets still new', count(*)::text FROM "KitchenTicket" WHERE status::text = 'new'
 ORDER BY 1;

\echo ''
\echo '== 8. document numbering (continuity evidence) =='
SELECT c.relname AS sequence,
       (SELECT last_value FROM pg_sequences s WHERE s.schemaname='public' AND s.sequencename=c.relname) AS last_value
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname='public' AND c.relkind='S' AND c.relname LIKE 'seq_%'
 ORDER BY 1;

SELECT max("invoiceNumber") AS max_invoice_number,
       count(*)             AS invoices,
       count(DISTINCT "invoiceNumber") AS distinct_numbers
  FROM "Invoice";

\echo ''
\echo '== 9. backup lock capacity (pg_dump takes one lock per relation) =='
SELECT (SELECT count(*) FROM pg_class WHERE relkind IN ('r','i','S','t','m')) AS relations,
       current_setting('max_locks_per_transaction')::int * (current_setting('max_connections')::int + 1) AS lock_slots;

\echo ''
\echo '== 10. drawer ledger per register (decision D19) =='
-- The new system refuses to open a shift whose counted float is below the
-- drawer account's ledger (posted + reversed entries). The legacy system never
-- booked cash leaving the drawer, so this is every cash sale since day one.
-- Before the first shift, the owner records where that cash went (bank deposit
-- or transfer, through the application) down to the physical float.
SELECT r.code AS register, a.code AS drawer_account, a.name,
       coalesce(sum(l."baseDebit" - l."baseCredit"), 0)::text AS drawer_ledger
  FROM "CashRegister" r
  JOIN "Account" a ON a.id = r."defaultAccountId"
  LEFT JOIN "JournalLine" l ON l."accountId" = a.id
  LEFT JOIN "JournalEntry" e ON e.id = l."journalEntryId" AND e.status::text IN ('posted', 'reversed')
 WHERE l.id IS NULL OR e.id IS NOT NULL
 GROUP BY r.code, a.code, a.name ORDER BY 1;

\echo ''
\echo '== discovery complete - nothing was written =='
