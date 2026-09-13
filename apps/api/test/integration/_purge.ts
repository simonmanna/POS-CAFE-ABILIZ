/**
 * Test-fixture teardown for append-only financial evidence.
 *
 * Posted journals, drawer movements, closed shifts, payments and Z snapshots are
 * protected by database triggers (migration 20260913100000). Fixtures are the
 * only legitimate place to hard-delete them, and they must say so explicitly:
 * the flag is transaction-local and never set by application code.
 *
 *   await purge(prisma, (tx) => tx.journalEntry.deleteMany({ where: { organizationId } }));
 */
export function purge(prisma: any, operation: (tx: any) => Promise<unknown>): Promise<unknown> {
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.evidence_purge = 'on'`);
    return operation(tx);
  });
}
