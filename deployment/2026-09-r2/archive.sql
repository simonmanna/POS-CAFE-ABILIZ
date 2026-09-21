-- =====================================================================
-- ARCHIVE - pre-migration values, kept forever
--
-- Runs BEFORE bridge-00/10/20/30, while the legacy columns still exist.
-- Everything lands in the `legacy_archive` schema, which:
--   * Prisma never sees (its diff/drift checks look at `public` only),
--   * pg_dump does include, so the evidence travels with every backup,
--   * lets every allowlisted transformation be proven by a join back to the
--     original value instead of being taken on trust.
--
-- Idempotent: each table is created only when missing, so re-running the
-- upgrade driver never overwrites a previous capture.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS legacy_archive;
COMMENT ON SCHEMA legacy_archive IS
  'Pre-migration snapshots captured by deployment/2026-09-r2/archive.sql. Never modified by the application.';

-- --------------------------------------------------------------------
-- Migration history exactly as the cafe server left it (7 rows, two of
-- which exist in no repository).
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legacy_archive.prisma_migrations AS
  SELECT * FROM public."_prisma_migrations";

-- --------------------------------------------------------------------
-- Chart of accounts: the classification that bridge-30 destroys.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legacy_archive.account AS
  SELECT "id", "organizationId", "code", "name",
         "accountType"::text AS "accountType",
         "isGroup", "parentAccountId", "currencyId",
         "isDefault", "isSystem", "isProtected", "isActive",
         "cashFlowCategory", "bankName", "accountNumber",
         "description", "deletedAt", "createdAt", "updatedAt"
    FROM public."Account";

CREATE TABLE IF NOT EXISTS legacy_archive.account_mapping AS
  SELECT * FROM public."AccountMapping";

-- --------------------------------------------------------------------
-- Values that later migrations rewrite in place.
-- --------------------------------------------------------------------

-- PosTable.customZone is dropped by 20260804120000; zone becomes text.
CREATE TABLE IF NOT EXISTS legacy_archive.pos_table AS
  SELECT "id", "organizationId", "name", "zone"::text AS "zone", "customZone"
    FROM public."PosTable";

-- Order.status is remapped by 20260805120100.
CREATE TABLE IF NOT EXISTS legacy_archive.order_status AS
  SELECT "id", "organizationId", "orderNumber", "status"::text AS "status",
         "orderType"::text AS "orderType", "tableId", "invoiceId", "createdAt"
    FROM public."Order";

-- Product.stockPolicy silent -> warn (20260908000000); station enum -> text.
CREATE TABLE IF NOT EXISTS legacy_archive.product_policy AS
  SELECT "id", "organizationId", "sku", "name",
         "stockPolicy"::text AS "stockPolicy",
         "station"::text     AS "station"
    FROM public."Product";

-- Role permissions are widened by several migrations.
CREATE TABLE IF NOT EXISTS legacy_archive.role_permissions AS
  SELECT "id", "organizationId", "name", "isSystem", "permissions", "updatedAt"
    FROM public."Role";

-- Organization.settings gains credit.allowUnlimited (20260907130000).
CREATE TABLE IF NOT EXISTS legacy_archive.organization_settings AS
  SELECT "id", "code", "name", "settings"
    FROM public."Organization";

-- Setting gains scopeType/scopeId and a new unique index.
CREATE TABLE IF NOT EXISTS legacy_archive.setting AS
  SELECT * FROM public."Setting";

-- KDS tickets: business state the owner may resolve in the OLD pos before
-- cutover. Archived so "what did the queue look like" is answerable later.
CREATE TABLE IF NOT EXISTS legacy_archive.kitchen_ticket AS
  SELECT "id", "organizationId", "status"::text AS "status",
         "station"::text AS "station", "createdAt"
    FROM public."KitchenTicket";

-- Report snapshots are rebuilt nightly from the new chart of accounts.
CREATE TABLE IF NOT EXISTS legacy_archive.report_trial_balance AS
  SELECT * FROM public."ReportTrialBalanceSnapshot";
CREATE TABLE IF NOT EXISTS legacy_archive.report_balance_sheet AS
  SELECT * FROM public."ReportBalanceSheetSnapshot";
CREATE TABLE IF NOT EXISTS legacy_archive.report_pnl AS
  SELECT * FROM public."ReportPnLSnapshot";
CREATE TABLE IF NOT EXISTS legacy_archive.report_ap_aging AS
  SELECT * FROM public."ReportApAgingSnapshot";
CREATE TABLE IF NOT EXISTS legacy_archive.report_tieout AS
  SELECT * FROM public."ReportTieoutSnapshot";
CREATE TABLE IF NOT EXISTS legacy_archive.pos_report_snapshot AS
  SELECT * FROM public."PosReportSnapshot";

-- Goods receipts: 20260910000000 marks every unbilled line as fully billed.
-- Guarded, because `billedQuantity` may not exist in every legacy vintage.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'GoodsReceiptLine'
       AND column_name = 'billedQuantity'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'legacy_archive' AND table_name = 'goods_receipt_line'
  ) THEN
    EXECUTE 'CREATE TABLE legacy_archive.goods_receipt_line AS
               SELECT "id", "goodsReceiptNoteId", "quantity", "billedQuantity"
                 FROM public."GoodsReceiptLine"';
  END IF;
END $$;

-- --------------------------------------------------------------------
-- Manifest: what was captured, when, and how many rows.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legacy_archive.archive_manifest (
    captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_db     TEXT        NOT NULL,
    table_name    TEXT        NOT NULL,
    row_count     BIGINT      NOT NULL
);

INSERT INTO legacy_archive.archive_manifest (source_db, table_name, row_count)
SELECT current_database(), c.relname, (
         SELECT count(*) FROM legacy_archive.archive_manifest m
          WHERE m.table_name = c.relname AND m.source_db = current_database()
       )
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'legacy_archive' AND c.relkind = 'r'
   AND c.relname <> 'archive_manifest'
   AND NOT EXISTS (
     SELECT 1 FROM legacy_archive.archive_manifest m
      WHERE m.table_name = c.relname AND m.source_db = current_database()
   );

-- Fill in the real counts (the INSERT above can only reserve the rows).
DO $$
DECLARE r record; n bigint;
BEGIN
  FOR r IN SELECT table_name FROM legacy_archive.archive_manifest
            WHERE source_db = current_database() AND row_count = 0
  LOOP
    EXECUTE format('SELECT count(*) FROM legacy_archive.%I', r.table_name) INTO n;
    UPDATE legacy_archive.archive_manifest
       SET row_count = n
     WHERE table_name = r.table_name AND source_db = current_database();
  END LOOP;
END $$;
