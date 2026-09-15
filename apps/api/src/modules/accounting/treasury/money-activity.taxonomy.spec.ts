import { categoryOf, classifyMoneyEntry, effectiveSourceType, type MoneyLineInput } from './money-activity.taxonomy';

const line = (accountId: string, debit: number, credit = 0): MoneyLineInput => ({
  accountId,
  accountName: accountId,
  accountType: null,
  baseDebit: debit,
  baseCredit: credit,
});

describe('money activity taxonomy', () => {
  it('cash POS sale is money in', () => {
    const a = classifyMoneyEntry('pos_invoice', [line('drawer', 35000)]);
    expect(a).toMatchObject({ category: 'pos_sales', direction: 'in', externalIn: '35000.00', externalOut: '0.00', internalMoved: '0.00' });
  });

  it('split-tender POS sale is one activity with three legs', () => {
    const a = classifyMoneyEntry('pos_invoice', [line('drawer', 30000), line('mtn', 40000), line('card', 30000)]);
    expect(a.direction).toBe('in');
    expect(a.grossAmount).toBe('100000.00');
    expect(a.externalIn).toBe('100000.00');
    expect(a.legs.map((l) => [l.accountId, l.side, l.amount])).toEqual([
      ['mtn', 'in', '40000.00'],
      ['drawer', 'in', '30000.00'],
      ['card', 'in', '30000.00'],
    ]);
  });

  it('refund is money out', () => {
    expect(classifyMoneyEntry('pos_refund', [line('drawer', 0, 5000)])).toMatchObject({ category: 'refunds', direction: 'out', externalOut: '5000.00' });
  });

  it('customer receipt is money in', () => {
    expect(classifyMoneyEntry('payment', [line('bank', 80000)])).toMatchObject({ category: 'customer_receipts', direction: 'in' });
  });

  it.each([
    ['purchase_payment', 'supplier_payments'],
    ['expense_payment', 'expenses'],
    ['payroll_run', 'payroll'],
    ['cash_flow_withdrawal', 'withdrawals'],
  ])('%s is money out (never defaulted to deposit)', (sourceType, category) => {
    expect(classifyMoneyEntry(sourceType, [line('bank', 0, 500000)])).toMatchObject({ category, direction: 'out', externalOut: '500000.00', externalIn: '0.00' });
  });

  it('deposit is money in', () => {
    expect(classifyMoneyEntry('cash_flow_deposit', [line('bank', 1000000)])).toMatchObject({ category: 'deposits', direction: 'in' });
  });

  it('transfer is internal, one activity, two legs, no external money', () => {
    const a = classifyMoneyEntry('treasury_transfer', [line('mtn', 0, 300000), line('stanbic', 300000)]);
    expect(a).toMatchObject({ category: 'transfers', direction: 'internal', internalMoved: '300000.00', externalIn: '0.00', externalOut: '0.00' });
    expect(a.legs).toHaveLength(2);
  });

  it('settlement fee is external out; the rest is internal', () => {
    const a = classifyMoneyEntry('tender_settlement', [line('card_clearing', 0, 100000), line('bank', 98000)]);
    expect(a).toMatchObject({
      category: 'tender_settlement',
      direction: 'internal',
      grossAmount: '100000.00',
      internalMoved: '98000.00',
      externalOut: '2000.00',
      externalIn: '0.00',
    });
  });

  it('shift banking is internal and categorised as cash drawer', () => {
    expect(classifyMoneyEntry('cash_session_banking', [line('drawer', 0, 400000), line('bank', 400000)]))
      .toMatchObject({ category: 'cash_drawer', direction: 'internal', internalMoved: '400000.00' });
  });

  it('drawer pay-out to an expense is money out', () => {
    expect(classifyMoneyEntry('cash_movement', [line('drawer', 0, 20000)])).toMatchObject({ category: 'cash_drawer', direction: 'out' });
  });

  it('register variance is an adjustment that still reports its money effect', () => {
    expect(classifyMoneyEntry('cash_session_variance', [line('drawer', 0, 15000)]))
      .toMatchObject({ category: 'cash_drawer', direction: 'adjustment', externalOut: '15000.00' });
  });

  it('reversal is an adjustment', () => {
    expect(classifyMoneyEntry('reversal', [line('bank', 500000)])).toMatchObject({ category: 'adjustments', direction: 'adjustment', externalIn: '500000.00' });
  });

  it('unknown and missing source types fall into other with a derived direction', () => {
    expect(classifyMoneyEntry('something_new', [line('bank', 0, 700)])).toMatchObject({ category: 'other', categoryLabel: 'Other', direction: 'out' });
    expect(categoryOf(null)).toBe('other');
  });

  it('nets an account debited and credited in the same entry into one leg', () => {
    const a = classifyMoneyEntry('manual', [line('bank', 1000), line('bank', 0, 400)]);
    expect(a.legs).toEqual([expect.objectContaining({ accountId: 'bank', side: 'in', amount: '600.00' })]);
  });

  it('refines generic payment entries by the payment behind them', () => {
    expect(categoryOf(effectiveSourceType('payment', { cashSessionId: 's1', direction: 'inbound' }))).toBe('pos_sales');
    expect(categoryOf(effectiveSourceType('payment', { cashSessionId: 's1', direction: 'outbound' }))).toBe('refunds');
    expect(categoryOf(effectiveSourceType('payment', { cashSessionId: null, direction: 'outbound' }))).toBe('supplier_payments');
    expect(categoryOf(effectiveSourceType('payment', { cashSessionId: null, direction: 'inbound' }))).toBe('customer_receipts');
    expect(categoryOf(effectiveSourceType('payment', null))).toBe('customer_receipts');
    expect(effectiveSourceType('treasury_transfer', { cashSessionId: 's1', direction: 'inbound' })).toBe('treasury_transfer');
  });
});
