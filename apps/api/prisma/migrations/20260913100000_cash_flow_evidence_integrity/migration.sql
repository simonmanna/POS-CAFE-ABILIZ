-- Cash-flow go-live: database-enforced evidence integrity.
--
-- 1. The application role owns every table, so FORCE ROW LEVEL SECURITY makes
--    the tenant policy apply to the app's own non-transactional reads and
--    writes (where app.org_id is not set). Four POS tables were still FORCEd,
--    which made manager approval grants fail with 42501. Tenant isolation for
--    these tables is enforced by the Prisma tenancy extension, like every other
--    org-scoped table.
-- 2. Posted financial evidence becomes append-only at the database level.
--    Corrections are new, linked rows. The only bypass is an explicit,
--    transaction-local purge flag used by test fixtures and audited ops scripts:
--        SET LOCAL app.evidence_purge = 'on';

ALTER TABLE "PosRefund"        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "PosApprovalGrant" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "TenderSettlement" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "PosPaymentMethod" NO FORCE ROW LEVEL SECURITY;

-- ── Void evidence retained on the payment itself ─────────────────────────────
ALTER TABLE "Payment"
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "voidedById" TEXT,
  ADD COLUMN "voidReason" TEXT,
  ADD COLUMN "voidedAllocations" JSONB;

-- ── Linked corrections ────────────────────────────────────────────────────────
ALTER TABLE "CashMovement" ADD COLUMN "correctionOfSessionId" TEXT;
CREATE INDEX "CashMovement_correctionOfSessionId_idx" ON "CashMovement"("correctionOfSessionId");
ALTER TABLE "CashMovement"
  ADD CONSTRAINT "CashMovement_reversalOfMovementId_fkey"
    FOREIGN KEY ("reversalOfMovementId") REFERENCES "CashMovement"(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "CashMovement_correctionOfSessionId_fkey"
    FOREIGN KEY ("correctionOfSessionId") REFERENCES "CashSession"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE UNIQUE INDEX "CashMovement_one_reversal_per_movement_key"
  ON "CashMovement"("reversalOfMovementId") WHERE "reversalOfMovementId" IS NOT NULL;

-- A session must never cascade-delete its drawer evidence.
ALTER TABLE "CashMovement" DROP CONSTRAINT "CashMovement_cashSessionId_fkey";
ALTER TABLE "CashMovement"
  ADD CONSTRAINT "CashMovement_cashSessionId_fkey"
    FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── Guard helpers ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION evidence_purge_enabled() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.evidence_purge', true), '') = 'on'
$$;

CREATE OR REPLACE FUNCTION evidence_row_changed(old_row jsonb, new_row jsonb, allowed text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (old_row - allowed) IS DISTINCT FROM (new_row - allowed)
$$;

-- ── CashMovement: fully append-only ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION guard_cash_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF evidence_purge_enabled() THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'CashMovement % is posted drawer evidence and cannot be %; record a linked correction instead',
    OLD.id, lower(TG_OP) USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER cash_movement_append_only
  BEFORE UPDATE OR DELETE ON "CashMovement"
  FOR EACH ROW EXECUTE FUNCTION guard_cash_movement();

-- ── CashSession: closed/reconciled shifts are frozen ─────────────────────────
CREATE OR REPLACE FUNCTION guard_cash_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF evidence_purge_enabled() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CashSession % cannot be deleted', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'open' THEN
    IF NEW.status = 'reconciled' THEN
      RAISE EXCEPTION 'CashSession % must be closed before it is reconciled', OLD.id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- Register, drawer account, cashier, float and open time are fixed at open.
    IF evidence_row_changed(to_jsonb(OLD), to_jsonb(NEW), ARRAY['status','closedAt','closingCounted','closingExpected','closingDifference','closingDenomination','closingByMethod','closingAccounts','varianceReason','varianceStatus','approvedById','bankedAmount','bankName','deviceId','notes','updatedAt']) THEN
      RAISE EXCEPTION 'Open CashSession % identity, register, drawer or float cannot change', OLD.id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'closed' THEN
    IF NEW.status NOT IN ('closed', 'reconciled') THEN
      RAISE EXCEPTION 'Closed CashSession % cannot be reopened; post a correction in a current shift', OLD.id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF evidence_row_changed(to_jsonb(OLD), to_jsonb(NEW), ARRAY['status','varianceReason','varianceStatus','approvedById','notes','updatedAt']) THEN
      RAISE EXCEPTION 'Closed CashSession % count and totals are immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- reconciled
  IF evidence_row_changed(to_jsonb(OLD), to_jsonb(NEW), ARRAY['updatedAt']) THEN
    RAISE EXCEPTION 'Reconciled CashSession % is final', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_session_frozen_after_close
  BEFORE UPDATE OR DELETE ON "CashSession"
  FOR EACH ROW EXECUTE FUNCTION guard_cash_session();

-- ── PosReportSnapshot (Z report): write-once ─────────────────────────────────
CREATE OR REPLACE FUNCTION guard_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF evidence_purge_enabled() THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION '% % is write-once financial evidence', TG_TABLE_NAME, OLD.id USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER pos_report_snapshot_write_once
  BEFORE UPDATE OR DELETE ON "PosReportSnapshot"
  FOR EACH ROW EXECUTE FUNCTION guard_write_once();
CREATE TRIGGER tender_settlement_write_once
  BEFORE UPDATE OR DELETE ON "TenderSettlement"
  FOR EACH ROW EXECUTE FUNCTION guard_write_once();

-- ── JournalEntry / JournalLine: posted entries are immutable ─────────────────
CREATE OR REPLACE FUNCTION guard_journal_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF evidence_purge_enabled() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF OLD.status = 'draft' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted journal entry % cannot be deleted; reverse it', OLD."entryNumber" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT (NEW.status = OLD.status OR (OLD.status = 'posted' AND NEW.status = 'reversed')) THEN
    RAISE EXCEPTION 'Journal entry % cannot move from % to %', OLD."entryNumber", OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF evidence_row_changed(to_jsonb(OLD), to_jsonb(NEW), ARRAY['status','reversedEntryId','postingKey','updatedAt']) THEN
    RAISE EXCEPTION 'Posted journal entry % is immutable; reverse it', OLD."entryNumber" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entry_immutable_after_post
  BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION guard_journal_entry();

CREATE OR REPLACE FUNCTION guard_journal_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE entry_status text;
BEGIN
  IF evidence_purge_enabled() THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT status::text INTO entry_status FROM "JournalEntry" WHERE id = OLD."journalEntryId";
  -- NULL: the parent draft is being deleted in this statement (cascade).
  IF entry_status IS NULL OR entry_status = 'draft' THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'Lines of posted journal entries cannot be %', lower(TG_OP) USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER journal_line_immutable_after_post
  BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION guard_journal_line();

-- ── Payment: amounts, tender and drawer are fixed once recorded ──────────────
CREATE OR REPLACE FUNCTION guard_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF evidence_purge_enabled() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment % cannot be deleted; void it', OLD."paymentNumber" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."journalEntryId" IS NOT NULL AND NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId" THEN
    RAISE EXCEPTION 'Payment % journal link is immutable', OLD."paymentNumber" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'Voided payment % cannot be restored', OLD."paymentNumber" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF evidence_row_changed(to_jsonb(OLD), to_jsonb(NEW), ARRAY['status','journalEntryId','allocatedAmount','unallocatedAmount','refundedAmount','voidedAt','voidedById','voidReason','voidedAllocations','updatedAt','updatedBy']) THEN
    RAISE EXCEPTION 'Payment % amount, tender, account and drawer are immutable', OLD."paymentNumber" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_immutable_core
  BEFORE UPDATE OR DELETE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION guard_payment();

CREATE OR REPLACE FUNCTION guard_payment_allocation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE snapshot jsonb; found_payment boolean;
BEGIN
  IF evidence_purge_enabled() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE' THEN
    IF evidence_row_changed(to_jsonb(OLD), to_jsonb(NEW), ARRAY['refundedAmount']) THEN
      RAISE EXCEPTION 'Payment allocation % is immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT "voidedAllocations", true INTO snapshot, found_payment FROM "Payment" WHERE id = OLD."paymentId";
  IF found_payment AND snapshot IS NULL THEN
    RAISE EXCEPTION 'Payment allocation % can only be released by a recorded payment void', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER payment_allocation_evidence
  BEFORE UPDATE OR DELETE ON "PaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION guard_payment_allocation();

-- ── PosRefund: amount/lines fixed; links filled once ─────────────────────────
CREATE OR REPLACE FUNCTION guard_pos_refund() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF evidence_purge_enabled() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refund % cannot be deleted', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."journalEntryId" IS NOT NULL AND evidence_row_changed(to_jsonb(OLD), to_jsonb(NEW), ARRAY['updatedAt']) THEN
    RAISE EXCEPTION 'Posted refund % is immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF evidence_row_changed(to_jsonb(OLD), to_jsonb(NEW), ARRAY['payments','journalEntryId','updatedAt']) THEN
    RAISE EXCEPTION 'Refund % amount and lines are immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_refund_evidence
  BEFORE UPDATE OR DELETE ON "PosRefund"
  FOR EACH ROW EXECUTE FUNCTION guard_pos_refund();
