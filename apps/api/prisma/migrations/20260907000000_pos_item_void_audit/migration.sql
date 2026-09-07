-- A-016 / audit F-01: an OrderItem is never deleted again. Removing a line from
-- a cart soft-cancels the row, so the order keeps a permanent record of what was
-- ordered, who took it off, why, and which manager approved it.
--
-- `cancelled`, `cancelledAt`, `cancelReason` and `voidedBy` already exist; these
-- two columns complete the trail. Both are nullable with no default, so the
-- migration is additive and safe on a live database.

ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "voidApprovedBy" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "voidedQty" DECIMAL(20,6);

-- Every reader filters on (orderId, cancelled); soft-cancelled rows accumulate
-- on long-lived tabs, so keep that lookup index-backed.
CREATE INDEX IF NOT EXISTS "OrderItem_orderId_cancelled_idx"
  ON "OrderItem" ("orderId", "cancelled");
