-- Hotfix: "Account mapping 'sales_discount' is not configured" → discounted bill 500.
-- Adds a 4900 Sales Discounts (contra-revenue) account + the sales_discount mapping
-- for every organization that is missing them. Safe to re-run (idempotent) and safe
-- on a live DB — it only INSERTs the two missing rows, touches nothing else.
--
-- Run:  psql "<DATABASE_URL>" -f hotfix-sales-discount.sql
-- (If gen_random_uuid() errors, run once:  CREATE EXTENSION IF NOT EXISTS pgcrypto;)

BEGIN;

-- 1) The contra-revenue account (one per org, only if absent).
INSERT INTO "Account"
  (id, "organizationId", code, name, "accountType", "isGroup", "isActive",
   "cashFlowCategory", "isSystem", "isProtected", "isDefault", "createdAt", "updatedAt")
SELECT gen_random_uuid(), o.id, '4900', 'Sales Discounts', 'revenue'::"AccountType",
       false, true, 'operating', true, false, false, now(), now()
FROM "Organization" o
WHERE NOT EXISTS (
  SELECT 1 FROM "Account" a WHERE a."organizationId" = o.id AND a.code = '4900'
);

-- 2) The mapping the posting engine looks up (one per org, only if absent).
INSERT INTO "AccountMapping"
  (id, "organizationId", key, "accountId", "createdAt", "updatedAt")
SELECT gen_random_uuid(), a."organizationId", 'sales_discount', a.id, now(), now()
FROM "Account" a
WHERE a.code = '4900'
  AND NOT EXISTS (
    SELECT 1 FROM "AccountMapping" m
    WHERE m."organizationId" = a."organizationId" AND m.key = 'sales_discount'
  );

-- 3) Verify — should list one row per org, mapping → 4900.
SELECT m."organizationId", m.key, a.code, a.name
FROM "AccountMapping" m JOIN "Account" a ON a.id = m."accountId"
WHERE m.key = 'sales_discount';

COMMIT;
