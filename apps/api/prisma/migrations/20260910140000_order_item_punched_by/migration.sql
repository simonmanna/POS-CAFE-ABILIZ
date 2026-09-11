-- Per-item waiter attribution: who PUNCHED each line into the terminal.
-- Nullable + no backfill: history predating this migration genuinely does not
-- know who punched a line (only who owned the order, which stays on
-- "Order"."waiterId" / "Invoice"."waiterId"), and inventing an answer would be
-- worse than showing none. Readers fall back to the order's waiter.

ALTER TABLE "OrderItem" ADD COLUMN "punchedById" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "punchedByName" TEXT;

ALTER TABLE "InvoiceItem" ADD COLUMN "punchedById" TEXT;
ALTER TABLE "InvoiceItem" ADD COLUMN "punchedByName" TEXT;

CREATE INDEX "OrderItem_organizationId_punchedById_idx" ON "OrderItem"("organizationId", "punchedById");
CREATE INDEX "InvoiceItem_organizationId_punchedById_idx" ON "InvoiceItem"("organizationId", "punchedById");
