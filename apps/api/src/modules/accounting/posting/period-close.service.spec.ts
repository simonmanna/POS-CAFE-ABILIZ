/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException } from '@nestjs/common';
import { PeriodCloseService } from './period-close.service';

/**
 * N-2 unit guards: reopen semantics.
 *
 *  - LOCKED is the year-end hard lock: reopen must refuse it (403-class guard
 *    before any writes) — silently flipping a hard lock is exactly the control
 *    hole the audit flagged.
 *  - OPEN is an idempotent no-op: no closing-entry reversal, no audit noise.
 *  - CLOSED is the only genuinely re-openable state (full path tested live in
 *    the golden matrix AC-026b/AC-027b).
 */

function makeCtx(period: any) {
  const writes: any[] = [];
  const tx = {
    $queryRawUnsafe: jest.fn(async () => []),
    fiscalPeriod: {
      findFirst: jest.fn(async () => period),
      updateMany: jest.fn(async (args: any) => {
        writes.push(args);
        return { count: 1 };
      }),
    },
    // close() preconditions — not reached by these guards
    cashSession: { count: jest.fn(async () => 0) },
    stockPostingJob: { count: jest.fn(async () => 0) },
    stockOut: { count: jest.fn(async () => 0) },
    wasteRecord: { count: jest.fn(async () => 0) },
    stockAdjustment: { count: jest.fn(async () => 0) },
    stockTransfer: { count: jest.fn(async () => 0) },
    journalLine: { groupBy: jest.fn(async () => []) },
    journal: { findFirst: jest.fn(async () => ({ id: 'j-1', code: 'CLOSING' })) },
    journalEntry: {
      findFirst: jest.fn(async (): Promise<any> => null),
    },
  };
  const svc: any = new PeriodCloseService(
    { client: { $transaction: async (fn: any) => fn(tx) } } as any, // prisma
    { organizationId: 'org-1', userId: 'admin-1' } as any, // tenant
    { publish: jest.fn() } as any, // events
    { recordInTx: jest.fn(async () => undefined) } as any, // audit
    {
      post: jest.fn(async () => ({ id: 'je-close' })),
      reverse: jest.fn(async () => ({ id: 'je-rev' })),
    } as any, // posting
    { mapped: jest.fn(async () => 'a-re') } as any, // determination
    { meta: jest.fn(async () => new Map()) } as any, // accounts
  );
  return { svc, tx, writes };
}

describe('PeriodCloseService.reopen — N-2 guards', () => {
  it('refuses to reopen a LOCKED period (year-end hard lock)', async () => {
    const { svc, tx } = makeCtx({ id: 'p-1', name: '2026-H1', status: 'locked', startDate: new Date(), endDate: new Date() });
    await expect(svc.reopen('p-1')).rejects.toThrow(/locked; a locked period cannot be reopened/i);
    expect(tx.fiscalPeriod.updateMany).not.toHaveBeenCalled();
  });

  it('treats an OPEN period as an idempotent no-op (no writes, no reversal)', async () => {
    const { svc, tx } = makeCtx({ id: 'p-1', name: '2026-H1', status: 'open', startDate: new Date(), endDate: new Date() });
    const result = await svc.reopen('p-1');
    expect(result).toEqual({ reopened: true });
    expect(tx.fiscalPeriod.updateMany).not.toHaveBeenCalled();
    expect(tx.journalEntry.findFirst).not.toHaveBeenCalled();
  });

  it('reverses the closing entry and flips a CLOSED period to open', async () => {
    const closing = { id: 'je-close', status: 'posted' };
    const { svc, tx } = makeCtx({ id: 'p-1', name: '2026-H1', status: 'closed', startDate: new Date(), endDate: new Date(), closedAt: new Date() });
    tx.journalEntry.findFirst.mockImplementation(async (): Promise<any> => closing);

    const result = await svc.reopen('p-1');
    expect(result).toEqual({ reopened: true });
    // closing entry reversed BEFORE the status flip
    expect((svc as any).posting.reverse).toHaveBeenCalledWith('je-close', expect.anything(), expect.anything());
    expect(tx.fiscalPeriod.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p-1' }, data: expect.objectContaining({ status: 'open' }) }),
    );
  });

  it('close() still refuses a non-open period (baseline guard, unchanged)', async () => {
    const { svc } = makeCtx({ id: 'p-1', name: '2026-H1', status: 'closed', startDate: new Date(), endDate: new Date() });
    await expect(svc.close('p-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
