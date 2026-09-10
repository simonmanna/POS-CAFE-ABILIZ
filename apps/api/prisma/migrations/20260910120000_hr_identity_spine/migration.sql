-- HR identity spine: make HrEmployee.userId a real, tenant-safe foreign key.
--
-- The column has existed since 20260804013004_add_hr_workforce but was never
-- written by any code path, so there is nothing to backfill and no row can
-- violate the new constraint.
--
-- The FK is composite — (organizationId, userId) -> User(organizationId, id) —
-- rather than userId -> User(id). That makes a cross-tenant employee->user link
-- impossible at the database instead of merely validated in a service. Postgres
-- MATCH SIMPLE skips the check whenever any referenced column is NULL, so an
-- unlinked employee (userId IS NULL) stays valid.
--
-- ON DELETE RESTRICT is deliberate: Users are only ever soft-deleted here, and a
-- hard delete of a linked User should fail loudly rather than orphan an
-- employee record or silently detach a workforce identity.

-- CreateIndex
CREATE UNIQUE INDEX "User_organizationId_id_key" ON "User"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "HrEmployee_organizationId_userId_key" ON "HrEmployee"("organizationId", "userId");

-- AddForeignKey
ALTER TABLE "HrEmployee" ADD CONSTRAINT "HrEmployee_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
