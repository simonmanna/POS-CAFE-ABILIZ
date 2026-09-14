/**
 * Catch-up for valued stock movements that never reached the GL.
 *
 * Before the 2026-09-14 remediation, Direct Stock In (and the since-removed bare
 * /inventory/stock/receive route) moved stock with value but posted no journal
 * entry, so the inventory sub-ledger ran ahead of the Stock Valuation account.
 * This script finds every valued, non-transfer ledger row with no inventory
 * journal entry and posts ONE audited catch-up entry per organization per
 * source type, dated today (the current open period — history is never
 * rewritten):
 *
 *   net gain  → Dr Stock Valuation / Cr Stock Adjustment Income
 *   net loss  → Dr Stock Adjustment Expense / Cr Stock Valuation
 *
 * Opening-balance rows (seed / opening backfill) are memo entries by design and
 * are REPORTED, not posted, unless the accountant opts in explicitly with
 * --post-opening-balances: then ONE entry per organization capitalises them
 * against the account mapped to --opening-equity-key (default
 * `opening_balance_equity`):  Dr Stock Valuation / Cr Opening Balance Equity.
 * The mapping must already exist — the script never invents a counter-account.
 *
 * SAFETY
 *   - DRY-RUN BY DEFAULT. Pass --apply to write.
 *   - Idempotent: each catch-up JE carries a postingKey, and rows it covered are
 *     excluded from the next run (and from the GL tie-out report).
 *   - --before <ISO>  only rows created at or before this instant (default now).
 *   - --org <id>      restrict to one organization.
 *   - --post-opening-balances [--opening-equity-key <mapping key>]
 *
 *   pnpm backfill:inventory-gl-gaps            # dry run
 *   pnpm backfill:inventory-gl-gaps --apply    # write
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../kernel/prisma/prisma.service';
import { TenantContextService } from '../kernel/tenancy/tenant-context.service';
import { PostingService } from '../modules/accounting/posting/posting.service';
import {
  GL_GAP_BACKFILL_SOURCE,
  InventoryValuationReportService,
} from '../modules/accounting/reporting/inventory-valuation.service';
import { AuditService } from '../kernel/audit/audit.service';
import { dec, ZERO } from '../kernel/common/money';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const APPLY = process.argv.includes('--apply');
const BEFORE = argValue('--before') ? new Date(argValue('--before')!) : new Date();
const ONLY_ORG = argValue('--org');
const MEMO_TYPES = new Set(['opening_balance']);
const MEMO_SOURCES = new Set(['opening_balance', 'opening_backfill']);
const POST_OPENING = process.argv.includes('--post-opening-balances');
const OPENING_EQUITY_KEY = argValue('--opening-equity-key') ?? 'opening_balance_equity';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const prisma = app.get(PrismaService);
  const tenant = app.get(TenantContextService);
  const posting = app.get(PostingService);
  const reports = app.get(InventoryValuationReportService);
  const audit = app.get(AuditService);

  console.log(`Inventory GL-gap catch-up — ${APPLY ? 'APPLY (writing)' : 'DRY RUN'} · rows up to ${BEFORE.toISOString()}`);
  let entries = 0;
  let postedValue = ZERO;
  let memoRows = 0;
  try {
    const orgs = await prisma.raw.organization.findMany({
      where: ONLY_ORG ? { id: ONLY_ORG } : {},
      select: { id: true, name: true },
    });
    for (const org of orgs) {
      await tenant.run({ organizationId: org.id, userId: 'system:backfill', permissions: ['*'] }, async () => {
        const { accountIds, rows } = await reports.unpostedLedgerRows(BEFORE);
        if (rows.length === 0) return;
        console.log(`\n── ${org.name} (${org.id}) ──`);
        if (accountIds.length === 0) {
          console.log('  ⚠ no stock_valuation mapping — skipped');
          return;
        }

        const groups = new Map<string, { rows: number; value: ReturnType<typeof dec>; codes: string[] }>();
        const opening = new Map<string, { rows: number; value: ReturnType<typeof dec>; codes: string[] }>();
        for (const r of rows) {
          if (MEMO_TYPES.has(r.move_type) || MEMO_SOURCES.has(r.source ?? '')) {
            memoRows++;
            const key = r.source ?? '(none)';
            const o = opening.get(key) ?? { rows: 0, value: ZERO, codes: [] };
            o.rows++;
            o.value = o.value.plus(dec(r.signed_value));
            o.codes.push(r.ledger_code);
            opening.set(key, o);
            continue;
          }
          const key = r.source ?? '(none)';
          const g = groups.get(key) ?? { rows: 0, value: ZERO, codes: [] };
          g.rows++;
          g.value = g.value.plus(dec(r.signed_value));
          g.codes.push(r.ledger_code);
          groups.set(key, g);
        }

        for (const [source, o] of opening) {
          console.log(`  · opening ${source}: ${o.rows} row(s), ${o.value.toFixed(2)} ${POST_OPENING ? `→ Dr Stock / Cr ${OPENING_EQUITY_KEY}` : '(memo — pass --post-opening-balances to capitalise)'}`);
          if (!POST_OPENING || o.value.isZero()) continue;
          const equity = (await prisma.raw.accountMapping.findFirst({ where: { organizationId: org.id, key: OPENING_EQUITY_KEY }, select: { accountId: true } }))?.accountId;
          if (!equity) {
            console.log(`    ⚠ no ${OPENING_EQUITY_KEY} account mapping — map the opening-balance equity account first; skipped`);
            continue;
          }
          entries++;
          postedValue = postedValue.plus(o.value.abs());
          if (!APPLY) continue;
          const stockAccount = accountIds[0];
          const gain = o.value.gt(ZERO);
          const amount = o.value.abs().toString();
          await prisma.client.$transaction(async (tx: any) => {
            const je = await posting.post(
              {
                journalCode: 'GEN',
                date: new Date(),
                description: `Opening inventory capitalised · ${source} · ${o.rows} opening-balance movement(s)`,
                sourceType: GL_GAP_BACKFILL_SOURCE,
                sourceId: source,
                postingKey: `inventory:opening:${org.id}:${source}:${BEFORE.toISOString()}`,
                lines: gain
                  ? [
                      { accountId: stockAccount, debit: amount, description: 'Opening inventory' },
                      { accountId: equity, credit: amount, description: 'Opening inventory' },
                    ]
                  : [
                      { accountId: equity, debit: amount, description: 'Opening inventory' },
                      { accountId: stockAccount, credit: amount, description: 'Opening inventory' },
                    ],
              },
              tx,
            );
            await audit.recordInTx(tx, {
              entity: 'JournalEntry',
              entityId: je.id,
              action: 'create',
              newValues: { reason: 'inventory_opening_balance_capitalised', source, rows: o.rows, amount, ledgerCodes: o.codes.slice(0, 200) },
            });
          });
        }

        for (const [source, g] of groups) {
          if (g.value.isZero()) continue;
          const gain = g.value.gt(ZERO);
          const amount = g.value.abs();
          console.log(`  + ${source}: ${g.rows} row(s), net ${g.value.toFixed(2)} → ${gain ? 'Dr Stock / Cr Adj income' : 'Dr Adj expense / Cr Stock'}`);
          entries++;
          postedValue = postedValue.plus(amount);
          if (!APPLY) continue;

          const map = async (key: string) =>
            (await prisma.raw.accountMapping.findFirst({ where: { organizationId: org.id, key }, select: { accountId: true } }))?.accountId;
          const stock = accountIds[0];
          const counter = await map(gain ? 'stock_adjustment_income' : 'stock_adjustment_expense');
          if (!counter) {
            console.log(`    ⚠ no ${gain ? 'stock_adjustment_income' : 'stock_adjustment_expense'} mapping — skipped`);
            continue;
          }
          await prisma.client.$transaction(async (tx: any) => {
            const je = await posting.post(
              {
                journalCode: 'ADJ',
                date: new Date(),
                description: `Inventory GL catch-up · ${source} · ${g.rows} movement(s) posted without a journal entry`,
                sourceType: GL_GAP_BACKFILL_SOURCE,
                sourceId: source,
                postingKey: `inventory:gl-gap:${org.id}:${source}:${BEFORE.toISOString()}`,
                lines: gain
                  ? [
                      { accountId: stock, debit: amount.toString(), description: `Catch-up ${source}` },
                      { accountId: counter, credit: amount.toString(), description: `Catch-up ${source}` },
                    ]
                  : [
                      { accountId: counter, debit: amount.toString(), description: `Catch-up ${source}` },
                      { accountId: stock, credit: amount.toString(), description: `Catch-up ${source}` },
                    ],
              },
              tx,
            );
            await audit.recordInTx(tx, {
              entity: 'JournalEntry',
              entityId: je.id,
              action: 'create',
              newValues: { reason: 'inventory_gl_gap_backfill', source, rows: g.rows, amount: amount.toString(), ledgerCodes: g.codes.slice(0, 200) },
            });
          });
        }
      });
    }
  } finally {
    await app.close();
  }

  console.log('\n════ Summary ════');
  console.log(`  catch-up entries : ${entries} (Σ ${postedValue.toFixed(2)})`);
  console.log(`  memo rows skipped: ${memoRows}`);
  console.log(APPLY ? '  → written.' : '  → dry run only. Re-run with --apply to write.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
