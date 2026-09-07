/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException } from '@nestjs/common';
import { PostingService } from './posting.service';
import { AccountResolverService } from './account-resolver.service';

/**
 * N-1 unit guards: the close → reopen → close cycle.
 *
 * 1. A postingKey replay must only ever return a POSTED entry — a REVERSED
 *    entry (e.g. a period-closing journal reversed by reopen) is not a replay.
 * 2. doReverse must suffix the original's postingKey (`{key}:rev:{reversalId}`)
 *    so the canonical key slot is freed for a re-post (the @@unique index
 *    would otherwise reject the re-close insert).
 *
 * These tests stub the transaction client and drive the real PostingService
 * logic; no database required.
 */

const ENTRY = {
  id: 'je-1',
  organizationId: 'org-1',
  journalId: 'j-1',
  entryNumber: 'CLOSING/2026/00001',
  postingDate: new Date('2026-08-31T00:00:00Z'),
  status: 'posted',
  postingKey: 'period_close:p-1',
  sourceType: 'period_close',
  sourceId: 'p-1',
  lines: [
    { id: 'l-1', accountId: 'a-revenue', debit: '0', credit: '100', baseDebit: '0', baseCredit: '100' },
    { id: 'l-2', accountId: 'a-re', debit: '100', credit: '0', baseDebit: '100', baseCredit: '0' },
  ],
};

const REVERSED_ENTRY = { ...ENTRY, status: 'reversed', reversedEntryId: 'je-2' };

function makeClient(rows: { journalEntry: any[]; account?: any[]; journal?: any[]; organization?: any[] }) {
  return {
    journalEntry: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.postingKey && !where.id) {
          // postingKey replay lookup
          const match = rows.journalEntry.find(
            (e) => e.postingKey === where.postingKey && (!where.status || e.status === where.status),
          );
          // include: { lines: true } — return with lines
          return match ? { ...match, lines: ENTRY.lines } : null;
        }
        const byId = where.id ? rows.journalEntry.find((e) => e.id === where.id) : undefined;
        return byId ? { ...byId, lines: ENTRY.lines, journal: { code: 'CLOSING' } } : null;
      }),
      create: jest.fn(async ({ data }: any) => ({
        id: 'je-new',
        ...data,
        lines: (data.lines?.create ?? []).map((l: any, i: number) => ({ ...l, lineNumber: i + 1 })),
      })),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const target = rows.journalEntry.find((e) => e.id === where.id);
        if (target) Object.assign(target, data);
        return { count: target ? 1 : 0 };
      }),
    },
    account: {
      findMany: jest.fn(async () =>
        (rows.account ?? [
          { id: 'a-revenue', code: '4100', isActive: true, isPostable: true, category: null },
          { id: 'a-re', code: '3100', isActive: true, isPostable: true, category: null },
        ]).map((a) => ({ ...a, category: null })),
      ),
    },
    journal: {
      findFirst: jest.fn(async () => rows.journal?.[0] ?? { id: 'j-1', code: 'CLOSING' }),
    },
    organization: {
      findUnique: jest.fn(async () => ({ currencyCode: 'UGX', booksLockDate: null })),
    },
    fiscalPeriod: {
      findFirst: jest.fn(async () => null),
    },
  };
}

function makeService(client: any) {
  const tenant: any = { organizationId: 'org-1', userId: 'user-1' };
  const posting = new PostingService(
    { client: { $transaction: async (fn: any) => fn(client) } } as any, // prisma
    tenant,
    { publish: jest.fn(() => undefined) } as any, // events (fire-and-forget)
    {} as any, // sequence — replaced below
    { assertOpen: jest.fn(async () => undefined) } as any, // fiscalPeriod
    {} as any, // currency
    { assertPostable: jest.fn() } as unknown as AccountResolverService,
  );
  (posting as any).sequence = {
    next: jest.fn(async () => 'CLOSING/2026/00002'),
  };
  (posting as any).applyRounding = jest.fn(async () => undefined);
  return posting;
}

describe('PostingService N-1: close → reopen → close cycle', () => {
  it('does NOT replay a reversed entry when re-posting the same postingKey', async () => {
    const client = makeClient({ journalEntry: [REVERSED_ENTRY] });
    const posting = makeService(client);

    const entry = await posting.post({
      journalCode: 'CLOSING',
      date: '2026-08-31',
      lines: [
        { accountId: 'a-revenue', credit: '100' },
        { accountId: 'a-re', debit: '100' },
      ],
      postingKey: 'period_close:p-1',
      sourceType: 'period_close',
      sourceId: 'p-1',
    } as any);

    // A fresh entry must be created — NOT the reversed original returned.
    expect((entry as any).id).toBe('je-new');
    expect(client.journalEntry.create).toHaveBeenCalled();
    // And the replay lookup must have filtered on status.
    const calls = client.journalEntry.findFirst.mock.calls as any[];
    const replayCall = calls.find((c) => c[0].where?.postingKey === 'period_close:p-1');
    expect(replayCall[0].where.status).toBe('posted');
  });

  it('still replays a POSTED entry with the same postingKey (idempotency preserved)', async () => {
    const client = makeClient({ journalEntry: [{ ...ENTRY }] });
    const posting = makeService(client);

    const entry = await posting.post({
      journalCode: 'CLOSING',
      date: '2026-08-31',
      lines: [
        { accountId: 'a-revenue', credit: '100' },
        { accountId: 'a-re', debit: '100' },
      ],
      postingKey: 'period_close:p-1',
    } as any);

    expect((entry as any).id).toBe('je-1');
    expect(client.journalEntry.create).not.toHaveBeenCalled();
  });

  it('suffixes the original postingKey on reversal so the canonical slot is freed', async () => {
    const client = makeClient({ journalEntry: [{ ...ENTRY }] });
    const posting = makeService(client);

    await posting.reverse('je-1', { description: 'Reopen P1' });

    const updates = client.journalEntry.updateMany.mock.calls as any[];
    const keyUpdate = updates.find((c) => c[0].data?.postingKey);
    expect(keyUpdate).toBeDefined();
    expect(keyUpdate[0].data.postingKey).toMatch(/^period_close:p-1:rev:je-new$/);
    // ...and the status flip happened too
    const statusUpdate = updates.find((c) => c[0].data?.status === 'reversed');
    expect(statusUpdate).toBeDefined();
  });

  it('leaves keyless entries untouched on reversal (no spurious writes)', async () => {
    const client = makeClient({ journalEntry: [{ ...ENTRY, postingKey: null }] });
    const posting = makeService(client);

    await posting.reverse('je-1', {});

    const updates = client.journalEntry.updateMany.mock.calls as any[];
    expect(updates.filter((c) => c[0].data?.postingKey)).toHaveLength(0);
  });

  it('still requires at least two lines (baseline guard, unchanged)', async () => {
    const posting = makeService(makeClient({ journalEntry: [] }));
    await expect(
      posting.post({ journalCode: 'CLOSING', date: '2026-08-31', lines: [{ accountId: 'a', debit: 1 }] } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
