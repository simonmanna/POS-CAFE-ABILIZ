/**
 * Approved correction tool: reverse ONE posted journal entry through
 * PostingService (the only GL writer). The original stays untouched; a linked
 * reversal entry is posted and an audit event records who, why and the
 * before/after balances of every affected account.
 *
 *   ts-node src/scripts/reverse-journal-entry.ts --org <id> --entry <entryNumber|id> --reason "<why>" [--actor <userId>] [--apply]
 *
 * Dry run by default. Refuses draft or already-reversed entries and entries that
 * are themselves reversals.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../kernel/prisma/prisma.service';
import { TenantContextService } from '../kernel/tenancy/tenant-context.service';
import { AuditService } from '../kernel/audit/audit.service';
import { PostingService } from '../modules/accounting/posting/posting.service';
import { dec } from '../kernel/common/money';

const arg = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const APPLY = process.argv.includes('--apply');

async function main() {
  const organizationId = arg('--org');
  const entryRef = arg('--entry');
  const reason = arg('--reason')?.trim();
  if (!organizationId || !entryRef || !reason) throw new Error('Usage: --org <id> --entry <entryNumber|id> --reason "<why>" [--actor <userId>] [--apply]');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const tenant = app.get(TenantContextService);
    const posting = app.get(PostingService);
    const audit = app.get(AuditService);
    const actorId = arg('--actor') ?? null;

    await tenant.run({ organizationId, userId: actorId ?? undefined } as any, async () => {
      const entry = await prisma.client.journalEntry.findFirst({
        where: { organizationId, OR: [{ id: entryRef }, { entryNumber: entryRef }] },
        include: { lines: { include: { account: { select: { code: true, name: true } } } } },
      });
      if (!entry) throw new Error(`Journal entry ${entryRef} not found in organization ${organizationId}`);
      if (entry.status !== 'posted') throw new Error(`Entry ${entry.entryNumber} is ${entry.status}; only a posted entry can be reversed`);
      if (entry.reversalOfId) throw new Error(`Entry ${entry.entryNumber} is itself a reversal`);

      const balance = async (accountId: string) => {
        const t = await prisma.client.journalLine.aggregate({
          where: { organizationId, accountId, entry: { status: { in: ['posted', 'reversed'] } } },
          _sum: { baseDebit: true, baseCredit: true },
        });
        return dec(t._sum.baseDebit ?? 0).minus(t._sum.baseCredit ?? 0);
      };
      const accounts = [...new Map(entry.lines.map((l: any) => [l.accountId, l.account])).entries()];
      const impact: Array<{ account: string; before: string; after: string }> = [];
      for (const [accountId, account] of accounts) {
        const before = await balance(accountId);
        const net = entry.lines.filter((l: any) => l.accountId === accountId).reduce((s: any, l: any) => s.plus(dec(l.baseDebit).minus(l.baseCredit)), dec(0));
        impact.push({ account: `${(account as any).code} ${(account as any).name}`, before: before.toFixed(2), after: before.minus(net).toFixed(2) });
      }
      console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'DRY_RUN', entry: entry.entryNumber, description: entry.description, sourceType: entry.sourceType, reason, impact }, null, 2));
      if (!APPLY) return;

      const reversal = await prisma.client.$transaction(async (tx: any) => {
        const rev = await posting.reverse(entry.id, { description: `Correction of ${entry.entryNumber}: ${reason}` }, tx);
        await audit.recordInTx(tx, {
          entity: 'JournalEntry', entityId: entry.id, action: 'update' as any,
          newValues: { kind: 'approved_correction_reversal', reversalEntryId: rev.id, reason, impact, actorId },
        });
        return rev;
      });
      console.log(JSON.stringify({ reversed: entry.entryNumber, reversalEntry: reversal.entryNumber }, null, 2));
    });
  } finally {
    await app.close();
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
