-- Tables no longer have a cleaning step: settled tables go straight to available.
-- The enum value stays for wire compat with older Android builds.
UPDATE "PosTable" SET "status" = 'available' WHERE "status" = 'cleaning';
