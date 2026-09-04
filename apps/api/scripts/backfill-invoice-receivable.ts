import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Invoices billed before the receivable-account column was persisted carry a NULL
 * `Invoice.receivableAccountId`, which makes session reconciliation report
 * "Payment X has an unverified invoice receivable" even though the GL is sound.
 *
 * Recover the value from the invoice's own posted journal: the debit line whose
 * account is a receivable. Invoices that debited cash/bank directly (pre-settled
 * legacy postings) are intentionally left NULL — the payment path relies on that
 * to refuse further collections until they are corrected by hand.
 *
 * Dry run by default; pass --apply to write.
 */
async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  const rows = await prisma.$queryRawUnsafe<any[]>(`
    SELECT i.id, i."invoiceNumber", i."organizationId", l."accountId", ac.code, ac.name
    FROM "Invoice" i
    JOIN "JournalEntry" e ON e."sourceId" = i.id AND e."sourceType" = 'pos_invoice' AND e.status IN ('posted','reversed')
    JOIN "JournalLine" l ON l."journalEntryId" = e.id AND l.debit > 0
    JOIN "Account" ac ON ac.id = l."accountId"
    JOIN "AccountCategory" c ON c.id = ac."categoryId"
    WHERE i."receivableAccountId" IS NULL AND c.key = 'receivable'
  `);
  console.table(rows.map((r) => ({ invoice: r.invoiceNumber, account: `${r.code} ${r.name}` })));
  if (!apply) { console.log(`${rows.length} invoice(s) would be backfilled. Re-run with --apply to write.`); }
  else {
    for (const r of rows) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Invoice" SET "receivableAccountId" = $1 WHERE id = $2 AND "organizationId" = $3 AND "receivableAccountId" IS NULL`,
        r.accountId, r.id, r.organizationId,
      );
    }
    console.log(`Backfilled ${rows.length} invoice(s).`);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
