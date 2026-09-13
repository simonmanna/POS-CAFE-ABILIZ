import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
// RETIRED (2026-09-14): this script rewrites or deletes posted financial
// history, which the evidence-integrity triggers now forbid by design. Use an
// approved correction instead: src/scripts/reverse-journal-entry.ts (reversal
// through PostingService), a linked drawer correction in a current shift, or a
// payment void with a reason.
console.error('Retired: this script mutates posted financial history. See the header for the approved correction workflow.');
process.exit(1);



const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.findFirst();
  if (!org) { console.log('No organization found'); process.exit(0); }
  console.log('Org:', org.id, org.name);

  const payments = await prisma.payment.findMany({
    where: { organizationId: org.id, status: { not: 'cancelled' } },
    include: { allocations: { include: { invoice: true } } },
  });
  const bad = payments.filter(p => p.allocations.some(a => a.invoice && !a.invoice.receivableAccountId));
  console.log(`Found ${bad.length} bad payment(s):`);
  console.table(bad.map(p => ({ id: p.id, paymentNumber: p.paymentNumber, amount: String(p.amount), method: p.paymentMethod })));
  const ids = bad.map(p => p.id);

  await prisma.$transaction(async (tx) => {
    const journals = await tx.journalEntry.findMany({
      where: { organizationId: org.id, sourceType: 'payment', sourceId: { in: ids } },
    });
    for (const j of journals) {
      if (j.status === 'posted') {
        await tx.$executeRaw`UPDATE "JournalEntry" SET "status" = 'reversed', "reversedAt" = now() WHERE id = ${j.id} AND "organizationId" = ${org.id}`;
        console.log('  Reversed journal:', j.id, j.journalId, j.description);
      }
    }

    const allocations = await tx.paymentAllocation.findMany({ where: { organizationId: org.id, paymentId: { in: ids } } });
    for (const a of allocations) {
      if (a.invoiceId) {
        await tx.$executeRaw`
          UPDATE "Invoice"
          SET "amountPaid" = "amountPaid" - ${a.amount},
              "amountResidual" = "amountResidual" + ${a.amount},
              "paymentStatus" = CASE WHEN ("amountResidual" + ${a.amount}) <= 0 THEN 'paid' ELSE 'not_paid' END,
              "status" = CASE WHEN ("amountResidual" + ${a.amount}) <= 0 THEN 'paid' ELSE "status" END
          WHERE id = ${a.invoiceId} AND "organizationId" = ${org.id}
        `;
      }
    }

    const movements = await tx.cashMovement.findMany({ where: { organizationId: org.id, paymentId: { in: ids } } });
    const moveIds = movements.map(m => m.id);
    if (moveIds.length) {
      await tx.cashMovement.deleteMany({ where: { organizationId: org.id, id: { in: moveIds } } });
      console.log(`  Deleted ${moveIds.length} cash movement(s)`);
    }

    await tx.paymentAllocation.deleteMany({ where: { organizationId: org.id, paymentId: { in: ids } } });
    const { count } = await tx.payment.deleteMany({ where: { organizationId: org.id, id: { in: ids } } });
    console.log(`  Deleted ${count} payment(s)`);
  });

  console.log('Done.');
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
