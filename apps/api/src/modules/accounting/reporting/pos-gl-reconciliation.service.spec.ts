/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from '@prisma/client';
import { PosGlReconciliationService } from './pos-gl-reconciliation.service';

/**
 * R-1 unit guards: refund-basis split in the POS → GL reconciliation.
 *
 * A tax-INCLUSIVE refund carries both a revenue portion and a tax portion. The
 * old code compared GL revenue against (subtotal − discounts − amountRefunded)
 * where amountRefunded MIXES both portions — producing a false +tax revenue
 * variance and a false −tax tax variance on every refunded tax-inclusive sale.
 *
 * These tests drive `reconcile()` against a stubbed Prisma client and assert
 * the exact variance math with the refund split from PosRefund.items.
 */

const D = (v: any) => new Prisma.Decimal(v ?? 0);

describe('PosGlReconciliationService R-1: refund-basis split', () => {
  function makeService(opts: {
    invoices?: any[];
    documents?: any[];
    refunds?: any[]; // PosRefund rows: { amount, items: [{subtotal, taxAmount}] }
    journalLines?: any[]; // rows joined to accounts via meta
    accounts?: Record<string, { reportSection: string; normalBalance: string }>;
    stockJobs?: any[];
    inventoryIssues?: { totalValue: any }[];
    inventoryReturns?: { totalValue: any }[];
    taxAccounts?: string[];
  }) {
    const accountMeta = new Map<string, any>();
    for (const [id, m] of Object.entries(opts.accounts ?? {})) accountMeta.set(id, m);

    const prisma: any = {
      client: {
        invoice: {
          aggregate: jest.fn(async () => {
            const rows = opts.invoices ?? [];
            const sum = (f: string) => D(rows.reduce((s: any, r: any) => s.plus(D(r[f])), D(0)));
            return {
              _sum: { subtotal: sum('subtotal'), taxAmount: sum('taxAmount'), discountTotal: sum('discountTotal'), totalAmount: sum('totalAmount') },
              _count: rows.length,
            };
          }),
        },
        document: {
          aggregate: jest.fn(async () => {
            const rows = opts.documents ?? [];
            const sum = (f: string) => D(rows.reduce((s: any, r: any) => s.plus(D(r[f])), D(0)));
            return {
              _sum: { subtotal: sum('subtotal'), taxAmount: sum('taxAmount'), discountTotal: sum('discountTotal'), totalAmount: sum('totalAmount') },
              _count: rows.length,
            };
          }),
        },
        stockPostingJob: {
          groupBy: jest.fn(async () => opts.stockJobs ?? [{ status: 'done', _count: 1 }]),
        },
        inventoryLedger: {
          aggregate: jest.fn(async (args: any) => {
            const rows = args?.where?.referenceType === 'pos_refund' ? opts.inventoryReturns : opts.inventoryIssues;
            return { _sum: { totalValue: D(rows?.reduce((s, i) => s.plus(D(i.totalValue)), D(0))) } };
          }),
        },
        tax: { findMany: jest.fn(async () => (opts.taxAccounts ?? []).map((accountId) => ({ accountId }))) },
        posRefund: {
          findMany: jest.fn(async () => opts.refunds ?? []),
        },
        journalLine: {
          groupBy: jest.fn(async () => {
            // group by accountId with base sums
            const byAcc = new Map<string, { baseDebit: any; baseCredit: any }>();
            for (const l of opts.journalLines ?? []) {
              const cur = byAcc.get(l.accountId) ?? { baseDebit: D(0), baseCredit: D(0) };
              byAcc.set(l.accountId, {
                baseDebit: cur.baseDebit.plus(D(l.baseDebit)),
                baseCredit: cur.baseCredit.plus(D(l.baseCredit)),
              });
            }
            return [...byAcc.entries()].map(([accountId, s]) => ({ accountId, _sum: s }));
          }),
        },
      },
    };
    const accounts: any = { meta: jest.fn(async (ids: string[]) => {
      const out = new Map<string, any>();
      for (const id of ids) {
        const m = accountMeta.get(id);
        if (m) out.set(id, { id, reportSection: m.reportSection, normalBalance: m.normalBalance, categoryId: 'c', classification: 'asset', isActive: true });
      }
      return out;
    }) };
    const tenant: any = { organizationId: 'org-1' };
    return { svc: new PosGlReconciliationService(prisma, tenant, accounts), prisma };
  }

  const ACCOUNTS = {
    'a-revenue': { reportSection: 'revenue', normalBalance: 'credit' },
    'a-tax': { reportSection: 'tax', normalBalance: 'credit' },
  };

  it('shows ZERO variance for a tax-inclusive sale + refund (the R-1 false positive)', async () => {
    // Sale: 118,000 gross inclusive of 18,000 tax; then fully refunded.
    // GL carries the sale entry + the refund reversal (net zero), and the
    // refund splits 100,000 revenue / 18,000 tax.
    const { svc } = makeService({
      invoices: [{ subtotal: D(100000), taxAmount: D(18000), discountTotal: D(0), totalAmount: D(118000) }],
      refunds: [{ amount: D(118000), items: [{ subtotal: '100000', taxAmount: '18000' }] }],
      journalLines: [
        // sale JE
        { accountId: 'a-revenue', baseDebit: D(0), baseCredit: D(100000) },
        { accountId: 'a-tax', baseDebit: D(0), baseCredit: D(18000) },
        // refund JE (debit side)
        { accountId: 'a-revenue', baseDebit: D(100000), baseCredit: D(0) },
        { accountId: 'a-tax', baseDebit: D(18000), baseCredit: D(0) },
      ],
      accounts: ACCOUNTS,
    });

    const r = await svc.reconcile({});
    expect(r.pos.refundedRevenue).toBe('100000');
    expect(r.pos.refundedTax).toBe('18000');
    expect(r.variance.revenueBalanced).toBe(true);
    expect(r.variance.taxBalanced).toBe(true);
    expect(r.variance.revenue).toBe('0');
    expect(r.variance.tax).toBe('0');
    expect(r.balanced).toBe(true);
  });

  it('detects a REAL revenue variance (missing posting)', async () => {
    const { svc } = makeService({
      invoices: [{ subtotal: D(100000), taxAmount: D(0), discountTotal: D(0), totalAmount: D(100000) }],
      journalLines: [], // nothing posted — variance must be -100000
      accounts: ACCOUNTS,
    });
    const r = await svc.reconcile({});
    expect(r.variance.revenueBalanced).toBe(false);
    expect(r.variance.revenue).toBe('-100000');
  });

  it('cross-window refund (sale outside, refund inside) yields a negative GL window that the POS side mirrors', async () => {
    // Refund created in-window of a sale issued before the window: GL shows
    // -100000 revenue / -18000 tax; POS side has no invoices but the refund
    // split — both sides must agree (zero variance).
    const { svc } = makeService({
      invoices: [],
      refunds: [{ amount: D(118000), items: [{ subtotal: '100000', taxAmount: '18000' }] }],
      journalLines: [
        { accountId: 'a-revenue', baseDebit: D(100000), baseCredit: D(0) },
        { accountId: 'a-tax', baseDebit: D(18000), baseCredit: D(0) },
      ],
      accounts: ACCOUNTS,
    });
    const r = await svc.reconcile({});
    expect(r.pos.expectedNetRevenue).toBe('-100000');
    expect(r.pos.expectedNetTax).toBe('-18000');
    expect(r.variance.revenueBalanced).toBe(true);
    expect(r.variance.taxBalanced).toBe(true);
  });

  it('partial refund splits proportionally (half of a 2-line invoice)', async () => {
    const { svc } = makeService({
      invoices: [{ subtotal: D(200000), taxAmount: D(36000), discountTotal: D(0), totalAmount: D(236000) }],
      refunds: [
        {
          amount: D(118000),
          items: [
            { subtotal: '60000', taxAmount: '10800' }, // line 1
            { subtotal: '40000', taxAmount: '7200' }, // line 2
          ],
        },
      ],
      journalLines: [
        { accountId: 'a-revenue', baseDebit: D(0), baseCredit: D(200000) },
        { accountId: 'a-tax', baseDebit: D(0), baseCredit: D(36000) },
        { accountId: 'a-revenue', baseDebit: D(100000), baseCredit: D(0) },
        { accountId: 'a-tax', baseDebit: D(18000), baseCredit: D(0) },
      ],
      accounts: ACCOUNTS,
    });
    const r = await svc.reconcile({});
    // Expected revenue: 200000 − 100000 refunded = 100000; GL net = 100000.
    expect(r.pos.refundedRevenue).toBe('100000');
    expect(r.variance.revenueBalanced).toBe(true);
    expect(r.variance.taxBalanced).toBe(true);
  });
});

describe('PosGlReconciliationService — simulation findings (D1-GL-002)', () => {
  // Reuse the R-1 factory through a thin re-declaration of its inputs.
  const { PosGlReconciliationService: Svc } = require('./pos-gl-reconciliation.service');
  const make = (o: any) => {
    const meta = new Map<string, any>(Object.entries(o.accounts ?? {}).map(([id, m]: any) => [id, { id, ...m }]));
    const group = (rows: any[]) => {
      const by = new Map<string, any>();
      for (const l of rows) { const c = by.get(l.accountId) ?? { baseDebit: D(0), baseCredit: D(0) }; by.set(l.accountId, { baseDebit: c.baseDebit.plus(D(l.baseDebit)), baseCredit: c.baseCredit.plus(D(l.baseCredit)) }); }
      return [...by].map(([accountId, s]) => ({ accountId, _sum: s }));
    };
    const agg = (rows: any[]) => ({ _sum: { subtotal: D(rows.reduce((s, r) => s.plus(D(r.subtotal)), D(0))), taxAmount: D(rows.reduce((s, r) => s.plus(D(r.taxAmount)), D(0))), discountTotal: D(rows.reduce((s, r) => s.plus(D(r.discountTotal)), D(0))), totalAmount: D(0) }, _count: { _all: rows.length } });
    const prisma: any = { client: {
      invoice: { aggregate: jest.fn(async () => agg(o.invoices ?? [])) },
      document: { aggregate: jest.fn(async () => agg([])) },
      stockPostingJob: { groupBy: jest.fn(async () => []) },
      inventoryLedger: { aggregate: jest.fn(async (a: any) => ({ _sum: { totalValue: D(a?.where?.referenceType === 'pos_refund' ? o.returns ?? 0 : o.issues ?? 0) } })) },
      posRefund: { findMany: jest.fn(async () => o.refunds ?? []) },
      tax: { findMany: jest.fn(async () => (o.taxAccounts ?? []).map((accountId: string) => ({ accountId }))) },
      journalLine: { groupBy: jest.fn(async () => group(o.lines ?? [])) },
    } };
    const accounts: any = { meta: jest.fn(async (ids: string[]) => new Map(ids.filter((i) => meta.has(i)).map((i) => [i, meta.get(i)]))) };
    return new Svc(prisma, { organizationId: 'org-1' } as any, accounts);
  };
  const ACC = {
    rev: { reportSection: 'revenue', normalBalance: 'credit' },
    vat: { reportSection: 'current_liabilities', normalBalance: 'credit' },
    cogs: { reportSection: 'cogs', normalBalance: 'debit' },
  };

  it('does not subtract discounts twice (subtotal is already net of discount)', async () => {
    const r = await make({ invoices: [{ subtotal: 180, taxAmount: 32.4, discountTotal: 20 }], lines: [{ accountId: 'rev', baseDebit: 0, baseCredit: 180 }], accounts: ACC }).reconcile({});
    expect(r.variance.revenue).toBe('0');
  });

  it('finds output VAT through the Tax row account even outside a "tax" report section', async () => {
    const r = await make({ invoices: [{ subtotal: 100, taxAmount: 18, discountTotal: 0 }], taxAccounts: ['vat'], lines: [{ accountId: 'rev', baseDebit: 0, baseCredit: 100 }, { accountId: 'vat', baseDebit: 0, baseCredit: 18 }], accounts: ACC }).reconcile({});
    expect(r.gl.tax).toBe('18');
    expect(r.variance.taxBalanced).toBe(true);
    expect(r.balanced).toBe(true);
  });

  it('nets refund restocks out of stock-side COGS and counts invoices as a number', async () => {
    const r = await make({ invoices: [{ subtotal: 0, taxAmount: 0, discountTotal: 0 }], issues: 83800, returns: 9080, lines: [{ accountId: 'cogs', baseDebit: 74720, baseCredit: 0 }], accounts: ACC }).reconcile({});
    expect(r.inventory.cogsBalanced).toBe(true);
    expect(r.pos.invoiceCount).toBe(1);
  });
});
