-- Postgres truncates identifiers to 63 bytes; align the stock-card index name
-- with the name Prisma derives so schema and database never report drift.
ALTER INDEX IF EXISTS "InventoryLedger_organizationId_productId_locationId_createdAt_i"
  RENAME TO "InventoryLedger_organizationId_productId_locationId_created_idx";
