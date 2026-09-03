-- F14: portion / option stock semantics.
-- Variant recipe multiplier (price and portion are now independent).
ALTER TABLE "MenuItemVariant" ADD COLUMN "qtyMultiplier" DECIMAL(12,6);

-- Per-option stock consumption: "extra milk" = 30 ml, not 1 whole unit.
ALTER TABLE "Modifier"
  ADD COLUMN "consumptionQty" DECIMAL(20,6) NOT NULL DEFAULT 1,
  ADD COLUMN "consumptionUomId" TEXT;

ALTER TABLE "AccompanimentOption"
  ADD COLUMN "consumptionQty" DECIMAL(20,6) NOT NULL DEFAULT 1,
  ADD COLUMN "consumptionUomId" TEXT;
