-- Paper KOT tracking, separate from KDS dispatch (kitchenPrintedQty).
ALTER TABLE "OrderItem" ADD COLUMN "kotPrintedQty" DECIMAL(20,6) NOT NULL DEFAULT 0;

-- Open tabs that already printed a paper KOT: treat what the kitchen was sent
-- as already on paper, so the next KOT stays additional. Tabs that never
-- printed a KOT keep 0 and their first KOT prints the whole order.
UPDATE "OrderItem" oi
SET "kotPrintedQty" = COALESCE(oi."kitchenPrintedQty", 0)
FROM "Order" o
WHERE o.id = oi."orderId" AND o."kotPrintCount" > 0;
