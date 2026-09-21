#!/usr/bin/env node
/**
 * BRIDGE 20 - chart-of-accounts backfill.
 *
 * Runs BETWEEN bridge-10-additive.sql (new columns exist, legacy columns still
 * present) and bridge-30-contract.sql (legacy columns dropped). Both the old and
 * the new columns must exist when it runs.
 *
 * WHY IT EXISTS
 * The squashed baseline replaces `Account.accountType` (a NOT NULL enum) with
 * `Account.categoryId` -> the global `AccountCategory` catalog, plus
 * `normalBalance`, and replaces `isGroup` with `isPostable` (inverted). The
 * schema change carries no data operations, so applied as-is to a live chart of
 * accounts it leaves every account uncategorized: the posting engine cannot
 * resolve accounts, sales cannot be settled, and the nightly snapshot rebuild
 * would rewrite financial history from an uncategorized COA days later.
 *
 * WHAT THIS VERSION FIXES (K1)
 * The 2026-08-r1 predecessor considered only template rows that carry a
 * `categoryKey`, so the five group headers (1000/2000/3000/4000/5000) fell
 * through to the coarse type map and were given a category. A fresh install
 * (apps/api/src/modules/accounting/coa/coa-seeder.ts) gives group nodes
 * `categoryId = NULL`, `isPostable = false`, `normalBalance = 'debit'`, and
 * coa-template.ts states the invariant outright:
 *
 *     categoryKey === null  exactly when  isPostable === false
 *
 * An upgraded database must therefore look exactly like a seeded one. The
 * completeness gate is "no POSTABLE account is uncategorized", not "no account
 * is uncategorized".
 *
 * WHAT IT NEVER TOUCHES
 * name, isDefault, bankName, accountNumber, currencyId, isSystem, isActive and
 * the ledger itself. Differences against the template are reported, never
 * written. `parentAccountId` is filled only with --wire-parents, and only where
 * it is NULL.
 *
 * Dry-run by default.
 *
 * Usage (from the repo root):
 *   $env:DATABASE_URL='postgresql://...@localhost:5432/cafe_migration_r1'
 *   pnpm tsx deployment/2026-09-r2/bridge-20-backfill.ts
 *   pnpm tsx deployment/2026-09-r2/bridge-20-backfill.ts --apply
 *   pnpm tsx deployment/2026-09-r2/bridge-20-backfill.ts --apply --wire-parents
 *
 * Connect as the database OWNER (not the RLS-restricted app role): the backfill
 * has to see every organization's accounts.
 */
import { Client } from 'pg';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedAccountCategories } from '../../apps/api/src/modules/accounting/coa/account-category-seeder';
import { COA_TEMPLATE } from '../../apps/api/src/modules/accounting/coa/coa-template';

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { config } = require('dotenv');
  config();
  config({ path: 'apps/api/.env' });
} catch {
  /* dotenv optional - ambient env works too */
}

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const WIRE_PARENTS = process.argv.includes('--wire-parents');
// Per-run evidence directory (upgrade.ps1 passes it), so one run's mapping
// report can never be mistaken for another's. Defaults to the kit directory.
const OUT_DIR = (() => {
  const i = process.argv.indexOf('--out-dir');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : __dirname;
})();
const DB_URL = process.env.DATABASE_URL ?? '';

/* ------------------------------------------------------------------ */
/* JOB 1 write-target guard (mirrors deployment/2026-09-r2/_safety.ps1) */
/* ------------------------------------------------------------------ */
const FORBIDDEN_DATABASES = ['POS-CAFE'];
const APPROVED_DATABASES = [
  'cafe_reference_20260917',
  'cafe_migration_r1',
  'ref_baseline_20260727',
  'cafe_v2_restore_test',
  'cafe_rollback_test_r1',
  ...(process.env.POSCAFE_EXTRA_APPROVED_DB ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];

function assertSafeTarget(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  const db = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  console.log('=== WRITE TARGET SAFETY CHECK ===');
  console.log(`  purpose   : chart-of-accounts backfill (${APPLY ? 'APPLY' : 'dry run'})`);
  console.log(`  target db : ${db}`);
  console.log(`  host/port : ${parsed.hostname}:${parsed.port || '5432'}`);
  console.log(`  user      : ${decodeURIComponent(parsed.username)}`);
  console.log('  env       : JOB 1 LOCAL REHEARSAL');
  if (FORBIDDEN_DATABASES.includes(db)) {
    throw new Error(`STOP: '${db}' is the live cafe production database.`);
  }
  if (!APPROVED_DATABASES.includes(db)) {
    throw new Error(`STOP: '${db}' is not an approved Job 1 database (${APPROVED_DATABASES.join(', ')}).`);
  }
  if (db === 'cafe_reference_20260917') {
    throw new Error("STOP: 'cafe_reference_20260917' is the untouched golden reference.");
  }
  console.log('  disposable: YES (approved Job 1 target)\n');
  return db;
}

if (!DB_URL) {
  console.error('DATABASE_URL not set (checked env + apps/api/.env).');
  process.exit(2);
}

/**
 * Old `AccountType` enum value -> AccountCategory key, used only for accounts
 * the shipped template does not know (a cafe's own bank, wallet or expense
 * line). `confident: false` marks the three old values that were coarser than
 * the new catalog: `asset` cannot tell current from non-current, `liability` the
 * same, and `expense` could be operating or other. Those are listed in the
 * report for a human to confirm before bridge-30 makes the old value
 * unrecoverable.
 */
const TYPE_TO_CATEGORY: Record<string, { key: string; confident: boolean }> = {
  cash: { key: 'cash', confident: true },
  bank: { key: 'bank', confident: true },
  mobile_money: { key: 'mobile_money', confident: true },
  petty_cash: { key: 'petty_cash', confident: true },
  receivable: { key: 'receivable', confident: true },
  payable: { key: 'payable', confident: true },
  tax: { key: 'tax', confident: true },
  equity: { key: 'equity', confident: true },
  revenue: { key: 'revenue', confident: true },
  cost_of_goods_sold: { key: 'cost_of_goods_sold', confident: true },
  contra_asset: { key: 'contra_asset', confident: true },
  contra_liability: { key: 'contra_liability', confident: true },
  asset: { key: 'current_asset', confident: false },
  liability: { key: 'current_liability', confident: false },
  expense: { key: 'operating_expense', confident: false },
};

/** Every template row, including the group headers (categoryKey === null). */
const TEMPLATE_BY_CODE = new Map(COA_TEMPLATE.map((a) => [a.code, a]));

interface AccountRow {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  accountType: string;
  isGroup: boolean;
  categoryId: string | null;
  parentAccountId: string | null;
}

type Source = 'template' | 'template-group' | 'legacy-group' | 'type-map' | 'already-set' | 'unmapped';

interface Decision {
  id: string;
  code: string;
  name: string;
  oldType: string;
  categoryKey: string | null;
  categoryId: string | null;
  normalBalance: string;
  isPostable: boolean;
  controlAccountType: string | null;
  sortOrder: number | null;
  parentCode: string | null;
  source: Source;
  confident: boolean;
}

async function columnExists(db: Client, table: string, column: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2 AND table_schema = current_schema()`,
    [table, column],
  );
  return (r.rowCount ?? 0) > 0;
}

async function main(): Promise<void> {
  const started = Date.now();
  assertSafeTarget(DB_URL);

  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  try {
    /* --- Preflight ----------------------------------------------------- */
    const hasOld = await columnExists(db, 'Account', 'accountType');
    const hasNew = await columnExists(db, 'Account', 'categoryId');
    if (!hasNew) {
      throw new Error('Account.categoryId is missing - bridge-10-additive.sql has not been applied.');
    }
    if (!hasOld) {
      console.log('Account.accountType is already gone - bridge-30 has run. Nothing to map.');
      return;
    }
    const archived = await db.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'legacy_archive' AND table_name = 'account'`,
    );
    if ((archived.rowCount ?? 0) === 0) {
      throw new Error('legacy_archive.account is missing - run archive.sql before the bridge.');
    }

    /* --- 1. Global category catalog ------------------------------------ */
    // Reuses the API's own seeder so an upgraded database gets byte-identical
    // categories to a freshly seeded one. The adapter is enough: the seeder only
    // calls $executeRawUnsafe(sql, ...params), and pg uses the same $1 syntax.
    const adapter = {
      $executeRawUnsafe: (sql: string, ...params: unknown[]) => db.query(sql, params),
    };
    const { count } = await seedAccountCategories(adapter);
    console.log(`Global account categories ensured: ${count}`);

    const catRes = await db.query<{ id: string; key: string; normalBalance: string }>(
      `SELECT "id", "key", "normalBalance" FROM "AccountCategory"`,
    );
    const categories = new Map(catRes.rows.map((c) => [c.key, c]));

    /* --- 2. Existing accounts ------------------------------------------ */
    const accRes = await db.query<AccountRow>(
      `SELECT "id", "organizationId", "code", "name",
              "accountType"::text AS "accountType", "isGroup", "categoryId", "parentAccountId"
         FROM "Account"
        ORDER BY "organizationId", "code"`,
    );

    /* --- 3. Decide ------------------------------------------------------ */
    const decisions: Decision[] = [];
    const renamedByTemplate: Array<{ code: string; current: string; template: string }> = [];

    for (const a of accRes.rows) {
      if (a.categoryId && !FORCE) {
        decisions.push({
          id: a.id, code: a.code, name: a.name, oldType: a.accountType,
          categoryKey: null, categoryId: a.categoryId, normalBalance: 'debit',
          isPostable: !a.isGroup, controlAccountType: null, sortOrder: null, parentCode: null,
          source: 'already-set', confident: true,
        });
        continue;
      }

      const tpl = TEMPLATE_BY_CODE.get(a.code);
      if (tpl && tpl.name !== a.name) {
        // seedAccountingCore's upsert would rewrite `name` for template codes, so
        // a locally renamed account is surfaced rather than silently reset here.
        renamedByTemplate.push({ code: a.code, current: a.name, template: tpl.name });
      }

      let categoryKey: string | null = null;
      let isPostable = true;
      let source: Source;
      let confident = true;

      if (tpl) {
        categoryKey = tpl.categoryKey;
        isPostable = tpl.isPostable ?? true;
        source = tpl.categoryKey === null ? 'template-group' : 'template';
      } else if (a.isGroup) {
        // A cafe-created folder the template does not know. Same semantics as a
        // template group: no category, not postable.
        categoryKey = null;
        isPostable = false;
        source = 'legacy-group';
      } else {
        const fromType = TYPE_TO_CATEGORY[a.accountType];
        if (fromType && categories.has(fromType.key)) {
          categoryKey = fromType.key;
          isPostable = true;
          confident = fromType.confident;
          source = 'type-map';
        } else {
          categoryKey = null;
          isPostable = true;
          confident = false;
          source = 'unmapped';
        }
      }

      const cat = categoryKey ? categories.get(categoryKey) : undefined;
      decisions.push({
        id: a.id,
        code: a.code,
        name: a.name,
        oldType: a.accountType,
        categoryKey: cat ? categoryKey : null,
        categoryId: cat ? cat.id : null,
        // Mirrors coa-seeder.ts: the category's normal balance, else 'debit'.
        normalBalance: cat ? cat.normalBalance : 'debit',
        isPostable,
        controlAccountType: tpl?.controlAccountType ?? null,
        sortOrder: tpl?.sortOrder ?? null,
        parentCode: tpl?.parentCode ?? null,
        source,
        confident,
      });
    }

    const codeToId = new Map(accRes.rows.map((a) => [`${a.organizationId}|${a.code}`, a.id]));
    const orgOf = new Map(accRes.rows.map((a) => [a.id, a.organizationId]));

    const toWrite = decisions.filter((d) => d.source !== 'already-set');
    const unmapped = decisions.filter((d) => d.source === 'unmapped');
    const groups = decisions.filter((d) => d.source === 'template-group' || d.source === 'legacy-group');
    const needsReview = toWrite.filter((d) => !d.confident && d.source !== 'unmapped');

    /* --- 4. Report ------------------------------------------------------ */
    const report = {
      generatedAt: new Date().toISOString(),
      mode: APPLY ? 'apply' : 'dry-run',
      wireParents: WIRE_PARENTS,
      accounts: decisions.length,
      fromTemplate: decisions.filter((d) => d.source === 'template').length,
      groups: groups.length,
      fromTypeMap: decisions.filter((d) => d.source === 'type-map').length,
      alreadyCategorized: decisions.filter((d) => d.source === 'already-set').length,
      unmapped: unmapped.length,
      needsReview: needsReview.length,
      unmappedAccounts: unmapped.map((d) => ({ code: d.code, name: d.name, oldType: d.oldType })),
      reviewAccounts: needsReview.map((d) => ({
        code: d.code, name: d.name, oldType: d.oldType, assigned: d.categoryKey,
      })),
      groupAccounts: groups.map((d) => ({ code: d.code, name: d.name, oldType: d.oldType, source: d.source })),
      renamedByTemplate,
      warnings: [] as string[],
      durationMs: 0,
    };
    if (renamedByTemplate.length > 0) {
      report.warnings.push(
        `${renamedByTemplate.length} account name(s) differ from COA_TEMPLATE. This backfill does not ` +
          'rename them, but seedAccountingCore would if it ever ran for this organization.',
      );
    }
    report.durationMs = Date.now() - started;

    writeFileSync(join(OUT_DIR, 'MigrationReport.json'), JSON.stringify(report, null, 2));

    const md = [
      '# Account mapping report',
      '',
      `Generated ${report.generatedAt} (${report.mode}${WIRE_PARENTS ? ', wiring parents' : ''})`,
      '',
      `- accounts: **${report.accounts}**`,
      `- from template: **${report.fromTemplate}**`,
      `- group nodes (categoryId NULL, isPostable false): **${report.groups}**`,
      `- from type map: ${report.fromTypeMap}`,
      `- already categorized: ${report.alreadyCategorized}`,
      `- **unmapped postable: ${report.unmapped}**`,
      `- needs review (coarse old type): ${report.needsReview}`,
      '',
      '| Code | Name | Old type | New category | Normal balance | Postable | Control | Source |',
      '|---|---|---|---|---|---|---|---|',
      ...decisions.map(
        (d) =>
          `| ${d.code} | ${d.name} | ${d.oldType} | ${d.categoryKey ?? '(none - group)'} | ` +
          `${d.normalBalance} | ${d.isPostable} | ${d.controlAccountType ?? '-'} | ` +
          `${d.source}${d.confident ? '' : ' WARN'} |`,
      ),
    ].join('\n');
    writeFileSync(join(OUT_DIR, 'MigrationReport.md'), md);

    console.log(
      `\naccounts=${report.accounts} template=${report.fromTemplate} groups=${report.groups} ` +
        `typeMap=${report.fromTypeMap} alreadySet=${report.alreadyCategorized} ` +
        `unmapped=${report.unmapped} needsReview=${report.needsReview}`,
    );
    console.log(`Report written to ${OUT_DIR}\\MigrationReport.{json,md}`);

    if (unmapped.length > 0) {
      console.error(
        `\nBLOCKED: ${unmapped.length} postable account(s) have no category mapping. ` +
          'Add them to TYPE_TO_CATEGORY (or give them a template code) and re-run. ' +
          'bridge-30 must NOT be applied until this reads 0.',
      );
      for (const d of unmapped) console.error(`  ${d.code}  ${d.name}  (${d.oldType})`);
      process.exitCode = 1;
      return;
    }

    if (needsReview.length > 0) {
      console.warn(
        `\n${needsReview.length} account(s) came from a coarse old type and were assigned a default. ` +
          'Review MigrationReport.md before bridge-30.',
      );
    }

    /* --- 5. Apply ------------------------------------------------------- */
    if (!APPLY) {
      console.log('\nDry run - nothing written. Re-run with --apply to commit.');
      return;
    }

    await db.query('BEGIN');
    try {
      for (const d of toWrite) {
        await db.query(
          `UPDATE "Account"
              SET "categoryId"         = $1,
                  "normalBalance"      = $2::"NormalBalance",
                  "isPostable"         = $3,
                  "controlAccountType" = COALESCE($4::"ControlAccountType", "controlAccountType"),
                  "sortOrder"          = COALESCE($5::int, "sortOrder"),
                  "updatedAt"          = NOW()
            WHERE "id" = $6`,
          [d.categoryId, d.normalBalance, d.isPostable, d.controlAccountType, d.sortOrder, d.id],
        );
      }

      if (WIRE_PARENTS) {
        // Only fills NULLs, only from the template, only inside the same org.
        let wired = 0;
        for (const d of decisions) {
          if (!d.parentCode) continue;
          const org = orgOf.get(d.id);
          const parentId = codeToId.get(`${org}|${d.parentCode}`);
          if (!parentId || parentId === d.id) continue;
          const r = await db.query(
            `UPDATE "Account" SET "parentAccountId" = $1, "updatedAt" = NOW()
              WHERE "id" = $2 AND "parentAccountId" IS NULL`,
            [parentId, d.id],
          );
          wired += r.rowCount ?? 0;
        }
        console.log(`parentAccountId wired on ${wired} account(s) (NULL -> template parent).`);
      }

      /* --- 6. Invariant gates, inside the transaction ------------------- */
      const leftover = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "Account" WHERE "isPostable" AND "categoryId" IS NULL`,
      );
      if (Number(leftover.rows[0].count) > 0) {
        throw new Error(
          `${leftover.rows[0].count} POSTABLE account(s) still have a NULL categoryId - rolling back.`,
        );
      }
      const contradiction = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "Account" WHERE NOT "isPostable" AND "categoryId" IS NOT NULL`,
      );
      if (Number(contradiction.rows[0].count) > 0) {
        throw new Error(
          `${contradiction.rows[0].count} non-postable account(s) carry a categoryId, breaking the ` +
            'coa-template invariant (categoryKey null <=> isPostable false) - rolling back.',
        );
      }
      const defaults = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM (
           SELECT "organizationId", "categoryId"
             FROM "Account"
            WHERE "isDefault" AND "deletedAt" IS NULL AND "categoryId" IS NOT NULL
            GROUP BY 1, 2 HAVING COUNT(*) > 1
         ) d`,
      );
      if (Number(defaults.rows[0].count) > 0) {
        throw new Error(
          `${defaults.rows[0].count} category/organization pair(s) have more than one default account. ` +
            'Migration 20260913000000 would fail on Account_one_default_per_category_key - rolling back.',
        );
      }

      await db.query('COMMIT');
      console.log(`\nApplied. ${toWrite.length} account(s) updated; invariants hold.`);
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
