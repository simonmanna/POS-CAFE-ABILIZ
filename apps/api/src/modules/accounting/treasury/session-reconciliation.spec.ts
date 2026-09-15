import { openingObservation, sessionProviderExpectations } from './session-reconciliation';

/**
 * The shift-close provider expectation is the one number the dialog shows and
 * the close validates against. These pin the formula without a database.
 */
describe('sessionProviderExpectations', () => {
  const org = 'org-1';
  const momo = 'acc-momo';
  const bank = 'acc-bank';

  function txWith(rows: { payments?: any[]; settlements?: any[]; movements?: any[] }) {
    return {
      payment: { findMany: jest.fn(async ({ where }: any) => (rows.payments ?? []).filter((p) => where.accountId.in.includes(p.accountId))) },
      tenderSettlement: { findMany: jest.fn(async () => rows.settlements ?? []) },
      cashMovement: { findMany: jest.fn(async ({ where }: any) => (rows.movements ?? []).filter((m) => !m.paymentId && where.counterpartAccountId.in.includes(m.counterpartAccountId))) },
    };
  }

  it('ignores earlier shifts: no opening recorded, receipts only', async () => {
    const tx = txWith({ payments: [{ accountId: momo, amount: '10000', direction: 'inbound' }] });
    const out = await sessionProviderExpectations(tx, org, { id: 's1', openingAccounts: {} }, [momo]);
    expect(out[momo]).toMatchObject({ opening: '0', openingKnown: false, receipts: '10000', expected: '10000' });
  });

  it('adds a recorded opening observation (object or legacy number)', async () => {
    const tx = txWith({ payments: [{ accountId: momo, amount: '10000', direction: 'inbound' }] });
    const out = await sessionProviderExpectations(tx, org, { id: 's1', openingAccounts: { [momo]: { observed: '50000', ledger: '50000' } } }, [momo]);
    expect(out[momo].expected).toBe('60000');
    expect(openingObservation({ openingAccounts: { [momo]: 20000 } }, momo)).toEqual({ opening: expect.anything(), openingKnown: true });
  });

  it('subtracts refunds (net of withholding) and settlements out; adds settlements in net of fee', async () => {
    const tx = txWith({
      payments: [
        { accountId: momo, amount: '10000', direction: 'inbound' },
        { accountId: momo, amount: '2000', direction: 'outbound' },
        { accountId: bank, amount: '1000', withholdingAmount: '60', direction: 'outbound' },
      ],
      settlements: [{ sourceAccountId: momo, destinationAccountId: bank, grossAmount: '5000', feeAmount: '100' }],
    });
    const out = await sessionProviderExpectations(tx, org, { id: 's1', openingAccounts: { [momo]: { observed: '50000' } } }, [momo, bank]);
    expect(out[momo]).toMatchObject({ refunds: '2000', settledOut: '5000', expected: '53000' });
    expect(out[bank]).toMatchObject({ refunds: '940', settledIn: '4900', expected: '3960' });
  });

  it('mirrors drawer movements whose counterpart is the account, and skips payment-linked ones', async () => {
    const tx = txWith({
      movements: [
        { counterpartAccountId: bank, movementType: 'pay_out', amount: '30000' }, // drawer → bank deposit
        { counterpartAccountId: bank, movementType: 'pay_in', amount: '5000' }, // bank → drawer float
        { counterpartAccountId: bank, movementType: 'adjustment', amount: '-1000' },
        { counterpartAccountId: bank, movementType: 'sale', amount: '999', paymentId: 'p1' },
      ],
    });
    const out = await sessionProviderExpectations(tx, org, { id: 's1' }, [bank]);
    expect(out[bank]).toMatchObject({ movementsIn: '31000', movementsOut: '5000', expected: '26000' });
  });

  it('returns an opening-only row for an untouched account', async () => {
    const out = await sessionProviderExpectations(txWith({}), org, { id: 's1', openingAccounts: { [momo]: { observed: '20000' } } }, [momo]);
    expect(out[momo]).toMatchObject({ openingKnown: true, expected: '20000' });
  });
});
