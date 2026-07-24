import { Prisma } from '@prisma/client';
import { StockPostingService } from './stock-posting.service';

/**
 * Focused unit test for the returns COGS-reversal leg. postReturnRestock is the
 * structural inverse of postIssue: it must debit Stock Valuation and credit COGS
 * by the same amount (so the entry balances) and skip the GL entirely when the
 * restocked cost is zero/negative (mirrors postIssue's zero-cost guard).
 */
describe('StockPostingService.postReturnRestock', () => {
  function makeSvc() {
    const posting = { post: jest.fn().mockResolvedValue({ id: 'je1' }) };
    const ruleService = {
      resolve: jest.fn().mockRejectedValue(new Error('No posting rule configured')),
    };
    const determination = {
      mapped: jest.fn(async (key: string) =>
        key === 'cogs' ? 'acc-cogs' : key === 'stock_valuation' ? 'acc-stockval' : `acc-${key}`,
      ),
    };
    const svc = new StockPostingService(
      {} as any, // prisma
      {} as any, // tenant
      {} as any, // events
      posting as any,
      determination as any,
      {} as any, // costResolver
      ruleService as any,
    );
    return { svc, posting };
  }

  const tx = { product: { findFirst: jest.fn().mockResolvedValue({ name: 'Coffee' }) } };

  it('posts a balanced Dr Stock Valuation / Cr COGS at the supplied cost', async () => {
    const { svc, posting } = makeSvc();
    await svc.postReturnRestock({
      productId: 'p1',
      totalValue: new Prisma.Decimal('150'),
      date: new Date('2026-07-23'),
      sourceType: 'pos_refund',
      sourceId: 'inv1',
      tx: tx as any,
    });

    expect(posting.post).toHaveBeenCalledTimes(1);
    const arg = posting.post.mock.calls[0][0];
    expect(arg.journalCode).toBe('INV');
    const debit = arg.lines.find((l: any) => l.debit);
    const credit = arg.lines.find((l: any) => l.credit);
    expect(debit.accountId).toBe('acc-stockval');
    expect(credit.accountId).toBe('acc-cogs');
    // Balanced: the debit and credit legs are equal.
    expect(Number(debit.debit)).toBe(150);
    expect(Number(credit.credit)).toBe(150);
  });

  it('skips the GL when the restocked cost is zero', async () => {
    const { svc, posting } = makeSvc();
    await svc.postReturnRestock({
      productId: 'p1',
      totalValue: new Prisma.Decimal('0'),
      date: new Date(),
      sourceType: 'pos_refund',
      sourceId: 'inv1',
      tx: tx as any,
    });
    expect(posting.post).not.toHaveBeenCalled();
  });

  it('skips the GL for a negative cost (never posts a reversed entry)', async () => {
    const { svc, posting } = makeSvc();
    await svc.postReturnRestock({
      productId: 'p1',
      totalValue: new Prisma.Decimal('-5'),
      date: new Date(),
      sourceType: 'pos_refund',
      sourceId: 'inv1',
      tx: tx as any,
    });
    expect(posting.post).not.toHaveBeenCalled();
  });
});
