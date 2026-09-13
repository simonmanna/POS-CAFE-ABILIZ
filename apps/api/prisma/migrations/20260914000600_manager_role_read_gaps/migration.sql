-- UAT: the Manager role could not load the dashboard (GET /products) or the
-- cash register page (GET /users for cashier names). Extend every Manager
-- role; never reduce what a tenant granted.
UPDATE "Role" SET permissions = (SELECT array_agg(DISTINCT p ORDER BY p) FROM unnest(permissions || ARRAY['product:read', 'user:read']::text[]) AS p), "updatedAt" = now()
WHERE name = 'Manager';
