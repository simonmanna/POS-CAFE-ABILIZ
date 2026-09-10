-- Bill ↔ receipt matching (purchases P0-1).
--
-- Posting a vendor bill used to call StockService.receiveFromBill for every
-- stockable line unconditionally, with no link back to the goods receipt that
-- had already brought the delivery into stock. The ordinary AP workflow
-- (PO -> goods receipt -> supplier invoice -> post bill) therefore booked the
-- same physical delivery twice: stock doubled, valuation doubled, AP doubled
-- and GRNI never cleared.
--
-- `billedQuantity` is the consumption cursor. Bill posting matches each line
-- against open (received-but-unbilled) receipt quantity for the same supplier
-- and product, marks what it consumed here, and only receives the remainder.

ALTER TABLE "GoodsReceiptLine"
  ADD COLUMN IF NOT EXISTS "billedQuantity" DECIMAL(20,6) NOT NULL DEFAULT 0;

-- Matching looks up open receipt lines by (organizationId, productId).
CREATE INDEX IF NOT EXISTS "GoodsReceiptLine_organizationId_productId_idx"
  ON "GoodsReceiptLine" ("organizationId", "productId");

-- Backfill: every receipt that existed before this migration predates matching.
-- Treat historical receipts as fully billed so the first bill posted after the
-- upgrade does not retroactively "match" against old deliveries and silently
-- skip a legitimate receive.
UPDATE "GoodsReceiptLine" SET "billedQuantity" = "quantity" WHERE "billedQuantity" = 0;

-- The audit trail for what a posted bill consumed, so cancelling a bill can
-- release the receipt quantity it claimed instead of stranding it.
CREATE TABLE IF NOT EXISTS "VendorBillReceiptMatch" (
  "id"                 TEXT NOT NULL,
  "organizationId"     TEXT NOT NULL,
  "vendorBillId"       TEXT NOT NULL,
  "documentLineId"     TEXT NOT NULL,
  "goodsReceiptLineId" TEXT NOT NULL,
  "quantity"           DECIMAL(20,6) NOT NULL,
  "vouchered"          BOOLEAN NOT NULL DEFAULT false,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VendorBillReceiptMatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VendorBillReceiptMatch_organizationId_vendorBillId_idx"
  ON "VendorBillReceiptMatch" ("organizationId", "vendorBillId");
CREATE INDEX IF NOT EXISTS "VendorBillReceiptMatch_organizationId_goodsReceiptLineId_idx"
  ON "VendorBillReceiptMatch" ("organizationId", "goodsReceiptLineId");

ALTER TABLE "VendorBillReceiptMatch"
  DROP CONSTRAINT IF EXISTS "VendorBillReceiptMatch_goodsReceiptLineId_fkey";
ALTER TABLE "VendorBillReceiptMatch"
  ADD CONSTRAINT "VendorBillReceiptMatch_goodsReceiptLineId_fkey"
  FOREIGN KEY ("goodsReceiptLineId") REFERENCES "GoodsReceiptLine"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- NOTE: RLS is deliberately NOT enabled on this table. `app.org_id` is only
-- set inside interactive transactions, so a FORCEd policy makes every
-- non-transactional read return zero rows. Tenant scoping is enforced in the
-- application layer via tenancy.extension (ORG_SCOPED), like its siblings that
-- postdate 20260731093000_rls_all_org_scoped_tables.
