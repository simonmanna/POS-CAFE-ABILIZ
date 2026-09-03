ALTER TABLE "Payment" ADD COLUMN "cashSessionId" TEXT, ADD COLUMN "refundOfId" TEXT,
  ADD COLUMN "refundedAmount" DECIMAL(20,6) NOT NULL DEFAULT 0;
CREATE INDEX "Payment_organizationId_cashSessionId_idx" ON "Payment"("organizationId", "cashSessionId");
CREATE INDEX "Payment_refundOfId_idx" ON "Payment"("refundOfId");
ALTER TABLE "CashSession" ADD COLUMN "openingAccounts" JSONB, ADD COLUMN "closingAccounts" JSONB;
ALTER TABLE "CashMovement" ADD COLUMN "counterpartAccountId" TEXT, ADD COLUMN "journalEntryId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "receivableAccountId" TEXT;
CREATE TABLE "PosRefund" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "invoiceId" TEXT NOT NULL,
  "amount" DECIMAL(20,6) NOT NULL, "reason" TEXT NOT NULL, "stockDisposition" TEXT NOT NULL,
  "items" JSONB NOT NULL, "payments" JSONB NOT NULL, "journalEntryId" TEXT,
  "approvedById" TEXT NOT NULL, "createdBy" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PosRefund_organizationId_invoiceId_idx" ON "PosRefund"("organizationId", "invoiceId");
CREATE TABLE "TenderSettlement" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "cashSessionId" TEXT,
  "sourceAccountId" TEXT NOT NULL, "destinationAccountId" TEXT NOT NULL,
  "grossAmount" DECIMAL(20,6) NOT NULL, "feeAmount" DECIMAL(20,6) NOT NULL,
  "feeAccountId" TEXT, "reference" TEXT NOT NULL, "settledAt" TIMESTAMP(3) NOT NULL,
  "journalEntryId" TEXT NOT NULL, "createdBy" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "TenderSettlement_organizationId_sourceAccountId_reference_key" ON "TenderSettlement"("organizationId", "sourceAccountId", "reference");
CREATE INDEX "TenderSettlement_organizationId_cashSessionId_idx" ON "TenderSettlement"("organizationId", "cashSessionId");
-- Preserve legacy data: never guess or rewrite a historical posting's cash/AR account.
-- Legacy payment session links can be recovered unambiguously from drawer movements.
UPDATE "Payment" p SET "cashSessionId" = m."cashSessionId"
FROM (
  SELECT "paymentId", "organizationId", MIN("cashSessionId") AS "cashSessionId"
  FROM "CashMovement" WHERE "paymentId" IS NOT NULL
  GROUP BY "paymentId", "organizationId" HAVING COUNT(DISTINCT "cashSessionId") = 1
) m WHERE m."paymentId" = p.id AND m."organizationId" = p."organizationId";

ALTER TABLE "InvoiceItem" ADD COLUMN "taxAccountId" TEXT;

CREATE TABLE "PosApprovalGrant" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL,
 "cashierId" TEXT NOT NULL, "managerId" TEXT NOT NULL, "operationKey" TEXT NOT NULL,
 "endpoint" TEXT NOT NULL, "payloadHash" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PosApprovalGrant_tokenHash_key" ON "PosApprovalGrant"("tokenHash");
CREATE INDEX "PosApprovalGrant_organizationId_operationKey_idx" ON "PosApprovalGrant"("organizationId", "operationKey");

ALTER TABLE "Order" ADD COLUMN "clientOperationKey" TEXT;
CREATE UNIQUE INDEX "Order_organizationId_clientOperationKey_key" ON "Order"("organizationId", "clientOperationKey");

ALTER TABLE "PaymentAllocation" ADD COLUMN "refundedAmount" DECIMAL(20,6) NOT NULL DEFAULT 0;
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_refund_bounds" CHECK ("refundedAmount" >= 0 AND "refundedAmount" <= "amount");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_refund_bounds" CHECK ("refundedAmount" >= 0 AND "refundedAmount" <= "amount");

-- Match the deployment's tenant-policy posture; setup-rls-role enables RLS.
ALTER TABLE "PosRefund" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PosRefund" USING ("organizationId" = current_setting('app.org_id', true));

-- Match the deployment's tenant-policy posture; setup-rls-role enables RLS.
ALTER TABLE "PosApprovalGrant" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PosApprovalGrant" USING ("organizationId" = current_setting('app.org_id', true));

-- Match the deployment's tenant-policy posture; setup-rls-role enables RLS.
ALTER TABLE "TenderSettlement" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TenderSettlement" USING ("organizationId" = current_setting('app.org_id', true));

ALTER TABLE "PosRefund" ADD COLUMN "cashSessionId" TEXT;
CREATE INDEX "PosRefund_organizationId_cashSessionId_idx" ON "PosRefund"("organizationId", "cashSessionId");
