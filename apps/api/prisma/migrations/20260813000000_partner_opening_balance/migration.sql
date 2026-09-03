-- Partner.openingBalance — brought-forward AR/AP when a partner is first
-- created (e.g. migrated from a legacy system). Written once at create time.
-- Stored as a signed decimal (negative = credit balance owed to the partner).
ALTER TABLE "Partner" ADD COLUMN "openingBalance" DECIMAL(20, 2) NOT NULL DEFAULT 0;
