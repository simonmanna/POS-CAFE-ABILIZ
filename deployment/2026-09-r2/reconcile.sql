-- =====================================================================
-- POST-CUTOVER RECONCILIATION - read-only. Driven by reconcile.ps1.
--
--   psql -X -A -t -F '|' -v boundary='2026-09-27 17:30:00' -d cafe_pos_v2 -f reconcile.sql
--
-- :boundary is the cutover instant in UTC (the application stores UTC in
-- `timestamp without time zone` columns).
--
-- Output: one row per metric, "section|metric|value".
--   hist.*    history written BEFORE the boundary. Must never change after
--             go-live: Day 1/3/7/30 are compared to the Day 0 capture.
--   new.*     activity since the boundary (information for the owner).
--   check.*   health invariants. Any non-zero value is a finding.
--   watch.*   pre-existing legacy conditions; must not GROW.
-- =====================================================================
SET default_transaction_read_only = on;

-- ---------------- history (must be frozen) ----------------
SELECT 'hist', 'invoice_count', count(*)::text FROM "Invoice" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'invoice_total', coalesce(sum("totalAmount"), 0)::text FROM "Invoice" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'invoice_numbers_md5', md5(coalesce(string_agg("invoiceNumber", ',' ORDER BY "invoiceNumber"), '')) FROM "Invoice" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'payment_count', count(*)::text FROM "Payment" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'payment_amount', coalesce(sum(amount), 0)::text FROM "Payment" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'receipt_count', count(*)::text FROM "Receipt" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'journal_entry_count', count(*)::text FROM "JournalEntry" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'journal_debit', coalesce(sum(l."baseDebit"), 0)::text
            FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."journalEntryId" WHERE e."createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'journal_credit', coalesce(sum(l."baseCredit"), 0)::text
            FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."journalEntryId" WHERE e."createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'journal_by_account_md5', md5(coalesce(string_agg(x, ',' ORDER BY x), '')) FROM (
            SELECT a.code || ':' || sum(l."baseDebit")::text || ':' || sum(l."baseCredit")::text AS x
              FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."journalEntryId"
              JOIN "Account" a ON a.id = l."accountId"
             WHERE e."createdAt" < :'boundary' GROUP BY a.code) s
UNION ALL SELECT 'hist', 'inventory_ledger_count', count(*)::text FROM "InventoryLedger" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'inventory_qty_sum', coalesce(sum("quantityChange"), 0)::text FROM "InventoryLedger" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'inventory_value_sum', coalesce(sum("totalValue"), 0)::text FROM "InventoryLedger" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'cash_movement_count', count(*)::text FROM "CashMovement" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'cash_movement_amount', coalesce(sum(amount), 0)::text FROM "CashMovement" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'cash_session_count', count(*)::text FROM "CashSession" WHERE "createdAt" < :'boundary'
UNION ALL SELECT 'hist', 'legacy_migration_rows', count(*)::text FROM "_prisma_migrations" m
             WHERE m.migration_name IN (SELECT migration_name FROM legacy_archive.prisma_migrations)
UNION ALL SELECT 'hist', 'legacy_archive_tables', count(*)::text FROM pg_tables WHERE schemaname = 'legacy_archive'

-- ---------------- activity since the boundary ----------------
UNION ALL SELECT 'new', 'invoices', count(*)::text FROM "Invoice" WHERE "createdAt" >= :'boundary'
UNION ALL SELECT 'new', 'invoice_total', coalesce(sum("totalAmount"), 0)::text FROM "Invoice" WHERE "createdAt" >= :'boundary' AND status::text <> 'cancelled'
UNION ALL SELECT 'new', 'first_invoice_number', coalesce(min("invoiceNumber"), '-') FROM "Invoice" WHERE "createdAt" >= :'boundary'
UNION ALL SELECT 'new', 'last_invoice_number', coalesce(max("invoiceNumber"), '-') FROM "Invoice" WHERE "createdAt" >= :'boundary'
UNION ALL SELECT 'new', 'first_receipt_number', coalesce(min("receiptNumber"), '-') FROM "Receipt" WHERE "createdAt" >= :'boundary'
UNION ALL SELECT 'new', 'payments', count(*)::text FROM "Payment" WHERE "createdAt" >= :'boundary'
UNION ALL SELECT 'new', 'payment_amount_in', coalesce(sum(amount), 0)::text FROM "Payment" WHERE "createdAt" >= :'boundary' AND direction::text = 'inbound'
UNION ALL SELECT 'new', 'cash_sessions', count(*)::text FROM "CashSession" WHERE "createdAt" >= :'boundary'
UNION ALL SELECT 'new', 'journal_entries', count(*)::text FROM "JournalEntry" WHERE "createdAt" >= :'boundary'
UNION ALL SELECT 'new', 'inventory_movements', count(*)::text FROM "InventoryLedger" WHERE "createdAt" >= :'boundary'

-- ---------------- invariants (non-zero = finding) ----------------
UNION ALL SELECT 'check', 'posted_debit_minus_credit', (coalesce(sum(l."baseDebit"), 0) - coalesce(sum(l."baseCredit"), 0))::text
            FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."journalEntryId" WHERE e.status::text = 'posted'
UNION ALL SELECT 'check', 'unbalanced_entries', count(*)::text FROM (
            SELECT e.id FROM "JournalEntry" e JOIN "JournalLine" l ON l."journalEntryId" = e.id
             WHERE e.status::text = 'posted' GROUP BY e.id HAVING sum(l."baseDebit") <> sum(l."baseCredit")) u
UNION ALL SELECT 'check', 'duplicate_invoice_numbers', (count(*) - count(DISTINCT ("organizationId", "invoiceNumber")))::text FROM "Invoice"
UNION ALL SELECT 'check', 'duplicate_receipt_numbers', (count(*) - count(DISTINCT ("organizationId", "receiptNumber")))::text FROM "Receipt"
UNION ALL SELECT 'check', 'new_invoice_number_gaps', coalesce(max(n) - min(n) + 1 - count(*), 0)::text FROM (
            SELECT substring("invoiceNumber" FROM '(\d+)$')::bigint n FROM "Invoice"
             WHERE "createdAt" >= :'boundary' AND "invoiceNumber" ~ '^INV-\d{4}-\d+$') g
UNION ALL SELECT 'check', 'new_paid_invoices_without_receipt', count(*)::text FROM "Invoice" i
             WHERE i."createdAt" >= :'boundary' AND i."paymentStatus"::text = 'paid'
               AND NOT EXISTS (SELECT 1 FROM "Receipt" r WHERE r."invoiceId" = i.id)
UNION ALL SELECT 'check', 'new_posted_invoices_without_journal', count(*)::text FROM "Invoice"
             WHERE "createdAt" >= :'boundary' AND status::text IN ('posted', 'paid') AND "journalEntryId" IS NULL
UNION ALL SELECT 'check', 'shifts_open_over_18h', count(*)::text FROM "CashSession"
             WHERE status::text = 'open' AND "openedAt" < (now() AT TIME ZONE 'UTC') - interval '18 hours'
UNION ALL SELECT 'check', 'new_shifts_closed_not_reconciled', count(*)::text FROM "CashSession"
             WHERE "createdAt" >= :'boundary' AND status::text = 'closed' AND "closedAt" < (now() AT TIME ZONE 'UTC') - interval '24 hours'
UNION ALL SELECT 'check', 'stock_posting_jobs_not_done', count(*)::text FROM "StockPostingJob" WHERE status IN ('pending', 'processing', 'failed')
UNION ALL SELECT 'check', 'sync_dead_letters_open', count(*)::text FROM "SyncOpDeadLetter" WHERE status = 'open'

-- ---------------- legacy conditions (must not grow) ----------------
UNION ALL SELECT 'watch', 'negative_stock_items', count(*)::text FROM "StockItem" WHERE quantity < 0
UNION ALL SELECT 'watch', 'onhand_vs_ledger_drift', count(*)::text FROM (
            SELECT s.id FROM "StockItem" s
              LEFT JOIN (SELECT "productId", "locationId", sum("quantityChange") q FROM "InventoryLedger" GROUP BY 1, 2) l
                ON l."productId" = s."productId" AND l."locationId" = s."locationId"
             WHERE s."variantId" IS NULL AND s.quantity <> coalesce(l.q, 0)) d
UNION ALL SELECT 'watch', 'legacy_shifts_not_reconciled', count(*)::text FROM "CashSession"
             WHERE "createdAt" < :'boundary' AND status::text = 'closed'
;
