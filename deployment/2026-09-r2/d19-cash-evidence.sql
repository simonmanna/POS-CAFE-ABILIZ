-- =====================================================================
-- D19 CASH EVIDENCE - read-only. Decision support, not an adjustment.
--
-- Problem: the legacy POS debited the drawer account (1100 Cash) for every
-- cash sale and never credited it when cash left the drawer, so the ledger
-- (101,723,000 on 2026-09-17) is every cash receipt since day one. The new
-- system will not open a shift below that ledger.
--
-- What this report gives the owner: the cash that physically LEFT each drawer,
-- reconstructed from the counts the cashiers already recorded:
--
--     left after shift n = counted at close(n) - opening float of shift n+1
--                          (same register)
--
-- Each row is then matched to real evidence (bank slip, owner drawing record,
-- supplier paid in cash, safe count). Only evidenced amounts are recorded in
-- the application (bank deposit / transfer workflow) - never by SQL.
--
-- Also listed: receipts that were booked to the drawer but never were drawer
-- cash (mobile money booked to 1100), and pay-ins.
--
-- Run on the restored FINAL backup (or the live legacy DB - it only reads):
--   psql -X -A -F ',' --pset footer=off -d <db> -f d19-cash-evidence.sql > d19-evidence.csv
-- =====================================================================
SET default_transaction_read_only = on;

\echo '== A. drawer ledger per register (posted + reversed, as the new system counts it) =='
SELECT r.code AS register, a.code AS drawer_account,
       coalesce(sum(l."baseDebit"), 0)::numeric(20,2)  AS debits,
       coalesce(sum(l."baseCredit"), 0)::numeric(20,2) AS credits,
       coalesce(sum(l."baseDebit" - l."baseCredit"), 0)::numeric(20,2) AS ledger
  FROM "CashRegister" r
  JOIN "Account" a ON a.id = r."defaultAccountId"
  LEFT JOIN "JournalLine" l ON l."accountId" = a.id
       AND EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e.id = l."journalEntryId" AND e.status::text IN ('posted', 'reversed'))
 GROUP BY r.code, a.code ORDER BY 1;

\echo ''
\echo '== B. what the drawer ledger is made of (by source) =='
SELECT a.code AS drawer_account, coalesce(e."sourceType", '-') AS source, e.status::text AS status,
       count(*) AS lines,
       sum(l."baseDebit")::numeric(20,2) AS debit, sum(l."baseCredit")::numeric(20,2) AS credit
  FROM "JournalLine" l
  JOIN "JournalEntry" e ON e.id = l."journalEntryId"
  JOIN "Account" a ON a.id = l."accountId"
 WHERE a.id IN (SELECT "defaultAccountId" FROM "CashRegister")
   AND e.status::text IN ('posted', 'reversed')
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo ''
\echo '== C. receipts booked to the drawer that were never drawer cash =='
SELECT p."paymentMethod" AS method, a.code AS booked_to, count(*) AS payments,
       sum(p.amount)::numeric(20,2) AS amount, min(p."paymentDate")::date AS first, max(p."paymentDate")::date AS last
  FROM "Payment" p
  JOIN "Account" a ON a.id = p."accountId"
 WHERE p.direction::text = 'inbound' AND p."paymentMethod" <> 'cash'
   AND a.id IN (SELECT "defaultAccountId" FROM "CashRegister")
 GROUP BY 1, 2 ORDER BY 1;

\echo ''
\echo '== D. cash that left the drawer between shifts (match each row to evidence) =='
WITH s AS (
  SELECT cs.id, r.code AS register, cs."openedAt", cs."closedAt", cs.status::text AS status,
         cs."openingFloat", cs."closingExpected", cs."closingCounted", cs."closingDifference",
         coalesce(cs."bankedAmount", 0) AS banked_recorded,
         lead(cs."openingFloat") OVER (PARTITION BY cs."cashRegisterId" ORDER BY cs."openedAt") AS next_float,
         lead(cs."openedAt")     OVER (PARTITION BY cs."cashRegisterId" ORDER BY cs."openedAt") AS next_opened
    FROM "CashSession" cs JOIN "CashRegister" r ON r.id = cs."cashRegisterId"
)
SELECT register,
       "openedAt"::date AS shift_date,
       to_char("closedAt", 'YYYY-MM-DD HH24:MI') AS closed_at,
       status,
       "openingFloat"::numeric(20,2)    AS opening_float,
       "closingExpected"::numeric(20,2) AS expected,
       "closingCounted"::numeric(20,2)  AS counted,
       "closingDifference"::numeric(20,2) AS difference,
       banked_recorded::numeric(20,2)   AS banked_recorded,
       next_float::numeric(20,2)        AS next_opening_float,
       CASE WHEN "closingCounted" IS NULL THEN NULL
            ELSE ("closingCounted" - coalesce(next_float, 0))::numeric(20,2) END AS left_drawer,
       CASE WHEN next_float IS NULL AND status <> 'open' THEN 'last shift: remainder = cash still on hand or removed' ELSE '' END AS note,
       '' AS evidence_ref, '' AS destination
  FROM s
 ORDER BY register, "openedAt";

\echo ''
\echo '== E. summary per register =='
WITH s AS (
  SELECT cs."cashRegisterId", cs."openedAt", cs."closingCounted", cs.status::text AS status,
         lead(cs."openingFloat") OVER (PARTITION BY cs."cashRegisterId" ORDER BY cs."openedAt") AS next_float
    FROM "CashSession" cs
)
SELECT r.code AS register,
       count(*) FILTER (WHERE s.status <> 'open') AS closed_shifts,
       count(*) FILTER (WHERE s.status = 'open')  AS open_shifts,
       sum(s."closingCounted" - coalesce(s.next_float, 0)) FILTER (WHERE s."closingCounted" IS NOT NULL)::numeric(20,2) AS total_left_drawer,
       (SELECT "openingFloat" FROM "CashSession" x WHERE x."cashRegisterId" = r.id ORDER BY "openedAt" DESC LIMIT 1)::numeric(20,2) AS latest_opening_float
  FROM s JOIN "CashRegister" r ON r.id = s."cashRegisterId"
 GROUP BY r.id, r.code ORDER BY 1;
