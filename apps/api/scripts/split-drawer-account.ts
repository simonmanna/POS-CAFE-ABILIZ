import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

/**
 * Give a cash register its own drawer account and clear the historical drift
 * that keeps session close blocked.
 *
 * Background: the register's drawer account was also the organisation's
 * `default_cash` mapping, so unrelated cash activity (non-POS collections,
 * legacy invoice postings that debited cash directly, electronic tenders
 * mis-posted before the tender resolver was tightened) accumulated in the same
 * account. `reconcileSession` compares that account's ledger balance with the
 * drawer's expected cash, so close fails permanently.
 *
 * What this does, in one transaction:
 *   1. Creates a dedicated drawer account (default 1101) in the same category
 *      and under the same parent as the current one.
 *   2. Re-codes the open session's own cash payments — the Payment rows and
 *      their posted journal lines — onto the new drawer account. Reconciliation
 *      checks each cash payment against `register.defaultAccountId`, so the
 *      account coding has to travel with the register; an adjusting JE alone
 *      would move the balance but leave every payment flagged.
 *   3. Posts an adjusting entry for the part of the drawer's expected cash that
 *      was never booked (the opening float, on sessions that predate
 *      opening-float posting): Dr new drawer / Cr suspense.
 *   4. Posts an adjusting entry reclassifying the unexplained balance off the
 *      old account: Dr suspense / Cr old account. "Unexplained" = cash-account
 *      lines from `pos_invoice` entries (legacy direct-to-cash postings with no
 *      Payment behind them) plus any non-cash tender that landed on the drawer.
 *      Genuine non-POS cash receipts stay on the general cash account.
 *   5. Points the register at the new drawer account.
 *
 * Dry run by default; pass --apply to write. Optional --register <code|id>,
 * --code <account code>, --name <account name>.
 */

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const arg = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes('--apply');
const NEW_CODE = arg('--code') ?? '1101';
const NEW_NAME = arg('--name');

const num = (v: any) => Number(v ?? 0);
const money = (n: number) => n.toFixed(2);

async function ledgerBalance(tx: any, organizationId: string, accountId: string) {
  const [row] = await tx.$queryRawUnsafe<any[]>(
    'SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS balance FROM "JournalLine" l ' +
    'JOIN "JournalEntry" e ON e.id = l."journalEntryId" ' +
    'WHERE l."organizationId" = $1 AND l."accountId" = $2 AND e.status IN (\'posted\',\'reversed\')',
    organizationId, accountId,
  );
  return num(row?.balance);
}

async function nextEntryNumber(tx: any, organizationId: string, journalCode: string, journalId: string, year: number) {
  const [row] = await tx.$queryRawUnsafe<any[]>(
    'SELECT "entryNumber" FROM "JournalEntry" WHERE "organizationId" = $1 AND "journalId" = $2 AND "entryNumber" LIKE $3 ' +
    'ORDER BY "entryNumber" DESC LIMIT 1',
    organizationId, journalId, journalCode + '/' + year + '/%',
  );
  const last = row ? Number(String(row.entryNumber).split('/')[2]) : 0;
  return journalCode + '/' + year + '/' + String(last + 1).padStart(5, '0');
}

async function postEntry(tx: any, organizationId: string, input: {
  journalId: string; journalCode: string; description: string; sourceType: string; sourceId: string;
  lines: Array<{ accountId: string; debit?: number; credit?: number; description?: string }>;
}) {
  const now = new Date();
  const entryNumber = await nextEntryNumber(tx, organizationId, input.journalCode, input.journalId, now.getFullYear());
  const id = randomUUID();
  await tx.$executeRawUnsafe(
    'INSERT INTO "JournalEntry" (id, "organizationId", "journalId", "entryNumber", "postingDate", description, status, ' +
    '"sourceType", "sourceId", "postingType", "postedAt", "createdAt", "updatedAt") ' +
    'VALUES ($1,$2,$3,$4,$5,$6,\'posted\',$7,$8,\'primary\',$5,$5,$5)',
    id, organizationId, input.journalId, entryNumber, now, input.description, input.sourceType, input.sourceId,
  );
  let lineNumber = 0;
  for (const l of input.lines) {
    const debit = money(l.debit ?? 0);
    const credit = money(l.credit ?? 0);
    await tx.$executeRawUnsafe(
      'INSERT INTO "JournalLine" (id, "organizationId", "journalEntryId", "accountId", description, debit, credit, ' +
      '"exchangeRate", "baseDebit", "baseCredit", "lineNumber", "createdAt") ' +
      'VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,1,$6::numeric,$7::numeric,$8,$9)',
      randomUUID(), organizationId, id, l.accountId, l.description ?? input.description, debit, credit, lineNumber++, now,
    );
  }
  return { id, entryNumber };
}

async function main() {
  const registerArg = arg('--register');
  const register = await prisma.cashRegister.findFirst({
    where: registerArg ? { OR: [{ id: registerArg }, { code: registerArg }] } : { isActive: true },
  });
  if (!register) throw new Error('No cash register found (pass --register <code|id>)');
  const organizationId = register.organizationId;

  const oldAccount = await prisma.account.findFirst({ where: { id: register.defaultAccountId!, organizationId } });
  if (!oldAccount) throw new Error('Register has no drawer account');
  const suspense = await prisma.accountMapping.findFirst({ where: { organizationId, key: 'suspense' } });
  if (!suspense?.accountId) throw new Error('No "suspense" account mapping configured');
  const adjJournal = (await prisma.journal.findFirst({ where: { organizationId, code: 'ADJ' } }))
    ?? (await prisma.journal.findFirst({ where: { organizationId, code: 'GEN' } }));
  if (!adjJournal) throw new Error('No ADJ or GEN journal configured');
  if (await prisma.account.findFirst({ where: { organizationId, code: NEW_CODE } })) {
    throw new Error('Account ' + NEW_CODE + ' already exists — pass --code with a free account code');
  }

  const session = await prisma.cashSession.findFirst({ where: { organizationId, cashRegisterId: register.id, status: 'open' } });
  if (!session) throw new Error('No open session on this register — nothing to re-code');

  const movements = await prisma.cashMovement.findMany({ where: { organizationId, cashSessionId: session.id } });
  const movementTotal = (type: string) => movements.filter((m) => m.movementType === type).reduce((s, m) => s + num(m.amount), 0);
  const expectedCash = num(session.openingFloat) + movementTotal('sale') + movementTotal('pay_in')
    + movementTotal('adjustment') - movementTotal('pay_out') - movementTotal('refund');

  // Session cash payments — these move onto the new drawer account with the register.
  const sessionCashPayments = await prisma.payment.findMany({
    where: { organizationId, cashSessionId: session.id, paymentMethod: 'cash', accountId: oldAccount.id, status: { not: 'cancelled' } },
  });
  const recoded = sessionCashPayments.reduce((s, p) => s + num(p.amount) * (p.direction === 'inbound' ? 1 : -1), 0);

  // Unexplained drawer balance: legacy pos_invoice entries that debited cash
  // directly, plus non-cash tenders that landed on the drawer account.
  const legacyInvoiceLines = await prisma.$queryRawUnsafe<any[]>(
    'SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS amount FROM "JournalLine" l ' +
    'JOIN "JournalEntry" e ON e.id = l."journalEntryId" ' +
    'WHERE l."organizationId" = $1 AND l."accountId" = $2 AND e.status IN (\'posted\',\'reversed\') AND e."sourceType" = \'pos_invoice\'',
    organizationId, oldAccount.id,
  );
  const misTendered = await prisma.payment.findMany({
    where: { organizationId, accountId: oldAccount.id, paymentMethod: { not: 'cash' }, status: { not: 'cancelled' } },
  });
  const unexplained = num(legacyInvoiceLines[0]?.amount)
    + misTendered.reduce((s, p) => s + num(p.amount) * (p.direction === 'inbound' ? 1 : -1), 0);

  const ledgerOld = await ledgerBalance(prisma, organizationId, oldAccount.id);
  const unbookedFloat = expectedCash - recoded;   // the opening float, on sessions that never posted it
  const leftOnOld = ledgerOld - recoded - unexplained;
  const newName = NEW_NAME ?? (register.name + ' Drawer');

  console.log('Register        : ' + register.code + ' ' + register.name);
  console.log('Old drawer acct : ' + oldAccount.code + ' ' + oldAccount.name + '  (ledger ' + money(ledgerOld) + ')');
  console.log('New drawer acct : ' + NEW_CODE + ' ' + newName);
  console.table([
    { step: '1. re-code session cash payments', amount: money(recoded), detail: sessionCashPayments.length + ' payment(s) + journal lines -> ' + NEW_CODE },
    { step: '2. book unrecorded drawer cash', amount: money(unbookedFloat), detail: 'Dr ' + NEW_CODE + ' / Cr suspense (opening float never posted)' },
    { step: '3. reclassify unexplained balance', amount: money(unexplained), detail: 'Dr suspense / Cr ' + oldAccount.code },
  ]);
  console.log('After: new drawer ledger ' + money(recoded + unbookedFloat) + ' vs session expected cash ' + money(expectedCash));
  console.log('After: ' + oldAccount.code + ' ' + oldAccount.name + ' keeps ' + money(leftOnOld) + ' (genuine non-POS cash receipts)');
  if (unbookedFloat < 0) throw new Error('Session payments exceed expected drawer cash — investigate before running this');
  if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); await prisma.$disconnect(); return; }

  const receipt = await prisma.$transaction(async (tx: any) => {
    const now = new Date();
    const newAccountId = randomUUID();
    await tx.$executeRawUnsafe(
      'INSERT INTO "Account" (id, "organizationId", code, name, "categoryId", "normalBalance", "parentAccountId", "sortOrder", ' +
      '"isPostable", "isActive", "allowManualPosting", "allowReconciliation", description, "createdAt", "updatedAt") ' +
      'VALUES ($1,$2,$3,$4,$5,\'debit\',$6,$7,true,true,true,true,$8,$9,$9)',
      newAccountId, organizationId, NEW_CODE, newName, oldAccount.categoryId, oldAccount.parentAccountId,
      Number(NEW_CODE) || oldAccount.sortOrder + 1, 'Dedicated drawer account for register ' + register.code, now,
    );

    const paymentIds = sessionCashPayments.map((p) => p.id);
    if (paymentIds.length) {
      await tx.$executeRawUnsafe(
        'UPDATE "Payment" SET "accountId" = $1 WHERE "organizationId" = $2 AND id = ANY($3::text[])',
        newAccountId, organizationId, paymentIds,
      );
      await tx.$executeRawUnsafe(
        'UPDATE "JournalLine" l SET "accountId" = $1 FROM "JournalEntry" e ' +
        'WHERE e.id = l."journalEntryId" AND l."organizationId" = $2 AND l."accountId" = $3 ' +
        'AND e."sourceType" = \'payment\' AND e."sourceId" = ANY($4::text[])',
        newAccountId, organizationId, oldAccount.id, paymentIds,
      );
    }

    const entries: any[] = [];
    if (unbookedFloat > 0) {
      entries.push(await postEntry(tx, organizationId, {
        journalId: adjJournal.id, journalCode: adjJournal.code,
        description: 'Book unrecorded drawer cash for register ' + register.code + ' (opening float)',
        sourceType: 'drawer_account_split', sourceId: register.id,
        lines: [{ accountId: newAccountId, debit: unbookedFloat }, { accountId: suspense.accountId!, credit: unbookedFloat }],
      }));
    }
    if (unexplained !== 0) {
      entries.push(await postEntry(tx, organizationId, {
        journalId: adjJournal.id, journalCode: adjJournal.code,
        description: 'Reclassify unexplained ' + oldAccount.code + ' balance (legacy invoice cash postings, mis-posted tenders)',
        sourceType: 'drawer_account_split', sourceId: register.id,
        lines: unexplained > 0
          ? [{ accountId: suspense.accountId!, debit: unexplained }, { accountId: oldAccount.id, credit: unexplained }]
          : [{ accountId: oldAccount.id, debit: -unexplained }, { accountId: suspense.accountId!, credit: -unexplained }],
      }));
    }

    await tx.$executeRawUnsafe(
      'UPDATE "CashRegister" SET "defaultAccountId" = $1, "updatedAt" = $2 WHERE id = $3 AND "organizationId" = $4',
      newAccountId, now, register.id, organizationId,
    );

    const drawerLedger = await ledgerBalance(tx, organizationId, newAccountId);
    if (Math.abs(drawerLedger - expectedCash) > 0.005) {
      throw new Error('New drawer ledger ' + money(drawerLedger) + ' != expected cash ' + money(expectedCash) + ' — rolled back');
    }
    return { newAccountId, entries, recodedPayments: paymentIds.length, drawerLedger };
  });

  console.log('\nApplied. New drawer account ' + NEW_CODE + ' = ' + receipt.newAccountId + ', ledger ' + money(receipt.drawerLedger) + '.');
  console.log('Re-coded ' + receipt.recodedPayments + ' payment(s). Adjusting entries: ' + (receipt.entries.map((e: any) => e.entryNumber).join(', ') || 'none'));
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
