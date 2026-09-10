-- HR Phases 2-6: employee lifecycle, transfers, documents and training.
--
-- All additive. Existing HrEmployee rows get employmentStatus = ACTIVE by
-- column default, then the backfill below reconciles the ones that were already
-- deactivated so the new lifecycle field agrees with the old `isActive` flag
-- from the very first deploy rather than drifting from it.
--
-- Deliberately NOT included: three statements the schema/migration diff also
-- reports (AuditAction.reopen, the DMSWorkflowLedger primary-key type, and
-- Product.stockPolicy's default). Those are pre-existing drift on main and are
-- not this change's to make.

-- CreateEnum
CREATE TYPE "HrEmploymentStatus" AS ENUM ('ACTIVE', 'PROBATION', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED', 'RESIGNED');

-- CreateEnum
CREATE TYPE "HrDocumentType" AS ENUM ('CONTRACT', 'OFFER_LETTER', 'ID_DOCUMENT', 'CERTIFICATE', 'WORK_PERMIT', 'TRAINING_CERTIFICATE', 'DISCIPLINARY', 'OTHER');

-- CreateEnum
CREATE TYPE "HrTrainingStatus" AS ENUM ('ENROLLED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "HrEmployee" ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "emergencyContactName" TEXT,
ADD COLUMN     "emergencyContactPhone" TEXT,
ADD COLUMN     "emergencyContactRelation" TEXT,
ADD COLUMN     "employmentStatus" "HrEmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "middleName" TEXT,
ADD COLUMN     "nationality" TEXT,
ADD COLUMN     "preferredName" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspensionReason" TEXT,
ADD COLUMN     "terminationDate" TIMESTAMP(3),
ADD COLUMN     "terminationReason" TEXT;

-- CreateTable
CREATE TABLE "HrEmployeeStatusHistory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fromStatus" "HrEmploymentStatus",
    "toStatus" "HrEmploymentStatus" NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "accountDisabled" BOOLEAN NOT NULL DEFAULT false,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrEmployeeStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrEmployeeTransfer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fromBranchId" TEXT,
    "toBranchId" TEXT,
    "fromDepartmentId" TEXT,
    "toDepartmentId" TEXT,
    "fromPositionId" TEXT,
    "toPositionId" TEXT,
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrEmployeeTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrEmployeeDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "documentType" "HrDocumentType" NOT NULL DEFAULT 'OTHER',
    "title" TEXT NOT NULL,
    "fileId" TEXT,
    "documentNumber" TEXT,
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "HrEmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrTrainingProgram" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "provider" TEXT,
    "durationHours" DECIMAL(10,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "HrTrainingProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrEmployeeTraining" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "status" "HrTrainingStatus" NOT NULL DEFAULT 'ENROLLED',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "score" DECIMAL(10,2),
    "certificateFileId" TEXT,
    "trainer" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "HrEmployeeTraining_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HrEmployeeStatusHistory_organizationId_employeeId_createdAt_idx" ON "HrEmployeeStatusHistory"("organizationId", "employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "HrEmployeeTransfer_organizationId_employeeId_effectiveDate_idx" ON "HrEmployeeTransfer"("organizationId", "employeeId", "effectiveDate");

-- CreateIndex
CREATE INDEX "HrEmployeeDocument_organizationId_employeeId_deletedAt_idx" ON "HrEmployeeDocument"("organizationId", "employeeId", "deletedAt");

-- CreateIndex
CREATE INDEX "HrEmployeeDocument_organizationId_expiresAt_idx" ON "HrEmployeeDocument"("organizationId", "expiresAt");

-- CreateIndex
CREATE INDEX "HrTrainingProgram_organizationId_deletedAt_idx" ON "HrTrainingProgram"("organizationId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HrTrainingProgram_organizationId_code_key" ON "HrTrainingProgram"("organizationId", "code");

-- CreateIndex
CREATE INDEX "HrEmployeeTraining_organizationId_employeeId_deletedAt_idx" ON "HrEmployeeTraining"("organizationId", "employeeId", "deletedAt");

-- CreateIndex
CREATE INDEX "HrEmployeeTraining_organizationId_programId_status_idx" ON "HrEmployeeTraining"("organizationId", "programId", "status");

-- CreateIndex
CREATE INDEX "HrEmployee_organizationId_branchId_idx" ON "HrEmployee"("organizationId", "branchId");

-- CreateIndex
CREATE INDEX "HrEmployee_organizationId_employmentStatus_idx" ON "HrEmployee"("organizationId", "employmentStatus");

-- AddForeignKey
ALTER TABLE "HrEmployee" ADD CONSTRAINT "HrEmployee_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrEmployeeStatusHistory" ADD CONSTRAINT "HrEmployeeStatusHistory_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrEmployeeTransfer" ADD CONSTRAINT "HrEmployeeTransfer_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrEmployeeDocument" ADD CONSTRAINT "HrEmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrEmployeeTraining" ADD CONSTRAINT "HrEmployeeTraining_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "HrEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrEmployeeTraining" ADD CONSTRAINT "HrEmployeeTraining_programId_fkey" FOREIGN KEY ("programId") REFERENCES "HrTrainingProgram"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reconcile the new lifecycle field with the pre-existing isActive flag.
-- Idempotent: re-running changes nothing, because the WHERE no longer matches.
UPDATE "HrEmployee"
SET "employmentStatus" = 'TERMINATED'
WHERE "isActive" = false
  AND "deletedAt" IS NULL
  AND "employmentStatus" = 'ACTIVE';

-- Seed the append-only status ledger so every employee has an origin entry and
-- the 360 timeline is never empty for pre-existing staff.
INSERT INTO "HrEmployeeStatusHistory" ("id", "organizationId", "employeeId", "fromStatus", "toStatus", "effectiveDate", "reason", "accountDisabled", "createdAt")
SELECT gen_random_uuid(), e."organizationId", e."id", NULL, e."employmentStatus",
       COALESCE(e."hireDate", e."createdAt"), 'Backfilled from isActive at the Phase 2 migration', false, now()
FROM "HrEmployee" e
WHERE NOT EXISTS (
  SELECT 1 FROM "HrEmployeeStatusHistory" h WHERE h."employeeId" = e."id"
);

-- Row-level security for the new tables, matching every other org-scoped table
-- in this database exactly: ENABLE, a `tenant_isolation` policy, and NO FORCE.
--
-- The NO FORCE part is load-bearing, not an oversight. The application role
-- owns these tables, and Postgres exempts a table's owner from RLS unless FORCE
-- is set. Since `app.org_id` is only ever set inside an interactive transaction
-- (see PrismaService), FORCE here would make every non-transactional read
-- return zero rows — the table would look empty to the app rather than
-- protected. Tenant isolation is carried by the Prisma tenancy extension; these
-- policies are the second layer that starts biting when the app moves to a
-- non-owner role.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'HrEmployeeStatusHistory',
        'HrEmployeeTransfer',
        'HrEmployeeDocument',
        'HrTrainingProgram',
        'HrEmployeeTraining'
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
