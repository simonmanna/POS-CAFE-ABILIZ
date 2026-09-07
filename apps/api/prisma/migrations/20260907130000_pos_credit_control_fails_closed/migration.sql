-- Audit #2 N-05 — credit control fails closed, without stopping anyone trading.
--
-- `Partner.creditLimit` defaults to 0 and the guard read 0 as "unlimited", so
-- every customer created in the back office carried unbounded credit and any
-- cashier holding pos:checkout could put any amount on their account. An unset
-- limit is not a decision to extend infinite credit; it is the absence of one.
--
-- The service now refuses a credit sale against an unset limit unless the org
-- has explicitly declared `settings.credit.allowUnlimited`, and POST
-- /pos/invoices/:id/credit additionally requires the new `pos:credit` right.
--
-- Both of those would break a live cafe on the morning after deployment, so
-- this migration carries the existing behaviour forward EXPLICITLY rather than
-- silently, in two narrowly-scoped backfills.

-- 1) Anyone who could already settle on credit keeps being able to. The right
--    is new; the capability is not. Roles that hold pos:checkout could already
--    do this, so they get pos:credit and nothing changes for them.
UPDATE "Role"
   SET "permissions" = array_append("permissions", 'pos:credit')
 WHERE 'pos:checkout' = ANY("permissions")
   AND NOT ('pos:credit' = ANY("permissions"));

-- 2) An organization that is ALREADY running house accounts keeps them running.
--    Without this, every customer sitting on the default limit of 0 would be
--    refused at the till tomorrow morning. Organizations that have never sold on
--    credit are left secure by default — they must set a real limit, or opt in
--    deliberately.
--
--    THIS IS A COMPATIBILITY SHIM, NOT A RECOMMENDATION. Any org flagged here
--    should set real per-customer credit limits and then clear
--    settings.credit.allowUnlimited. Find them with:
--      SELECT id, name FROM "Organization"
--       WHERE settings #>> '{credit,allowUnlimited}' = 'true';
--    NOTE: jsonb_set() is NOT usable here. With a two-level path it only writes
--    when the PARENT key already exists — `jsonb_set('{}', '{credit,allowUnlimited}',
--    'true', true)` returns `{}` unchanged. Every org that has never configured
--    credit settings has no `credit` object, so jsonb_set would have silently
--    skipped precisely the organizations this shim exists to protect. Merging
--    builds the parent when it is missing and preserves it when it is not.
UPDATE "Organization" o
   SET "settings" = COALESCE(o."settings", '{}'::jsonb)
       || jsonb_build_object(
            'credit',
            COALESCE(o."settings" -> 'credit', '{}'::jsonb)
              || jsonb_build_object('allowUnlimited', true)
          )
 WHERE EXISTS (
         SELECT 1 FROM "Invoice" i
          WHERE i."organizationId" = o.id
            AND i."paymentMode" = 'credit'
       )
   AND COALESCE(o."settings" #>> '{credit,allowUnlimited}', '') <> 'true';
