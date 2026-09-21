-- =====================================================================
-- EXPECTED NEXT DOCUMENT NUMBERS - read-only.
--
-- The production rule (not a fixed number from an old rehearsal):
--
--     expected next = maximum valid number in the FINAL backup + 1
--
-- Run it on the restored FINAL backup (cafe_final_ref_*), again on the
-- migrated database before go-live, and prove the first real invoice/receipt
-- carries exactly this number.
--
--   psql -X -A -F '|' -d <db> -f next-numbers.sql
--
-- status column:
--   OK          sequence last_value == max used number  -> next = expected_next
--   GAP         sequence is ahead (a rolled-back write reserved a number). The
--               first document will be sequence_next, not expected_next. Not a
--               defect, but it must be written down BEFORE go-live.
--   BLOCKER     sequence is behind the documents -> the new system would issue
--               a DUPLICATE number. Stop.
--   MISSING     no native sequence: the new system would create it at 1 ->
--               duplicates. Stop.
-- =====================================================================
SET default_transaction_read_only = on;

WITH org AS (
  SELECT id, code, substring(replace(id::text, '-', '') FROM 1 FOR 8) AS short
    FROM "Organization"
),
docs AS (
  SELECT i."organizationId" AS org_id, 'invoice' AS kind,
         substring(i."invoiceNumber" FROM '^(INV-\d{4}-)') AS prefix,
         substring(i."invoiceNumber" FROM '(\d+)$')::bigint AS n, 6 AS pad,
         'invoice_' || substring(i."invoiceNumber" FROM '^INV-(\d{4})-') AS seq_key
    FROM "Invoice" i WHERE i."invoiceNumber" ~ '^INV-\d{4}-\d+$'
  UNION ALL
  SELECT r."organizationId", 'receipt', 'RCT-',
         substring(r."receiptNumber" FROM '(\d+)$')::bigint, 6, 'receipt'
    FROM "Receipt" r WHERE r."receiptNumber" ~ '^RCT-\d+$'
  UNION ALL
  SELECT p."organizationId", 'payment',
         substring(p."paymentNumber" FROM '^(PAY-\d{4}-)'),
         substring(p."paymentNumber" FROM '(\d+)$')::bigint, 6,
         'payment_' || substring(p."paymentNumber" FROM '^PAY-(\d{4})-')
    FROM "Payment" p WHERE p."paymentNumber" ~ '^PAY-\d{4}-\d+$'
  UNION ALL
  SELECT e."organizationId", 'journal:' || split_part(e."entryNumber", '/', 1),
         substring(e."entryNumber" FROM '^([A-Z]+/\d{4}/)'),
         substring(e."entryNumber" FROM '(\d+)$')::bigint, 5,
         'journal_' || split_part(e."entryNumber", '/', 1) || '_' || split_part(e."entryNumber", '/', 2)
    FROM "JournalEntry" e WHERE e."entryNumber" ~ '^[A-Z]+/\d{4}/\d+$'
),
agg AS (
  SELECT o.code, d.kind, d.prefix, d.pad, d.seq_key, o.short,
         max(d.n) AS max_used, count(*) AS docs, count(DISTINCT d.n) AS distinct_numbers
    FROM docs d JOIN org o ON o.id = d.org_id
   GROUP BY o.code, d.kind, d.prefix, d.pad, d.seq_key, o.short
)
SELECT a.code AS organization,
       a.kind,
       a.max_used,
       a.docs,
       a.distinct_numbers,
       a.prefix || lpad((a.max_used + 1)::text, a.pad, '0') AS expected_next,
       s.last_value AS sequence_last_value,
       CASE WHEN s.sequencename IS NULL THEN NULL
            ELSE a.prefix || lpad((coalesce(s.last_value, 0) + 1)::text, a.pad, '0') END AS sequence_next,
       CASE WHEN s.sequencename IS NULL            THEN 'MISSING'
            WHEN coalesce(s.last_value, 0) < a.max_used THEN 'BLOCKER'
            WHEN s.last_value > a.max_used          THEN 'GAP'
            ELSE 'OK' END AS status,
       CASE WHEN a.docs <> a.distinct_numbers THEN 'DUPLICATE NUMBERS IN HISTORY' ELSE '' END AS history_note
  FROM agg a
  LEFT JOIN pg_sequences s
         ON s.schemaname = 'public' AND s.sequencename = 'seq_' || a.short || '_' || a.seq_key
 ORDER BY a.code, a.kind, a.prefix;
