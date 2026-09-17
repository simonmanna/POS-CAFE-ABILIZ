-- Trading date: the business day a shift and its sales belong to (06:00 local cutoff).
ALTER TABLE "CashSession" ADD COLUMN "businessDate" DATE;
ALTER TABLE "Invoice" ADD COLUMN "businessDate" DATE;
CREATE INDEX "Invoice_organizationId_businessDate_idx" ON "Invoice"("organizationId", "businessDate");
