-- F04: bind a manager approval to the action it authorises.
-- Existing grants were all discount approvals, so the default is safe.
ALTER TABLE "PosApprovalGrant"
  ADD COLUMN "overrideKind" TEXT NOT NULL DEFAULT 'discount';
