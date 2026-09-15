-- Inventory production-readiness audit #3 (2026-09-14):
--   INV-P1-04  transport-safe branch transfers (dispatch → in-transit → receipt)
--   INV-P2-02  landed-cost allocation onto goods receipts
--   INV-P2-03  cycle / spot / blind / scoped count sessions
-- Additive only. Existing immediate transfers keep mode = 'immediate'.

-- AlterEnum
ALTER TYPE "LocationType" ADD VALUE 'transit';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockDocStatus" ADD VALUE 'in_transit';
ALTER TYPE "StockDocStatus" ADD VALUE 'partially_received';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InventoryCountType" ADD VALUE 'cycle';
ALTER TYPE "InventoryCountType" ADD VALUE 'spot';

-- AlterTable
ALTER TABLE "StockTransfer" ADD COLUMN     "dispatchedAt" TIMESTAMP(3),
ADD COLUMN     "dispatchedById" TEXT,
ADD COLUMN     "lastReceivedAt" TIMESTAMP(3),
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'immediate',
ADD COLUMN     "transitLocId" TEXT;

-- AlterTable
ALTER TABLE "StockTransferItem" ADD COLUMN     "qtyDamaged" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN     "qtyDispatched" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN     "qtyRecalled" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN     "qtyReceived" DECIMAL(20,6) NOT NULL DEFAULT 0,
ADD COLUMN     "qtyShort" DECIMAL(20,6) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "InventoryCountSession" ADD COLUMN     "blind" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scopeCategoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "scopeProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "StockTransferReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "receiptCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'receipt',
    "receivedById" TEXT,
    "notes" TEXT,
    "lines" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransferReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandedCost" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "goodsReceiptId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "allocationMethod" TEXT NOT NULL DEFAULT 'value',
    "creditAccountId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "totalAmount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "capitalizedAmount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "expensedAmount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "journalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "LandedCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandedCostCharge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "landedCostId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(20,6) NOT NULL,

    CONSTRAINT "LandedCostCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandedCostAllocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "landedCostId" TEXT NOT NULL,
    "goodsReceiptLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "batchId" TEXT,
    "receivedQty" DECIMAL(20,6) NOT NULL,
    "onHandQty" DECIMAL(20,6) NOT NULL,
    "basisValue" DECIMAL(20,6) NOT NULL,
    "allocatedAmount" DECIMAL(20,6) NOT NULL,
    "capitalizedAmount" DECIMAL(20,6) NOT NULL,
    "expensedAmount" DECIMAL(20,6) NOT NULL,
    "unitCostBefore" DECIMAL(20,6) NOT NULL,
    "unitCostAfter" DECIMAL(20,6) NOT NULL,

    CONSTRAINT "LandedCostAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockTransferReceipt_organizationId_transferId_idx" ON "StockTransferReceipt"("organizationId", "transferId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransferReceipt_organizationId_receiptCode_key" ON "StockTransferReceipt"("organizationId", "receiptCode");

-- CreateIndex
CREATE INDEX "LandedCost_organizationId_goodsReceiptId_idx" ON "LandedCost"("organizationId", "goodsReceiptId");

-- CreateIndex
CREATE INDEX "LandedCost_organizationId_status_idx" ON "LandedCost"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LandedCost_organizationId_code_key" ON "LandedCost"("organizationId", "code");

-- CreateIndex
CREATE INDEX "LandedCostCharge_organizationId_landedCostId_idx" ON "LandedCostCharge"("organizationId", "landedCostId");

-- CreateIndex
CREATE INDEX "LandedCostAllocation_organizationId_landedCostId_idx" ON "LandedCostAllocation"("organizationId", "landedCostId");

-- CreateIndex
CREATE INDEX "LandedCostAllocation_organizationId_productId_idx" ON "LandedCostAllocation"("organizationId", "productId");

-- AddForeignKey
ALTER TABLE "StockTransferReceipt" ADD CONSTRAINT "StockTransferReceipt_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostCharge" ADD CONSTRAINT "LandedCostCharge_landedCostId_fkey" FOREIGN KEY ("landedCostId") REFERENCES "LandedCost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandedCostAllocation" ADD CONSTRAINT "LandedCostAllocation_landedCostId_fkey" FOREIGN KEY ("landedCostId") REFERENCES "LandedCost"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Posted transit quantities can never exceed what was dispatched.
ALTER TABLE "StockTransferItem"
  ADD CONSTRAINT "StockTransferItem_transit_accounted_chk"
  CHECK ("qtyReceived" + "qtyDamaged" + "qtyShort" + "qtyRecalled" <= "qtyDispatched" + 0.000001);

ALTER TABLE "StockTransfer"
  ADD CONSTRAINT "StockTransfer_mode_chk" CHECK ("mode" IN ('immediate', 'transit'));

ALTER TABLE "LandedCost"
  ADD CONSTRAINT "LandedCost_status_chk" CHECK ("status" IN ('draft', 'posted', 'cancelled')),
  ADD CONSTRAINT "LandedCost_method_chk" CHECK ("allocationMethod" IN ('value', 'quantity', 'equal'));

ALTER TABLE "LandedCostCharge"
  ADD CONSTRAINT "LandedCostCharge_amount_chk" CHECK ("amount" > 0);

-- Tenant-isolation RLS on the new org-scoped tables (same shape as every other
-- org table: ENABLE + NO FORCE, USING-only; see 20260731093000).
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'StockTransferReceipt',
        'LandedCost',
        'LandedCostCharge',
        'LandedCostAllocation'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
             USING ("organizationId" = current_setting(''app.org_id'', true))',
            t
        );
    END LOOP;
END $$;
