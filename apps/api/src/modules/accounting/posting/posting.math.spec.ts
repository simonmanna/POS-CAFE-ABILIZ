import { Prisma } from '@prisma/client';
import { isBalanced, normalizeLines, totals, validateLines } from './posting.math';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

describe('posting.math (double-entry rules)', () => {
  it('computes functional-currency (base) amounts via the exchange rate', () => {
    const lines = normalizeLines(
      [
        { accountId: 'a', debit: 100 },
        { accountId: 'b', credit: 100 },
      ],
      D(2),
    );
    expect(lines[0].baseDebit.toString()).toBe('200');
    expect(lines[1].baseCredit.toString()).toBe('200');
  });

  it('accepts a balanced entry', () => {
    const lines = normalizeLines(
      [
        { accountId: 'a', debit: 100 },
        { accountId: 'b', credit: 60 },
        { accountId: 'c', credit: 40 },
      ],
      D(1),
    );
    expect(isBalanced(lines)).toBe(true);
    expect(totals(lines).debit.toString()).toBe('100');
  });

  it('rejects an unbalanced entry', () => {
    const lines = normalizeLines(
      [
        { accountId: 'a', debit: 100 },
        { accountId: 'b', credit: 90 },
      ],
      D(1),
    );
    expect(isBalanced(lines)).toBe(false);
  });

  it('flags a line carrying both a debit and a credit', () => {
    const lines = normalizeLines([{ accountId: 'a', debit: 100, credit: 50 }], D(1));
    expect(validateLines(lines).length).toBeGreaterThan(0);
  });

  it('flags an empty line (no debit or credit)', () => {
    const lines = normalizeLines([{ accountId: 'a' }], D(1));
    expect(validateLines(lines).length).toBeGreaterThan(0);
  });
});
