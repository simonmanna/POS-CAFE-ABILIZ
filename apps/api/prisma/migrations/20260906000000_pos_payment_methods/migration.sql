-- POS payment modes → finance accounts.
--
-- Separates the payment MODE the cashier picks (Cash, MTN MoMo, Airtel Money,
-- Card, Bank) from the finance ACCOUNT the money is booked to. Before this
-- table the two were the same thing, coupled by string equality on
-- AccountCategory.key, so an org with two mobile-money wallets had no way to
-- say which tile lands in which account and the cashier was asked to pick a GL
-- account directly.
--
-- `kind` mirrors TenderMethod in treasury/tender-account.ts. The bound
-- account's category must satisfy that resolver's allowed-category map — the
-- service validates this on write so a configured tile can never produce a
-- tender the posting engine will reject.

-- CreateTable
CREATE TABLE "PosPaymentMethod" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT,
    "accountId" TEXT,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "requiresReference" BOOLEAN NOT NULL DEFAULT false,
    "trackInShift" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PosPaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosPaymentMethod_organizationId_code_key" ON "PosPaymentMethod"("organizationId", "code");

-- CreateIndex
CREATE INDEX "PosPaymentMethod_organizationId_isActive_idx" ON "PosPaymentMethod"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "PosPaymentMethod_accountId_idx" ON "PosPaymentMethod"("accountId");

-- AddForeignKey
ALTER TABLE "PosPaymentMethod" ADD CONSTRAINT "PosPaymentMethod_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation. As everywhere else in this deployment the policy is created
-- and FORCEd but RLS is deliberately NOT enabled: app.org_id is only set inside
-- interactive transactions, so enabling it here would reject the app's ordinary
-- standalone queries. Isolation is enforced by the Prisma tenancy extension
-- until an operator turns RLS on org-wide via `pnpm rls:setup-role`.
ALTER TABLE "PosPaymentMethod" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PosPaymentMethod";
CREATE POLICY tenant_isolation ON "PosPaymentMethod" USING ("organizationId" = current_setting('app.org_id', true));
