-- Add "Responsible Person" + "Approved By" (staff) to the inventory stock
-- documents (Stock Out / Waste / Stock Adjustment / Stock Transfer) and to the
-- InventoryLedger rows written by Direct Stock In / Out.
--
-- The document headers already carry `approvedById` (set by the approval flow);
-- `responsibleById` is new. Direct Stock In/Out have no document header, so both
-- fields are added to InventoryLedger and populated when those dialogs post.
--
-- All columns are nullable at the DB layer: the API DTOs enforce them as required
-- for the five operations, while engine-generated movements (POS sales,
-- production, GRN…) legitimately have neither.

ALTER TABLE "StockOut"        ADD COLUMN "responsibleById" TEXT;
ALTER TABLE "WasteRecord"     ADD COLUMN "responsibleById" TEXT;
ALTER TABLE "StockAdjustment" ADD COLUMN "responsibleById" TEXT;
ALTER TABLE "StockTransfer"   ADD COLUMN "responsibleById" TEXT;
ALTER TABLE "InventoryLedger" ADD COLUMN "responsibleById" TEXT;
ALTER TABLE "InventoryLedger" ADD COLUMN "approvedById"    TEXT;