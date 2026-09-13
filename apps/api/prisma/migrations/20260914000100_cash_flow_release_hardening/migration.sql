-- Cash-flow release hardening (certification pass).

-- 1. supplier_payment joins sale/refund as a payment-owned, positive movement.
ALTER TABLE "CashMovement" DROP CONSTRAINT "CashMovement_amount_direction_check";
ALTER TABLE "CashMovement" DROP CONSTRAINT "CashMovement_payment_link_check";
ALTER TABLE "CashMovement"
  ADD CONSTRAINT "CashMovement_amount_direction_check"
    CHECK (
      ("movementType" IN ('sale', 'refund', 'supplier_payment', 'pay_in', 'pay_out') AND amount > 0)
      OR ("movementType" = 'adjustment' AND amount <> 0)
    ),
  ADD CONSTRAINT "CashMovement_payment_link_check"
    CHECK (
      ("movementType" IN ('sale', 'refund', 'supplier_payment') AND "paymentId" IS NOT NULL)
      OR ("movementType" IN ('pay_in', 'pay_out', 'adjustment') AND "paymentId" IS NULL)
    );

-- 2. New drawer evidence must be internally consistent:
--    - only on an OPEN shift of the same organization;
--    - a payment-owned movement references a cash payment of the same
--      organization and shift, with a matching direction;
--    - a reversal/correction stays inside its organization.
CREATE OR REPLACE FUNCTION guard_cash_movement_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
  IF evidence_purge_enabled() THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM "CashSession" s WHERE s.id = NEW."cashSessionId" AND s."organizationId" = NEW."organizationId" AND s.status = 'open') THEN
    RAISE EXCEPTION 'Drawer movements can only be recorded on an open shift of the same organization' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."paymentId" IS NOT NULL THEN
    SELECT "organizationId", "cashSessionId", "paymentMethod", direction, "refundOfId" INTO p FROM "Payment" WHERE id = NEW."paymentId";
    IF NOT FOUND OR p."organizationId" <> NEW."organizationId" THEN
      RAISE EXCEPTION 'Drawer movement must reference a payment of the same organization' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF p."paymentMethod" <> 'cash' OR p."cashSessionId" IS DISTINCT FROM NEW."cashSessionId" THEN
      RAISE EXCEPTION 'Drawer movement must reference a cash payment taken on the same shift' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (NEW."movementType" = 'sale' AND p.direction <> 'inbound')
       OR (NEW."movementType" = 'refund' AND (p.direction <> 'outbound' OR p."refundOfId" IS NULL))
       OR (NEW."movementType" = 'supplier_payment' AND (p.direction <> 'outbound' OR p."refundOfId" IS NOT NULL)) THEN
      RAISE EXCEPTION 'Drawer movement type % does not match its payment', NEW."movementType" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW."reversalOfMovementId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "CashMovement" o WHERE o.id = NEW."reversalOfMovementId" AND o."organizationId" = NEW."organizationId"
  ) THEN
    RAISE EXCEPTION 'A reversal must reference a movement of the same organization' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."correctionOfSessionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "CashSession" s WHERE s.id = NEW."correctionOfSessionId" AND s."organizationId" = NEW."organizationId" AND s.status <> 'open'
  ) THEN
    RAISE EXCEPTION 'A correction must reference a closed shift of the same organization' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_movement_insert_consistency
  BEFORE INSERT ON "CashMovement"
  FOR EACH ROW EXECUTE FUNCTION guard_cash_movement_insert();

-- 3. The cashier's variance explanation and closing notes are evidence: a
--    review may append, never replace. Re-create the session guard.
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
    IF OLD."varianceReason" IS NOT NULL AND (NEW."varianceReason" IS NULL OR left(NEW."varianceReason", length(OLD."varianceReason")) <> OLD."varianceReason") THEN
      RAISE EXCEPTION 'The variance explanation of CashSession % can only be appended to', OLD.id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.notes IS NOT NULL AND (NEW.notes IS NULL OR left(NEW.notes, length(OLD.notes)) <> OLD.notes) THEN
      RAISE EXCEPTION 'The notes of closed CashSession % can only be appended to', OLD.id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF evidence_row_changed(to_jsonb(OLD), to_jsonb(NEW), ARRAY['updatedAt']) THEN
    RAISE EXCEPTION 'Reconciled CashSession % is final', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

-- 4. One open inventory exception per failing line of an invoice, however many
--    retries it takes. Rows without a lineKey (pre line-progress) are untouched.
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryException_one_open_per_line_key"
  ON "InventoryException"("organizationId", "invoiceId", (("payload"->>'lineKey')))
  WHERE status = 'open' AND ("payload"->>'lineKey') IS NOT NULL;
