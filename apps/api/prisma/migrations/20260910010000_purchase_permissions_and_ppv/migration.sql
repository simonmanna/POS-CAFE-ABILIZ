-- Posting a goods receipt now requires `goods_receipt:post` instead of reusing
-- `goods_receipt:create`, so capturing a delivery note and committing it can be
-- held by different people. Grant the new permission to every role that could
-- already post, or the upgrade locks receiving out on day one. Segregating the
-- duties afterwards is then a deliberate change in the roles UI.
UPDATE "Role"
SET "permissions" = "permissions" || ARRAY['goods_receipt:post']
WHERE 'goods_receipt:create' = ANY("permissions")
  AND NOT ('goods_receipt:post' = ANY("permissions"));

-- Purchase price variance. Posting a bill at a price different from the cost the
-- goods were received at used to leave the difference stuck in GRNI (2150)
-- forever. The bill JE now moves it to PPV. Give existing organisations the
-- account and the mapping, modelled on their Stock Adjustment Expense row so
-- category, parent and currency stay consistent per org. Orgs that somehow have
-- no 5300 are skipped: the posting path falls back to stock_adjustment_expense.
INSERT INTO "Account" (
  "id", "organizationId", "code", "name", "categoryId", "normalBalance",
  "parentAccountId", "sortOrder", "currencyId", "isPostable", "isActive", "updatedAt"
)
SELECT
  gen_random_uuid()::text, a."organizationId", '5320', 'Purchase Price Variance',
  a."categoryId", a."normalBalance", a."parentAccountId", 5320, a."currencyId", true, true,
  CURRENT_TIMESTAMP
FROM "Account" a
WHERE a."code" = '5300'
  AND NOT EXISTS (
    SELECT 1 FROM "Account" b
    WHERE b."organizationId" = a."organizationId" AND b."code" = '5320'
  );

INSERT INTO "AccountMapping" ("id", "organizationId", "key", "accountId", "updatedAt")
SELECT gen_random_uuid()::text, a."organizationId", 'purchase_price_variance', a."id", CURRENT_TIMESTAMP
FROM "Account" a
WHERE a."code" = '5320'
  AND NOT EXISTS (
    SELECT 1 FROM "AccountMapping" m
    WHERE m."organizationId" = a."organizationId" AND m."key" = 'purchase_price_variance'
  );
