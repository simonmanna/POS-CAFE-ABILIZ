-- Session reopen is retired. Roles that could reopen a shift (managers) now
-- hold the replacement controls: force-closing an abandoned shift and posting
-- linked corrections to a closed one.
UPDATE "Role"
SET permissions = (
  SELECT array_agg(DISTINCT p ORDER BY p)
  FROM unnest(array_remove(permissions, 'cash_session:reopen') || ARRAY['cash_session:force_close', 'cash_session:correct']) AS p
)
WHERE 'cash_session:reopen' = ANY(permissions);

UPDATE "Role"
SET permissions = (
  SELECT array_agg(DISTINCT p ORDER BY p)
  FROM unnest(permissions || ARRAY['cash_session:force_close', 'cash_session:correct']) AS p
)
WHERE 'cash_session:approve_variance' = ANY(permissions)
  AND NOT ('cash_session:force_close' = ANY(permissions));
