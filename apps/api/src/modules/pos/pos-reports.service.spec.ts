/* eslint-disable @typescript-eslint/no-explicit-any */
import { PosReportsService, parseReportRange, posSaleWhere, localIso, POS_SALE_STATUSES } from './pos-reports.service';

function mockPrisma(): any {
  const prisma: any = {
    client: {
      cashSession: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      cashMovement: { findMany: jest.fn().mockResolvedValue([]) },
      invoice: { findMany: jest.fn().mockResolvedValue([]) },
      document: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      menuItem: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      partner: { findMany: jest.fn().mockResolvedValue([]) },
      posTable: { findMany: jest.fn().mockResolvedValue([]) },
      order: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      paymentAllocation: { findMany: jest.fn().mockResolvedValue([]) },
      posReportSnapshot: { upsert: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
      invoiceItem: { groupBy: jest.fn().mockResolvedValue([]) },
      documentLine: { groupBy: jest.fn().mockResolvedValue([]) },
    },
  };
  prisma.client.$transaction = (fn: any) => fn(prisma.client);
  Object.assign(prisma.client, {
    payment: { findMany: jest.fn().mockResolvedValue([{ id: 'pay-cash', paymentNumber: 'CASH', paymentMethod: 'cash', amount: 50, direction: 'inbound', allocations: [] }, { id: 'pay-card', paymentNumber: 'CARD', paymentMethod: 'card', amount: 59, direction: 'inbound', allocations: [] }]) },
    stockPostingJob: { count: jest.fn().mockResolvedValue(0) },
    cashRegister: { findFirst: jest.fn().mockResolvedValue({ name: 'Counter', defaultAccountId: 'cash' }) },
    journalEntry: { findFirst: jest.fn().mockResolvedValue(null) },
    journalLine: { aggregate: jest.fn().mockResolvedValue({ _sum: { debit: 170, credit: 0 } }) },
    account: { findFirst: jest.fn().mockResolvedValue(null) },
    tenderSettlement: { findMany: jest.fn().mockResolvedValue([]) },
    posRefund: { findMany: jest.fn().mockResolvedValue([]) },
  });
  prisma.client.user.findFirst = jest.fn().mockResolvedValue(null);
  prisma.client.product.findFirst = jest.fn().mockResolvedValue({ category: { id: 'c1', name: 'Drinks' } });
  return prisma;
}

describe('PosReportsService (financial accuracy)', () => {
  const orgId = 'org-1';
  let prisma: any;
  let svc: PosReportsService;

  beforeEach(() => {
    prisma = mockPrisma();
    const tenant = { organizationId: orgId, userId: 'u1' } as any;
    const audit = { record: jest.fn() } as any;
    const events = { publish: jest.fn() } as any;
    svc = new PosReportsService(prisma, tenant, audit, events);
  });

  describe('xReport', () => {
    beforeEach(() => {
      prisma.client.cashSession.findFirst.mockResolvedValue({
        id: 's1', cashRegisterId: 'r1', userId: 'u1', openedAt: new Date('2026-06-01T08:00:00Z'),
        openingFloat: '100', status: 'open',
      });
      prisma.client.cashMovement.findMany.mockResolvedValue([
        { movementType: 'sale', amount: '50' },   // cash sale into drawer
        { movementType: 'pay_in', amount: '20' },
      ]);
      prisma.client.invoice.findMany.mockResolvedValue([
        { status: 'paid', totalAmount: '118', subtotal: '100', taxAmount: '18', discountTotal: '0', paymentMode: 'cash', items: [{ productId: 'p1', quantity: '1', total: '118' }] },
        { status: 'paid', totalAmount: '59', subtotal: '50', taxAmount: '9', discountTotal: '0', paymentMode: 'card', items: [{ productId: 'p1', quantity: '1', total: '59' }] },
        { status: 'refunded', totalAmount: '10', subtotal: '8', taxAmount: '2', discountTotal: '0', paymentMode: 'cash', items: [] },
      ]);
      prisma.client.product.findMany.mockResolvedValue([
        { id: 'p1', name: 'Coffee', category: { id: 'c1', name: 'Drinks' } },
      ]);
    });

    it('counts ALL tenders as sales (card sales are not invisible)', async () => {
      const r = await svc.xReport('s1');
      const methods = r.byMethod.map((m) => m.method).sort();
      expect(methods).toEqual(['card', 'cash']); // card present → not cash-only
      expect(r.totals.saleCount).toBe(3); // Refunds remain separate events; sales do not disappear
    });

    it('reports net revenue ex-tax, gross, tax and discounts', async () => {
      const r = await svc.xReport('s1');
      expect(r.totals.netRevenue).toBe('158');  // original sales net of tax, refunds are a separate event
      expect(r.totals.grossSales).toBe('187');  // all original invoices including the subsequently refunded sale
      expect(r.totals.taxTotal).toBe('29');     // original tax before separately reported refunds
    });

    it('derives expected cash from the drawer, not from card sales', async () => {
      const r = await svc.xReport('s1');
      // opening 100 + cash collected 50 − cash refunds 0 + pay-ins 20 − pay-outs 0
      expect(r.totals.cashCollected).toBe('50');
      expect(r.totals.expectedCash).toBe('170');
    });
  });

  describe('salesSummary', () => {
    beforeEach(() => {
      prisma.client.invoice.findMany.mockResolvedValue([
        { id: 'i1', subtotal: '100', totalAmount: '118', discountTotal: '5', taxAmount: '18', status: 'paid', createdAt: new Date('2026-06-01T10:00:00Z') },
        { id: 'i2', subtotal: '8', totalAmount: '10', discountTotal: '0', taxAmount: '2', status: 'refunded', createdAt: new Date('2026-06-01T11:00:00Z') },
      ]);
      prisma.client.posRefund.findMany.mockResolvedValue([{ amount: '10', createdAt: new Date('2026-06-01T11:00:00Z'), items: [{ subtotal: '8', taxAmount: '2' }] }]);
      prisma.client.paymentAllocation.findMany.mockResolvedValue([
        { amount: '118', invoiceId: 'i1', payment: { paymentMethod: 'cash', direction: 'inbound' } },
        { amount: '10', invoiceId: 'i2', payment: { paymentMethod: 'cash', direction: 'outbound' } }, // refund
      ]);
    });

    it('reports revenue NET of tax and nets out refunds', async () => {
      const r = await svc.salesSummary('2026-06-01', '2026-06-01', 'day');
      expect(r.totals.revenue).toBe('100.00');    // net, ex-tax, refund excluded
      expect(r.totals.grossSales).toBe('128.00');
      expect(r.totals.refunds).toBe('10.00');
      expect(r.totals.netSales).toBe('118.00');   // 128 − 10; original sale remains counted
      expect(r.totals.taxes).toBe('18.00');
      expect(r.totals.orders).toBe(2);
    });

    it('byMethod uses allocation amount and excludes refund (outbound) payments', async () => {
      const r = await svc.salesSummary('2026-06-01', '2026-06-01', 'day');
      expect(r.byMethod).toHaveLength(1);
      expect(r.byMethod[0]).toMatchObject({ method: 'cash', count: 1, total: '118.00' });
    });

    it('reads POS sales from the Invoice table (R2 migration) and scopes by tenant + date range', async () => {
      // POS Sprint 1 (F1) retired the legacy Document-based sales path — POS
      // sales now live exclusively on the Invoice table. This assertion
      // verifies the report reads from Invoice with the correct tenant scope
      // and the supplied date range, and never reaches for Document.findMany.
      await svc.salesSummary('2026-06-01', '2026-06-01', 'day');
      const invoiceCalls = prisma.client.invoice.findMany.mock.calls;
      expect(invoiceCalls.length).toBeGreaterThan(0);
      const where = invoiceCalls[0][0].where;
      expect(where.organizationId).toBe(orgId);
      expect(where.createdAt).toEqual({ gte: expect.any(Date), lte: expect.any(Date) });
      expect(prisma.client.document.findMany).not.toHaveBeenCalled();
    });
  });

  describe('parseReportRange (local-timezone day bounds)', () => {
    it('clamps start to local midnight, end to last local instant', () => {
      // Regression: `new Date('YYYY-MM-DD')` parses as UTC midnight, which in
      // UTC+ zones excludes the first local hours of fromDate.
      const [start, end] = parseReportRange('2026-08-04', '2026-08-04');
      expect(start.getHours()).toBe(0); // local midnight
      expect(start.getMinutes()).toBe(0);
      expect(end.getHours()).toBe(23);
      expect(end.getMinutes()).toBe(59);
      expect(end.getMilliseconds()).toBe(999);
      expect(end.getTime()).toBeGreaterThan(start.getTime());
    });

    it('throws BadRequest on invalid dates', () => {
      expect(() => parseReportRange('not-a-date', '2026-08-04')).toThrow();
      expect(() => parseReportRange('2026-08-04', 'not-a-date')).toThrow();
    });
  });

  describe('salesReport / cashierReport / waiterReport / soldItems / itemsByGroup (POS scope)', () => {
    const posInvoice = {
      id: 'i1', organizationId: orgId, orderId: 'o1', status: 'paid',
      invoiceNumber: 'INV-1', subtotal: '100', taxAmount: '0', discountTotal: '0',
      totalAmount: '100', amountPaid: '100', paymentMode: 'cash', waiterId: 'u1',
      createdAt: new Date('2026-06-01T10:00:00Z'),
      order: { orderNumber: 'ORD-1', orderType: 'dine_in', tableId: null },
      items: [{ id: 'li1', productId: 'p1', menuItemId: null, description: 'Coffee', quantity: '2', unitPrice: '50', subtotal: '100', taxAmount: '0', total: '100', discountPercent: '0', discountAmount: '0' }],
    };
    const arInvoice = {
      id: 'i2', organizationId: orgId, orderId: null, status: 'paid', // manual AR invoice
      invoiceNumber: 'INV-2', subtotal: '999', taxAmount: '0', discountTotal: '0',
      totalAmount: '999', amountPaid: '999', paymentMode: 'bank',
      createdAt: new Date('2026-06-01T10:00:00Z'), items: [],
    };

    beforeEach(() => {
      // The mock must emulate the where-clause the service passes — notably
      // `orderId: { not: null }` (POS-only scope) — so the returned rows prove
      // the scope reached Prisma.
      prisma.client.invoice.findMany.mockImplementation((args: any) =>
        Promise.resolve([posInvoice, arInvoice].filter((inv: any) => {
          if (args?.where?.orderId && inv.orderId === null) return false;
          return true;
        })),
      );
      prisma.client.user.findMany.mockResolvedValue([{ id: 'u1', firstName: 'Al', lastName: 'Ice' }]);
    });

    it('salesReport excludes manual AR invoices (orderId null)', async () => {
      const rows = await svc.salesReport('2026-06-01', '2026-06-01');
      expect(rows).toHaveLength(1);
      expect(rows[0].invoiceNumber).toBe('INV-1');
      const where = prisma.client.invoice.findMany.mock.calls[0][0].where;
      expect(where.orderId).toEqual({ not: null });
    });

    it('salesReport reports raw invoice subtotal (no discount added back)', async () => {
      const rows = await svc.salesReport('2026-06-01', '2026-06-01');
      expect(rows[0].subtotal).toBe('100.00');
    });

    it('cashierReport excludes manual AR invoices', async () => {
      const rows = await svc.cashierReport('2026-06-01', '2026-06-01');
      expect(rows).toHaveLength(1);
      expect(rows[0].invoiceNumber).toBe('INV-1');
    });

    it('waiterReport line total includes tax (matches Items Report definition)', async () => {
      const rows = await svc.waiterReport('2026-06-01', '2026-06-01');
      expect(rows).toHaveLength(1);
      expect(rows[0].total).toBe('100.00'); // it.total, not it.subtotal
    });

    it('soldItems excludes manual AR invoices', async () => {
      const rows = await svc.soldItems('2026-06-01', '2026-06-01');
      expect(rows).toHaveLength(1);
      expect(rows[0].invoiceNumber).toBe('INV-1');
    });

    it('itemsByGroup excludes manual AR invoices', async () => {
      const rows = await svc.itemsByGroup('2026-06-01', '2026-06-01');
      expect(rows).toHaveLength(1);
    });
  });

  describe('soldItems category filter (inversion regression)', () => {
    const invoiceWith = {
      id: 'i1', organizationId: orgId, orderId: 'o1', status: 'paid',
      invoiceNumber: 'INV-1', createdAt: new Date('2026-06-01T10:00:00Z'),
      order: { orderNumber: 'ORD-1', orderType: null },
      items: [
        { id: 'li1', productId: 'p-in', menuItemId: 'm-in', description: 'In-cat item', quantity: '1', unitPrice: '10', subtotal: '10', total: '10', discountPercent: '0', discountAmount: '0' },
        { id: 'li2', productId: 'p-out', menuItemId: 'm-out', description: 'Out-cat item', quantity: '1', unitPrice: '20', subtotal: '20', total: '20', discountPercent: '0', discountAmount: '0' },
      ],
    };

    beforeEach(() => {
      prisma.client.invoice.findMany.mockResolvedValue([invoiceWith]);
      prisma.client.product.findMany.mockImplementation((args: any) => {
        const ids = args?.where?.id?.in ?? [];
        return Promise.resolve(
          [
            { id: 'p-in', name: 'In-cat', categoryId: 'cat-1', category: { id: 'cat-1', name: 'Cat One' } },
            { id: 'p-out', name: 'Out-cat', categoryId: 'cat-2', category: { id: 'cat-2', name: 'Cat Two' } },
          ].filter((p) => ids.includes(p.id)),
        );
      });
      prisma.client.menuItem.findMany.mockImplementation((args: any) => {
        const ids = args?.where?.id?.in ?? [];
        return Promise.resolve(
          [
            { id: 'm-in', categoryId: 'cat-1', category: { id: 'cat-1', name: 'Cat One' } },
            { id: 'm-out', categoryId: 'cat-2', category: { id: 'cat-2', name: 'Cat Two' } },
          ].filter((m) => ids.includes(m.id)),
        );
      });
    });

    it('returns ONLY the selected category when both product and menu lookups resolve', async () => {
      // Regression: the pre-fix code skipped matching rows (`has()` → continue)
      // and returned every OTHER category.
      const rows = await svc.soldItems('2026-06-01', '2026-06-01', 'cat-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].item).toBe('In-cat item');
      expect(rows[0].categoryName).toBe('Cat One');
    });

    it('without a filter returns all rows', async () => {
      const rows = await svc.soldItems('2026-06-01', '2026-06-01');
      expect(rows).toHaveLength(2);
    });

    it('matches via menu item when product is absent', async () => {
      prisma.client.product.findMany.mockImplementation(() => Promise.resolve([])); // no products resolve
      const rows = await svc.soldItems('2026-06-01', '2026-06-01', 'cat-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].item).toBe('In-cat item');
      expect(rows[0].categoryName).toBe('Cat One');
    });
  });

  describe('topItems (invoice-only, category filter)', () => {
    it('never reads the legacy Document pipeline', async () => {
      prisma.client.invoiceItem.groupBy.mockResolvedValue([
        { productId: 'p1', _sum: { quantity: '2', total: '100' } },
      ]);
      prisma.client.product.findMany.mockResolvedValue([{ id: 'p1', name: 'Coffee', sku: 'C-1' }]);
      const rows = await svc.topItems('2026-06-01', '2026-06-01', 20);
      expect(prisma.client.documentLine.groupBy).not.toHaveBeenCalled();
      expect(rows[0]).toMatchObject({ productId: 'p1', name: 'Coffee', quantity: 2, total: '100.00' });
    });

    it('applies categoryId via product/menu-item allow-lists', async () => {
      prisma.client.product.findMany.mockImplementation((args: any) =>
        Promise.resolve(args?.where?.categoryId === 'cat-1'
          ? [{ id: 'p1' }]
          : []),
      );
      prisma.client.menuItem.findMany.mockResolvedValue([]);
      await svc.topItems('2026-06-01', '2026-06-01', 20, 'cat-1');
      const where = prisma.client.invoiceItem.groupBy.mock.calls[0][0].where;
      expect(Array.isArray(where.OR)).toBe(true);
      expect(where.OR[0]).toEqual({ productId: { in: ['p1'] } });
    });

    it('returns empty for an unknown category (no crash)', async () => {
      prisma.client.product.findMany.mockResolvedValue([]);
      prisma.client.menuItem.findMany.mockResolvedValue([]);
      const rows = await svc.topItems('2026-06-01', '2026-06-01', 20, 'cat-none');
      expect(rows).toEqual([]);
      expect(prisma.client.invoiceItem.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('orderReport (dead code removal)', () => {
    it('includes all non-cancelled statuses by default', async () => {
      prisma.client.order.findMany.mockResolvedValue([
        { orderNumber: 'ORD-1', orderType: 'dine_in', status: 'draft', createdAt: new Date('2026-06-01T10:00:00Z'), totalAmount: '10' },
        { orderNumber: 'ORD-2', orderType: 'takeaway', status: 'confirmed', createdAt: new Date('2026-06-01T11:00:00Z'), totalAmount: '20' },
      ]);
      const rows = await svc.orderReport('2026-06-01', '2026-06-01');
      expect(rows).toHaveLength(2);
      const where = prisma.client.order.findMany.mock.calls[0][0].where;
      expect(where.status).toEqual({ not: 'cancelled' });
      expect((where as any).orderStatus).toBeUndefined(); // dead var gone
    });

    it('narrows by status when supplied', async () => {
      prisma.client.order.findMany.mockResolvedValue([]);
      await svc.orderReport('2026-06-01', '2026-06-01', undefined, 'confirmed');
      const where = prisma.client.order.findMany.mock.calls[0][0].where;
      expect(where.status).toEqual('confirmed');
    });
  });

  describe('cashierShiftSummary (expected-cash math)', () => {
    it('computes expected = opening + sales − refunds + pay-ins − pay-outs', async () => {
      prisma.client.cashSession.findMany.mockResolvedValue([
        {
          id: 's1', organizationId: orgId, userId: 'u1', openedAt: new Date('2026-06-01T08:00:00Z'),
          openingFloat: '100', closingCounted: '260', cashRegister: { code: 'R1', name: 'Reg' },
          movements: [
            { movementType: 'sale', amount: '150' },
            { movementType: 'refund', amount: '30' },
            { movementType: 'pay_in', amount: '50' },
            { movementType: 'pay_out', amount: '10' },
          ],
        },
      ]);
      prisma.client.user.findMany.mockResolvedValue([{ id: 'u1', firstName: 'Al', lastName: 'Ice' }]);
      const rows = await svc.cashierShiftSummary('2026-06-01', '2026-06-01');
      expect(rows).toHaveLength(1);
      expect(rows[0].openingCash).toBe('100.00');
      expect(rows[0].sales).toBe('150.00');
      expect(rows[0].expectedCash).toBe('260.00'); // 100 + 150 − 30 + 50 − 10
      expect(rows[0].actualCash).toBe('260.00');
      expect(rows[0].difference).toBe('0.00');
    });
  });

  describe('salesByHour (hour filter)', () => {
    it('buckets by local hour and honours the hours filter', async () => {
      const at = (h: number) => new Date(2026, 5, 1, h, 0, 0); // local 2026-06-01
      prisma.client.invoice.findMany.mockResolvedValue([
        { totalAmount: '10', createdAt: at(9) },
        { totalAmount: '20', createdAt: at(9) },
        { totalAmount: '30', createdAt: at(14) },
      ]);
      const r = await svc.salesByHour('2026-06-01', '2026-06-01');
      expect(r.buckets[9]).toMatchObject({ count: 2, total: '30.00' });
      expect(r.buckets[14]).toMatchObject({ count: 1, total: '30.00' });
      const filtered = await svc.salesByHour('2026-06-01', '2026-06-01', '9');
      expect(filtered.buckets[9].count).toBe(2);
      expect(filtered.buckets[14].count).toBe(0);
    });
  });

  describe('itemSales (POS scope)', () => {
    it('excludes manual AR invoices and groups by menu/product key', async () => {
      const pos = {
        id: 'i1', organizationId: orgId, orderId: 'o1', status: 'paid', waiterId: 'u1',
        createdAt: new Date('2026-06-01T10:00:00Z'),
        items: [{ menuItemId: 'm1', productId: null, description: 'Latte', quantity: '2', total: '100' }],
      };
      const ar = {
        id: 'i2', organizationId: orgId, orderId: null, status: 'paid', waiterId: null,
        createdAt: new Date('2026-06-01T10:00:00Z'),
        items: [{ menuItemId: null, productId: 'p-ar', description: 'AR thing', quantity: '1', total: '999' }],
      };
      prisma.client.invoice.findMany.mockImplementation((args: any) =>
        Promise.resolve([pos, ar].filter((inv: any) => !(args?.where?.orderId && inv.orderId === null))),
      );
      prisma.client.user.findMany.mockResolvedValue([{ id: 'u1', firstName: 'Al', lastName: 'Ice' }]);
      const r = await svc.itemSales('2026-06-01', '2026-06-01');
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ itemKey: 'm1', item: 'Latte', quantity: '2.00', totalAmount: '100.00' });
    });
  });

  /* ── Filter correctness (the reason this pass happened) ──────────────── */

  describe('parseReportRange (offset-agnostic + reversed input)', () => {
    it('lands on the requested calendar day whatever the host UTC offset', () => {
      // Regression: `new Date('2026-08-04').setHours(0,0,0,0)` resolves to
      // 2026-08-03 local in every UTC− zone, sliding the whole report a day.
      const [start, end] = parseReportRange('2026-08-04', '2026-08-06');
      expect(localIso(start)).toBe('2026-08-04');
      expect(localIso(end)).toBe('2026-08-06');
    });

    it('normalises a reversed range instead of returning nothing', () => {
      const [start, end] = parseReportRange('2026-08-06', '2026-08-04');
      expect(localIso(start)).toBe('2026-08-04');
      expect(localIso(end)).toBe('2026-08-06');
      expect(end.getTime()).toBeGreaterThan(start.getTime());
    });
  });

  describe('posSaleWhere (one filter vocabulary for every tab)', () => {
    const start = new Date(2026, 5, 1, 0, 0, 0, 0);
    const end = new Date(2026, 5, 1, 23, 59, 59, 999);

    it('includes refunded invoices so tabs cannot disagree with Daily Sales', () => {
      // A fully-refunded sale WAS rung up. Sales/Items/Cashier used to scope to
      // ['posted','paid'] while salesSummary included 'refunded', so the same
      // shift reconciled two different ways depending on the tab.
      const where = posSaleWhere('org-1', start, end);
      expect(where.status.in).toEqual([...POS_SALE_STATUSES]);
      expect(where.status.in).toContain('refunded');
      expect(where.orderId).toEqual({ not: null });
    });

    it('rejects an unknown orderType rather than ignoring it', () => {
      expect(() => posSaleWhere('org-1', start, end, { orderType: 'dinein' })).toThrow();
      expect(() => posSaleWhere('org-1', start, end, { paymentMethod: 'bitcoin' })).toThrow();
    });

    it('maps each filter onto the invoice scope', () => {
      const where = posSaleWhere('org-1', start, end, {
        waiterId: 'u1', paymentMethod: 'card', orderType: 'takeaway', search: 'INV-9',
      });
      expect(where.waiterId).toBe('u1');
      expect(where.paymentMode).toBe('card');
      expect(where.order).toEqual({ orderType: 'takeaway' });
      expect(where.OR).toHaveLength(2);
    });
  });

  describe('report filters actually reach Prisma', () => {
    beforeEach(() => {
      prisma.client.invoice.findMany.mockResolvedValue([]);
      prisma.client.order.findMany.mockResolvedValue([]);
      prisma.client.cashSession.findMany.mockResolvedValue([]);
    });

    it('salesReport forwards waiter / tender / order-type / search', async () => {
      await svc.salesReport('2026-06-01', '2026-06-01', 'u1', 'ORD-7', 'cash', 'dine_in');
      const where = prisma.client.invoice.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ waiterId: 'u1', paymentMode: 'cash', order: { orderType: 'dine_in' } });
    });

    it('waiterReport forwards search + tender (previously accepted neither)', async () => {
      await svc.waiterReport('2026-06-01', '2026-06-01', 'u1', 'takeaway', 'ORD-2', 'card');
      const where = prisma.client.invoice.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ waiterId: 'u1', paymentMode: 'card', order: { orderType: 'takeaway' } });
    });

    it('salesByHour and salesSummary honour the shared filters', async () => {
      await svc.salesByHour('2026-06-01', '2026-06-01', undefined, { orderType: 'delivery' });
      expect(prisma.client.invoice.findMany.mock.calls[0][0].where.order).toEqual({ orderType: 'delivery' });
      prisma.client.invoice.findMany.mockClear();
      await svc.salesSummary('2026-06-01', '2026-06-01', 'day', { waiterId: 'u2' });
      expect(prisma.client.invoice.findMany.mock.calls[0][0].where.waiterId).toBe('u2');
    });

    it('cashierShiftSummary narrows by register and session status', async () => {
      await svc.cashierShiftSummary('2026-06-01', '2026-06-01', 'u1', 'reg-1', 'closed');
      const where = prisma.client.cashSession.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ userId: 'u1', cashRegisterId: 'reg-1', status: 'closed' });
    });

    it('orderReport applies a "draft" status instead of silently dropping it', async () => {
      // Regression: `status !== 'draft'` guarded the filter, so choosing Draft
      // returned every status — the one selection that looked inert.
      await svc.orderReport('2026-06-01', '2026-06-01', undefined, 'draft');
      expect(prisma.client.order.findMany.mock.calls[0][0].where.status).toBe('draft');
    });

    it('orderReport hides cancelled orders unless asked, and rejects junk statuses', async () => {
      await svc.orderReport('2026-06-01', '2026-06-01');
      expect(prisma.client.order.findMany.mock.calls[0][0].where.status).toEqual({ not: 'cancelled' });
      prisma.client.order.findMany.mockClear();
      await svc.orderReport('2026-06-01', '2026-06-01', undefined, undefined, undefined, undefined, true);
      expect(prisma.client.order.findMany.mock.calls[0][0].where.status).toBeUndefined();
      await expect(svc.orderReport('2026-06-01', '2026-06-01', undefined, 'nonsense')).rejects.toThrow();
    });

    it('orderReport narrows by waiter and order number search', async () => {
      await svc.orderReport('2026-06-01', '2026-06-01', undefined, undefined, 'u1', 'ORD-3');
      const where = prisma.client.order.findMany.mock.calls[0][0].where;
      expect(where.waiterId).toBe('u1');
      expect(where.orderNumber).toEqual({ contains: 'ORD-3', mode: 'insensitive' });
    });
  });

  describe('salesSummary period bucketing (local days)', () => {
    it('buckets an evening sale into its LOCAL day, not the next UTC one', async () => {
      // 22:30 local on 2026-06-01. In any UTC+ zone toISOString() would have
      // labelled this 2026-06-02 — a row dated outside the requested range.
      const evening = new Date(2026, 5, 1, 22, 30, 0);
      prisma.client.invoice.findMany.mockResolvedValue([
        { id: 'i1', subtotal: '100', totalAmount: '118', discountTotal: '0', taxAmount: '18', status: 'paid', createdAt: evening },
      ]);
      prisma.client.posRefund.findMany.mockResolvedValue([]);
      const r = await svc.salesSummary('2026-06-01', '2026-06-01', 'day');
      expect(r.periods.map((p: any) => p.periodKey)).toEqual(['2026-06-01']);
      expect(r.fromDate).toBe('2026-06-01');
    });

    it('emits an explicit zero row for a day with no sales', async () => {
      prisma.client.invoice.findMany.mockResolvedValue([
        { id: 'i1', subtotal: '10', totalAmount: '10', discountTotal: '0', taxAmount: '0', status: 'paid', createdAt: new Date(2026, 5, 1, 12, 0, 0) },
      ]);
      prisma.client.posRefund.findMany.mockResolvedValue([]);
      const r = await svc.salesSummary('2026-06-01', '2026-06-03', 'day');
      expect(r.periods.map((p: any) => p.periodKey)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
      expect(r.periods[1]).toMatchObject({ orders: 0, grossSales: '0.00' });
    });
  });

  describe('topItems (menu-driven catalogues)', () => {
    it('counts menu-item lines that carry no productId', async () => {
      // Regression: grouping by productId alone binned every café line
      // (menuItemId set, productId null) into the discarded null bucket, so a
      // menu-only catalogue produced an empty Top Items tab.
      prisma.client.invoiceItem.groupBy.mockResolvedValue([
        { productId: null, menuItemId: 'm1', _sum: { quantity: '3', total: '150' } },
        { productId: 'p1', menuItemId: null, _sum: { quantity: '1', total: '20' } },
      ]);
      prisma.client.product.findMany.mockResolvedValue([{ id: 'p1', name: 'Beans', sku: 'B-1' }]);
      prisma.client.menuItem.findMany.mockResolvedValue([{ id: 'm1', name: 'Latte' }]);
      const rows = await svc.topItems('2026-06-01', '2026-06-01', 20);
      expect(rows.map((r: any) => r.name)).toEqual(['Latte', 'Beans']);
      expect(rows[0]).toMatchObject({ productId: 'm1', quantity: 3, total: '150.00' });
      expect(prisma.client.invoiceItem.groupBy.mock.calls[0][0].by).toEqual(['productId', 'menuItemId']);
    });
  });

  describe('cashierShiftSummary (cash vs all tenders)', () => {
    it('separates drawer cash from total sales across every tender', async () => {
      prisma.client.cashSession.findMany.mockResolvedValue([
        {
          id: 's1', organizationId: orgId, userId: 'u1', status: 'closed',
          openedAt: new Date('2026-06-01T08:00:00Z'), closedAt: new Date('2026-06-01T18:00:00Z'),
          openingFloat: '100', closingCounted: '250', cashRegister: { code: 'R1', name: 'Reg' },
          movements: [{ movementType: 'sale', amount: '150' }],
        },
      ]);
      prisma.client.invoice.findMany.mockResolvedValue([
        { cashSessionId: 's1', totalAmount: '150' }, // cash
        { cashSessionId: 's1', totalAmount: '400' }, // card — invisible to the drawer
      ]);
      prisma.client.user.findMany.mockResolvedValue([{ id: 'u1', firstName: 'Al', lastName: 'Ice' }]);
      const rows = await svc.cashierShiftSummary('2026-06-01', '2026-06-01');
      expect(rows[0]).toMatchObject({
        cashSales: '150.00', totalSales: '550.00', saleCount: 2,
        expectedCash: '250.00', difference: '0.00', status: 'closed',
      });
    });
  });

  describe('itemsByGroup / soldItems extra filters', () => {
    it('itemsByGroup narrows to one category', async () => {
      prisma.client.invoice.findMany.mockResolvedValue([
        {
          id: 'i1', orderId: 'o1', status: 'paid', createdAt: new Date(2026, 5, 1, 10),
          items: [
            { productId: 'p-in', menuItemId: null, quantity: '1', total: '10' },
            { productId: 'p-out', menuItemId: null, quantity: '1', total: '20' },
          ],
        },
      ]);
      prisma.client.product.findMany.mockResolvedValue([
        { id: 'p-in', name: 'In', categoryId: 'cat-1', category: { id: 'cat-1', name: 'Cat One' } },
        { id: 'p-out', name: 'Out', categoryId: 'cat-2', category: { id: 'cat-2', name: 'Cat Two' } },
      ]);
      prisma.client.menuItem.findMany.mockResolvedValue([]);
      const rows = await svc.itemsByGroup('2026-06-01', '2026-06-01', undefined, undefined, 'cat-1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ groupId: 'cat-1', totalAmount: '10.00' });
    });

    it('soldItems filters by item description text', async () => {
      prisma.client.invoice.findMany.mockResolvedValue([
        {
          id: 'i1', orderId: 'o1', status: 'paid', invoiceNumber: 'INV-1', createdAt: new Date(2026, 5, 1, 10),
          order: { orderNumber: 'ORD-1', orderType: null },
          items: [
            { productId: null, menuItemId: null, description: 'Flat White', quantity: '1', unitPrice: '10', total: '10', discountPercent: '0', discountAmount: '0' },
            { productId: null, menuItemId: null, description: 'Croissant', quantity: '1', unitPrice: '5', total: '5', discountPercent: '0', discountAmount: '0' },
          ],
        },
      ]);
      prisma.client.product.findMany.mockResolvedValue([]);
      prisma.client.menuItem.findMany.mockResolvedValue([]);
      const rows = await svc.soldItems('2026-06-01', '2026-06-01', undefined, undefined, undefined, undefined, 'white');
      expect(rows).toHaveLength(1);
      expect(rows[0].item).toBe('Flat White');
    });
  });

  describe('filterOptions', () => {
    it('offers only the staff and categories that appear in the range', async () => {
      prisma.client.invoice.findMany.mockResolvedValue([
        { waiterId: 'u1', paymentMode: 'cash', items: [{ productId: 'p1', menuItemId: null }] },
      ]);
      prisma.client.user.findMany.mockResolvedValue([{ id: 'u1', firstName: 'Al', lastName: 'Ice' }]);
      prisma.client.product.findMany.mockResolvedValue([{ category: { id: 'cat-1', name: 'Drinks' } }]);
      prisma.client.menuItem.findMany.mockResolvedValue([]);
      prisma.client.cashRegister.findMany = jest.fn().mockResolvedValue([{ id: 'r1', code: 'R1', name: 'Counter' }]);
      const o = await svc.filterOptions('2026-06-01', '2026-06-01');
      expect(o.waiters).toEqual([{ id: 'u1', name: 'Al Ice' }]);
      expect(o.categories).toEqual([{ id: 'cat-1', name: 'Drinks' }]);
      expect(o.registers).toEqual([{ id: 'r1', name: 'R1 - Counter' }]);
      expect(o.paymentMethods.find((m: any) => m.id === 'cash')).toMatchObject({ seen: true });
      expect(o.paymentMethods.find((m: any) => m.id === 'card')).toMatchObject({ seen: false });
    });
  });
});
