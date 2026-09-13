ALTER TABLE "CashMovement" ADD COLUMN IF NOT EXISTS "reversalOfMovementId" TEXT;
CREATE INDEX IF NOT EXISTS "CashMovement_reversalOfMovementId_idx" ON "CashMovement"("reversalOfMovementId");
