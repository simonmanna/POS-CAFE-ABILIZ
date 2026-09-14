/**
 * Backfill missing OPENING BALANCE ledger rows.
 *
 * Problem: stock written straight into StockItem (the demo seed, old imports)
 * has no InventoryLedger row. The cached on-hand is right, but every
 * ledger-based report (movement summary, stock card, reconciliation) starts
 * from zero, so opening/closing balances come out short by exactly that amount.
 * Symptom: the ledger page's first "Qty Before" is not 0 (e.g. 80), while the
 * movement report's closing is negative.
 *
 * Fix, per stock cell (product × variant × location):
 *   gap = cached on-hand − Σ ledger quantityChange
 * When gap equals the first ledger row's qtyBefore (or the cell has no ledger at
 * all), insert one `opening_balance` row of `gap` units dated 1 ms before the
 * first movement (or at StockItem.createdAt), valued at the product cost price.
 *
 * A gap that does NOT match the first qtyBefore is a mid-stream bypass, not an
 * opening problem — it is REPORTED, never auto-fixed; resolve it with a stock
 * count / adjustment.
 *
 * GL: this is a memo correction to the stock ledger only. No journal entry is
 * posted — the seeded stock never had one either. If your books need the
 * opening inventory value, post an opening-balance journal separately.
 *
 * SAFETY: dry-run by default; --apply to write. Idempotent (skips cells that
 * already carry a referenceType='opening_backfill' row). --org <id> to scope.
 *
 *   npx ts-node src/scripts/backfill-opening-ledger.ts           # dry run
 *   npx ts-node src/scripts/backfill-opening-ledger.ts --apply   # write
 */
import { PrismaClient, Prisma } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const orgIdx = process.argv.indexOf('--org');
const ONLY_ORG = orgIdx >= 0 ? process.argv[orgIdx + 1] : undefined;
const EPS = new Prisma.Decimal('0.000001');

async function main() {
  const prisma = new PrismaClient();
  console.log(APPLY ? '*** APPLY MODE — writing changes ***' : '--- DRY RUN (pass --apply to write) ---');

  const items = await prisma.stockItem.findMany({
    where: ONLY_ORG ? { organizationId: ONLY_ORG } : {},
    select: {
      organizationId: true, productId: true, variantId: true, locationId: true, quantity: true, createdAt: true,
      product: { select: { code: true, name: true, costPrice: true } },
      location: { select: { code: true } },
    },
    orderBy: [{ organizationId: 'asc' }],
  });

  let fixed = 0;
  let unexplained = 0;
  for (const it of items) {
    const cell = { organizationId: it.organizationId, productId: it.productId, variantId: it.variantId, locationId: it.locationId };
    const already = await prisma.inventoryLedger.findFirst({ where: { ...cell, referenceType: 'opening_backfill' }, select: { id: true } });
    if (already) continue;

    const [first, sum] = await Promise.all([
      prisma.inventoryLedger.findFirst({ where: cell, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { qtyBefore: true, createdAt: true } }),
      prisma.inventoryLedger.aggregate({ where: cell, _sum: { quantityChange: true } }),
    ]);
    const cached = new Prisma.Decimal(it.quantity);
    const ledgerSum = new Prisma.Decimal(sum._sum.quantityChange ?? 0);
    // The quantity the ledger is missing. It is an OPENING gap only when it
    // equals what the first movement saw as "before" (or the cell has no ledger).
    const gap = cached.minus(ledgerSum);
    const label = `${it.product.code} ${it.product.name} @ ${it.location.code}`;
    if (gap.abs().lte(EPS)) continue;
    if (first && gap.minus(first.qtyBefore).abs().gt(EPS)) {
      unexplained++;
      console.log(`  ⚠ ${label}: cached ${cached} vs ledger Σ ${ledgerSum} (gap ${gap}), first qtyBefore ${first.qtyBefore} — not an opening gap; needs a stock count/adjustment (not auto-fixed)`);
      continue;
    }

    const unitCost = new Prisma.Decimal(it.product.costPrice ?? 0);
    const at = first ? new Date(first.createdAt.getTime() - 1) : it.createdAt;
    console.log(`  + ${label}: opening_balance ${gap} @ ${unitCost} dated ${at.toISOString()} (cached ${cached}, ledger Σ ${ledgerSum})`);
    fixed++;
    if (!APPLY) continue;

    await prisma.inventoryLedger.create({
      data: {
        ...cell,
        ledgerCode: 'STK/OPENING-BACKFILL',
        type: 'opening_balance',
        qtyBefore: 0,
        quantityChange: gap,
        balanceAfter: gap,
        unitCost,
        totalValue: gap.abs().times(unitCost),
        referenceType: 'opening_backfill',
        referenceId: 'backfill-opening-ledger',
        notes: 'Backfilled opening balance: stock existed with no ledger entry (seed/import). Memo only, no GL.',
        createdAt: at,
      },
    });
  }

  console.log(`\n${APPLY ? 'Inserted' : 'Would insert'} ${fixed} opening row(s). ${unexplained} cell(s) with residual drift need a count.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
