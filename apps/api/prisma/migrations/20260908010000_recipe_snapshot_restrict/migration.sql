-- Stage 1 cascade fix: InvoiceItemRecipeIngredient is a historical COGS
-- record and must never be cascade-deleted with an invoice line. Flip the
-- FK from ON DELETE CASCADE to ON DELETE RESTRICT.

-- DropForeignKey
ALTER TABLE "InvoiceItemRecipeIngredient" DROP CONSTRAINT "InvoiceItemRecipeIngredient_invoiceItemId_fkey";

-- AddForeignKey
ALTER TABLE "InvoiceItemRecipeIngredient" ADD CONSTRAINT "InvoiceItemRecipeIngredient_invoiceItemId_fkey" FOREIGN KEY ("invoiceItemId") REFERENCES "InvoiceItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
