-- Track the cumulative quantity already shown on bills for each live POS order
-- line. This makes additional bills server-enforced deltas instead of full
-- order snapshots.
ALTER TABLE "OrderItem"
  ADD COLUMN "billPrintedQty" DECIMAL(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN "billLastPrintedAt" TIMESTAMP(3),
  ADD COLUMN "lastBillPrintedById" TEXT;

-- Existing orders whose bill was already printed must start fully checkpointed;
-- otherwise their next "additional" bill would repeat every historical line.
UPDATE "OrderItem" oi
SET
  "billPrintedQty" = oi."quantity",
  "billLastPrintedAt" = o."billLastPrintedAt"
FROM "Order" o
WHERE oi."orderId" = o."id"
  AND o."billPrintCount" > 0;
