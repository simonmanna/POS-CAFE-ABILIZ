/* eslint-disable @typescript-eslint/no-explicit-any */
import { PosPaymentMethodService } from './pos-payment-method.service';
import { ALLOWED_CATEGORIES_BY_METHOD } from './tender-account';

/**
 * The account a POS payment method is bound to must satisfy the SAME category
 * rule `resolveTenderAccount` enforces at posting time. If these drift, a tile
 * saves happily in finance and then fails at the till mid-sale — so the two
 * read one exported map, and these tests pin the pairings that matter.
 */
describe('PosPaymentMethodService account binding', () => {
  const ACCOUNTS: Record<string, any> = {
    'acct-wallet': { id: 'acct-wallet', name: 'Mobile Money — MTN', code: '1121', category: { key: 'mobile_money' } },
    'acct-bank': { id: 'acct-bank', name: 'Bank — Stanbic', code: '1102', category: { key: 'bank' } },
    'acct-clearing': { id: 'acct-clearing', name: 'Card Clearing', code: '1131', category: { key: 'current_asset' } },
    'acct-other-asset': { id: 'acct-other-asset', name: 'Prepayments', code: '1301', category: { key: 'current_asset' } },
  };

  let prisma: any;
  let svc: PosPaymentMethodService;

  beforeEach(() => {
    prisma = {
      client: {
        account: { findFirst: jest.fn(async ({ where }: any) => ACCOUNTS[where.id] ?? null) },
        // Only acct-clearing is the configured card clearing account.
        accountMapping: { findFirst: jest.fn(async () => ({ key: 'card_clearing', accountId: 'acct-clearing' })) },
        posPaymentMethod: {
          findFirst: jest.fn(async () => null),
          count: jest.fn(async () => 1),
          create: jest.fn(async ({ data }: any) => ({ ...data, id: 'new-1', account: ACCOUNTS[data.accountId] ?? null })),
        },
      },
    };
    svc = new PosPaymentMethodService(prisma as any, { organizationId: 'org-1' } as any);
  });

  const create = (over: Record<string, any>) =>
    svc.create({ code: 'm1', label: 'Method', kind: 'mobile_money', ...over });

  it('accepts a mobile-money method on a mobile_money account', async () => {
    const row = await create({ accountId: 'acct-wallet' });
    expect(row.accountId).toBe('acct-wallet');
    expect(row.kind).toBe('mobile_money');
  });

  it('rejects a mobile-money method pointed at a bank account', async () => {
    await expect(create({ accountId: 'acct-bank' })).rejects.toThrow(/not a mobile money account/i);
    expect(prisma.client.posPaymentMethod.create).not.toHaveBeenCalled();
  });

  it('rejects a card method on a current asset that is not the clearing account', async () => {
    await expect(create({ kind: 'card', accountId: 'acct-other-asset' }))
      .rejects.toThrow(/card_clearing/i);
  });

  it('accepts a card method on the configured clearing account', async () => {
    const row = await create({ kind: 'card', accountId: 'acct-clearing' });
    expect(row.accountId).toBe('acct-clearing');
  });

  it('accepts a cash method with no account and never tracks it as a wallet', async () => {
    // Cash books to the register's own drawer account, decided at post time.
    const row = await create({ kind: 'cash', accountId: 'acct-wallet', trackInShift: true });
    expect(row.accountId).toBeNull();
    expect(row.trackInShift).toBe(false);
  });

  it('refuses a non-cash method with no account', async () => {
    await expect(create({ kind: 'bank', accountId: undefined })).rejects.toThrow(/needs a receiving account/i);
  });

  it('rejects an unknown kind', async () => {
    await expect(create({ kind: 'crypto', accountId: 'acct-wallet' })).rejects.toThrow(/Payment kind must be one of/i);
  });

  it('rejects a duplicate code', async () => {
    prisma.client.posPaymentMethod.findFirst.mockResolvedValueOnce({ id: 'existing' });
    await expect(create({ accountId: 'acct-wallet' })).rejects.toThrow(/already exists/i);
  });

  it('binds every kind it offers to a category the posting engine accepts', () => {
    // Regression fence: a new kind added to the tiles without a posting rule
    // would silently accept any account.
    for (const kind of ['cash', 'mobile_money', 'card', 'bank', 'store_credit']) {
      expect(ALLOWED_CATEGORIES_BY_METHOD[kind]?.length).toBeGreaterThan(0);
    }
  });
});
