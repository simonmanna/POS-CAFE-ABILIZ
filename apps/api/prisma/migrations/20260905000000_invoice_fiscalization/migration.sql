-- F22: fiscalization seam. Columns hold a real fiscal device's response and a
-- queryable status. Not a compliance implementation on their own.
ALTER TABLE "Invoice"
  ADD COLUMN "fiscalStatus" TEXT,
  ADD COLUMN "fiscalCode" TEXT,
  ADD COLUMN "fiscalQr" TEXT,
  ADD COLUMN "fiscalizedAt" TIMESTAMP(3);
