-- Inventory production-readiness remediation (2026-09-14 audit), phases 2 + 3.
--
-- 1. Posted reversals for stock documents and goods receipts: reversal audit
--    columns, a `reversed` status, and reversal move types for the inverse
--    ledger rows.
-- 2. The stock ledger becomes database-enforced evidence:
--      - append-only (UPDATE/DELETE refused; corrections are new linked rows).
--        The only bypasses are the transaction-local purge flag already used for
--        cash evidence (SET LOCAL app.evidence_purge = 'on') and the FK
--        SET NULL of batchId/serialId when a lot/serial row is removed;
--      - per-row arithmetic: balanceAfter = qtyBefore + quantityChange. Added
--        NOT VALID so historical rows are not re-checked on deploy; every new
--        row is enforced;
--      - value/quantity sanity: totalValue and unitCost are never negative.
-- 3. Indexes for stock-card reads at scale and the inventory-to-GL tie-out.

-- ── 1. Reversals ─────────────────────────────────────────────────────────────
ALTER TYPE "StockMoveType" ADD VALUE IF NOT EXISTS 'reversal_in';
ALTER TYPE "StockMoveType" ADD VALUE IF NOT EXISTS 'reversal_out';
ALTER TYPE "StockDocStatus" ADD VALUE IF NOT EXISTS 'reversed';
ALTER TYPE "GoodsReceiptStatus" ADD VALUE IF NOT EXISTS 'reversed';

ALTER TABLE "StockOut"
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversedById" TEXT,
  ADD COLUMN "reversalReason" TEXT;
ALTER TABLE "WasteRecord"
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversedById" TEXT,
  ADD COLUMN "reversalReason" TEXT;
ALTER TABLE "StockAdjustment"
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversedById" TEXT,
  ADD COLUMN "reversalReason" TEXT;
ALTER TABLE "StockTransfer"
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversedById" TEXT,
  ADD COLUMN "reversalReason" TEXT;
ALTER TABLE "GoodsReceiptNote"
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversedById" TEXT,
  ADD COLUMN "reversalReason" TEXT;

-- ── 2. Ledger guards ─────────────────────────────────────────────────────────
-- Helpers were introduced by 20260913100000_cash_flow_evidence_integrity; they
-- are re-declared (idempotently) so this migration also stands on its own.
CREATE OR REPLACE FUNCTION evidence_purge_enabled() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.evidence_purge', true), '') = 'on'
$$;

CREATE OR REPLACE FUNCTION evidence_row_changed(old_row jsonb, new_row jsonb, allowed text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (old_row - allowed) IS DISTINCT FROM (new_row - allowed)
$$;

CREATE OR REPLACE FUNCTION guard_inventory_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF evidence_purge_enabled() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE'
     AND NOT evidence_row_changed(to_jsonb(OLD), to_jsonb(NEW), ARRAY['batchId', 'serialId'])
     AND (NEW."batchId" IS NULL OR NEW."batchId" IS NOT DISTINCT FROM OLD."batchId")
     AND (NEW."serialId" IS NULL OR NEW."serialId" IS NOT DISTINCT FROM OLD."serialId") THEN
    -- Only a lot/serial reference being cleared by its FK (ON DELETE SET NULL).
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'InventoryLedger % is posted stock evidence and cannot be %; post a reversal or adjustment instead',
    OLD.id, lower(TG_OP) USING ERRCODE = 'integrity_constraint_violation';
END $$;

DROP TRIGGER IF EXISTS inventory_ledger_append_only ON "InventoryLedger";
CREATE TRIGGER inventory_ledger_append_only
  BEFORE UPDATE OR DELETE ON "InventoryLedger"
  FOR EACH ROW EXECUTE FUNCTION guard_inventory_ledger();

ALTER TABLE "InventoryLedger"
  ADD CONSTRAINT "InventoryLedger_balance_arithmetic_check"
  CHECK ("balanceAfter" = "qtyBefore" + "quantityChange") NOT VALID;
ALTER TABLE "InventoryLedger"
  ADD CONSTRAINT "InventoryLedger_non_negative_value_check"
  CHECK ("totalValue" >= 0 AND "unitCost" >= 0) NOT VALID;

-- ── 3. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "InventoryLedger_organizationId_productId_locationId_createdAt_idx"
  ON "InventoryLedger"("organizationId", "productId", "locationId", "createdAt");
CREATE INDEX IF NOT EXISTS "InventoryLedger_organizationId_referenceType_referenceId_idx"
  ON "InventoryLedger"("organizationId", "referenceType", "referenceId");
CREATE INDEX IF NOT EXISTS "JournalEntry_organizationId_sourceId_idx"
  ON "JournalEntry"("organizationId", "sourceId");
