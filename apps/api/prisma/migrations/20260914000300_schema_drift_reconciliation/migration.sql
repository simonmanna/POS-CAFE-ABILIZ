-- Reconcile the migration history with schema.prisma so the CI drift gate
-- (prisma migrate diff --exit-code) is green. These differences predate the
-- cash-flow work; each change is metadata-only or a lossless UUID->TEXT cast.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'reopen';

-- AlterTable
ALTER TABLE "DMSWorkflowLedger" DROP CONSTRAINT "DMSWorkflowLedger_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "DMSWorkflowLedger_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "stockPolicy" SET DEFAULT 'warn';

