-- WorkflowService.statusExtraFields writes `cancelledAt`/`cancelledBy` on every
-- `cancelled` transition, but Document never had those columns — so cancelling a
-- vendor bill, invoice, credit note or debit note threw a Prisma validation
-- error and the transition was impossible at runtime.
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "cancelledBy" TEXT;
