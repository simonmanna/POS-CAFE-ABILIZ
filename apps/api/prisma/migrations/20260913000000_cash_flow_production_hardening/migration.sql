-- Cash-flow production hardening.
-- Fail loudly if existing data violates an invariant; the release preflight
-- must be used to repair legacy rows before this migration is deployed.

ALTER TABLE "PosRefund" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PosApprovalGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenderSettlement" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "CashSession"
  ADD COLUMN "drawerAccountId" TEXT,
  ADD COLUMN "registerLocationId" TEXT;

UPDATE "CashSession" s
SET "drawerAccountId" = r."defaultAccountId",
    "registerLocationId" = r."locationId"
FROM "CashRegister" r
WHERE r.id = s."cashRegisterId";

CREATE INDEX "CashSession_drawerAccountId_idx" ON "CashSession"("drawerAccountId");

CREATE UNIQUE INDEX "CashSession_one_open_per_register_key"
  ON "CashSession"("organizationId", "cashRegisterId")
  WHERE status = 'open';

CREATE UNIQUE INDEX "CashMovement_paymentId_key"
  ON "CashMovement"("paymentId")
  WHERE "paymentId" IS NOT NULL;

ALTER TABLE "CashMovement"
  ADD CONSTRAINT "CashMovement_amount_direction_check"
    CHECK (
      ("movementType" IN ('sale', 'refund', 'pay_in', 'pay_out') AND amount > 0)
      OR ("movementType" = 'adjustment' AND amount <> 0)
    ),
  ADD CONSTRAINT "CashMovement_payment_link_check"
    CHECK (
      ("movementType" IN ('sale', 'refund') AND "paymentId" IS NOT NULL)
      OR ("movementType" IN ('pay_in', 'pay_out', 'adjustment') AND "paymentId" IS NULL)
    );

CREATE UNIQUE INDEX "Account_one_default_per_category_key"
  ON "Account"("organizationId", "categoryId")
  WHERE "isDefault" = true AND "deletedAt" IS NULL;
