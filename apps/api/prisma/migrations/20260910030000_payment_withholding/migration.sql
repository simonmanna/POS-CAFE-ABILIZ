-- Withholding tax on supplier payments.
--
-- TaxCalculationService computed `withholdingTotal` and dropped it: no purchase
-- code path ever turned it into a journal line, so the seeded Withholding Tax
-- Payable account (2160) never moved and the liability was invisible. WHT is
-- deducted when the supplier is PAID: the payable is relieved in full, the
-- supplier receives `amount - withholdingAmount`, and the difference is credited
-- to 2160 for onward remittance.
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "withholdingAmount" DECIMAL(20,6) NOT NULL DEFAULT 0;
