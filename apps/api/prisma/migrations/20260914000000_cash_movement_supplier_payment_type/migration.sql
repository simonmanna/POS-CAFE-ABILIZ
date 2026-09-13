-- A supplier paid in cash from a till is not a customer refund. The new value
-- is used by the next migration's CHECK constraint, so it lives in its own
-- migration (an enum value cannot be used in the transaction that adds it).
ALTER TYPE "CashMovementType" ADD VALUE IF NOT EXISTS 'supplier_payment';
