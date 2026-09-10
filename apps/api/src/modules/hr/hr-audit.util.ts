import type { AuditService } from '../../kernel/audit/audit.service';
import type { PrismaService } from '../../kernel/prisma/prisma.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

type AuditEntry = Parameters<AuditService['recordInTx']>[1];

/**
 * Run a write and its audit entry inside one transaction.
 *
 * Every HR service injected AuditService and then never called it — the whole
 * module wrote employees, leave, payroll and advances with no audit trail at
 * all. Most of those writes are single statements, so wrapping each one by hand
 * would have meant repeating the same seven lines of transaction boilerplate
 * dozens of times and inviting someone to skip it.
 *
 * `recordInTx` throws on failure, which rolls the business write back with it —
 * that is the intended contract (see AuditService): an unaudited HR mutation is
 * worse than a failed one.
 */
export async function writeAudited<T>(
  prisma: PrismaService,
  audit: AuditService,
  write: (tx: any) => Promise<T>,
  // `any` rather than `T`: the transaction client is untyped here (as it is
  // throughout these services), so T infers as `unknown` and every field read
  // in the entry builder would need a cast.
  entry: (result: any) => AuditEntry,
): Promise<T> {
  return prisma.client.$transaction(async (tx: any) => {
    const result = await write(tx);
    await audit.recordInTx(tx, entry(result));
    return result;
  });
}
