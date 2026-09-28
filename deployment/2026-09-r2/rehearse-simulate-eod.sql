-- REHEARSAL ONLY: simulated end of day on the legacy stand-in, so the
-- cutover freeze gate (open state = 0) can be exercised from a mid-trade
-- backup. In production staff do this in the OLD POS (D3); never SQL.
--
--   psql -v ON_ERROR_STOP=1 -d cafe_rollback_test_r1 -f rehearse-simulate-eod.sql
--
-- Refuses any database other than the approved writable stand-in. Serves
-- KDS tickets only; an open shift, open order or parked cart stops the script,
-- because closing those needs the old application's own workflow.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cafe_rollback_test_r1' THEN
    RAISE EXCEPTION 'STOP: % is not the rehearsal legacy stand-in (cafe_rollback_test_r1)', current_database();
  END IF;
  IF current_setting('default_transaction_read_only') = 'on' THEN
    RAISE EXCEPTION 'STOP: % is read-only (already frozen)', current_database();
  END IF;
END $$;

BEGIN;

DO $$
DECLARE shifts int; orders int; holds int;
BEGIN
  SELECT count(*) INTO shifts FROM "CashSession" WHERE status::text = 'open';
  SELECT count(*) INTO orders FROM "Order" WHERE "invoiceId" IS NULL AND status::text NOT IN ('closed', 'cancelled');
  SELECT count(*) INTO holds  FROM "PosHold";
  IF shifts + orders + holds > 0 THEN
    RAISE EXCEPTION 'open shifts=%, open orders=%, parked carts=% - close them in the OLD POS, not by SQL', shifts, orders, holds;
  END IF;
END $$;

UPDATE "KitchenTicket"
   SET status = 'served',
       "servedAt" = coalesce("servedAt", "updatedAt"),
       "updatedAt" = now() AT TIME ZONE 'UTC'
 WHERE status::text = 'new';

SELECT 'kds_tickets_new' AS item, count(*) AS remaining FROM "KitchenTicket" WHERE status::text = 'new';

COMMIT;
