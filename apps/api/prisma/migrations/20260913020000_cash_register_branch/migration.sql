ALTER TABLE "CashRegister" ADD COLUMN "branchId" TEXT;
CREATE INDEX "CashRegister_organizationId_branchId_idx" ON "CashRegister"("organizationId", "branchId");

-- Populate missing shift branch snapshots once a register has been assigned.
UPDATE "CashSession" s
SET "branchId" = r."branchId"
FROM "CashRegister" r
WHERE r.id = s."cashRegisterId" AND s."branchId" IS NULL;
