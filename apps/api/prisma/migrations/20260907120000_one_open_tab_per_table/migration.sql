-- Audit #2 N-04 — one open dine-in tab per table, enforced by the database.
--
-- `PosOrdersService.createOrder` checked this with a bare SELECT inside a READ
-- COMMITTED transaction, so two terminals opening the same table at the same
-- moment both saw "no open tab" and both inserted. The second tab is invisible
-- to `getOpenOrderForTable` (which filters `invoiceId: null` and returns one
-- row), so its food is served and never billed, and the table stays held.
--
-- The service now takes a FOR UPDATE lock on the PosTable row, which closes the
-- race. This index is the backstop: it makes the invariant true of the data
-- rather than true of one code path.
--
-- Scope mirrors the guard exactly:
--   dine-in only            — takeaway/delivery orders carry no table
--   invoiceId IS NULL       — a billed-but-unpaid order still holds the table
--                             but no longer blocks a fresh round on it
--   status IN (held)        — matches TABLE_HELD_ORDER_STATUSES, legacy tail
--                             included, so an Android client running an old APK
--                             cannot slip a second tab past it
--   sourceDocumentType NULL — a tab the FLOOR opened. Split-bill settlement
--                             raises a second dine-in order on an occupied table
--                             (PosSplitService.settleBill -> createOrderFromResolved)
--                             and invoices it inside the same transaction; that
--                             is a bill-carrier, not a tab, and is marked
--                             'pos_split_bill'. Rental/repair orders are excluded
--                             for the same reason: the invariant is about tabs.

-- Refuse to install over existing corruption. If this raises, resolve the
-- duplicate tabs first (settle or cancel the stragglers) and re-run; creating
-- the index while quietly ignoring them would hide real unbilled orders.
DO $$
DECLARE
  dupes int;
  detail text;
BEGIN
  SELECT count(*), coalesce(string_agg(t, '; '), '')
    INTO dupes, detail
  FROM (
    SELECT "organizationId" || ' table=' || "tableId" || ' tabs=' || count(*)::text AS t
    FROM "Order"
    WHERE "orderType" = 'dine_in'
      AND "tableId" IS NOT NULL
      AND "invoiceId" IS NULL
      AND "sourceDocumentType" IS NULL
      AND "status" IN ('draft','confirmed','in_progress','completed','open','preparing','ready','served')
    GROUP BY "organizationId", "tableId"
    HAVING count(*) > 1
  ) d;

  IF dupes > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce one-open-tab-per-table: % table(s) already carry more than one open dine-in tab. Settle or cancel the extra tabs, then re-run this migration. Offenders: %',
      dupes, detail;
  END IF;
END $$;

CREATE UNIQUE INDEX "Order_one_open_dine_in_tab_per_table"
  ON "Order" ("organizationId", "tableId")
  WHERE "orderType" = 'dine_in'
    AND "tableId" IS NOT NULL
    AND "invoiceId" IS NULL
    AND "sourceDocumentType" IS NULL
    AND "status" IN ('draft','confirmed','in_progress','completed','open','preparing','ready','served');
