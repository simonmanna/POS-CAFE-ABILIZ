-- Inventory production-readiness guards (2026-09-14 re-audit).

-- P0-1: consumption snapshots carry the authoritative BASE quantity relieved.
ALTER TABLE "InvoiceItemRecipeIngredient"
  ADD COLUMN IF NOT EXISTS "baseQuantity" DECIMAL(20,6),
  ADD COLUMN IF NOT EXISTS "baseUomId" TEXT;

-- Legacy rows could store the sales/recipe-unit quantity next to a per-BASE
-- unit cost (and were only written when totalValue > 0). totalValue / unitCost
-- is therefore the base quantity that actually left stock.
UPDATE "InvoiceItemRecipeIngredient"
   SET "baseQuantity" = ROUND("totalValue" / "unitCost", 6)
 WHERE "baseQuantity" IS NULL AND "unitCost" > 0;

-- P0-2: posted supplier payments on a credit PO can never exceed its total,
-- whatever code path inserts them. Serialised on the PO row.
CREATE OR REPLACE FUNCTION purchase_payment_not_over_po() RETURNS trigger AS $$
DECLARE
  po_total DECIMAL(20,6);
  paid DECIMAL(20,6);
BEGIN
  SELECT "totalAmount" INTO po_total FROM "PurchaseOrder"
   WHERE id = NEW."purchaseOrderId" AND "paymentType" = 'credit' FOR UPDATE;
  -- Cash purchases auto-settle what each receipt vouchered (which may round or
  -- over-receive); only manually paid credit POs are capped here.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO paid FROM "PurchasePayment"
   WHERE "purchaseOrderId" = NEW."purchaseOrderId";
  IF paid > po_total + 0.000001 THEN
    RAISE EXCEPTION 'PurchasePayment total % exceeds purchase order total %', paid, po_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS purchase_payment_not_over_po ON "PurchasePayment";
CREATE CONSTRAINT TRIGGER purchase_payment_not_over_po
  AFTER INSERT OR UPDATE OF amount, "purchaseOrderId" ON "PurchasePayment"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION purchase_payment_not_over_po();
