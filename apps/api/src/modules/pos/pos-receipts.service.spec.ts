/* eslint-disable @typescript-eslint/no-explicit-any */
import { PosReceiptsService } from './pos-receipts.service';

describe('PosReceiptsService', () => {
  const orgId = 'test-org';
  let prisma: any;
  let tenant: any;
  let svc: PosReceiptsService;

  beforeEach(() => {
    prisma = {
      client: {
        invoice: { findFirst: jest.fn() },
        invoiceItem: { findMany: jest.fn() },
        order: { findFirst: jest.fn() },
        document: { findFirst: jest.fn() },
        documentLine: { findMany: jest.fn() },
        partner: { findFirst: jest.fn() },
        product: { findMany: jest.fn() },
        receipt: { create: jest.fn() },
        receiptItem: { createMany: jest.fn() },
      },
    };
    tenant = { organizationId: orgId };
    svc = new PosReceiptsService(
      prisma as any,
      tenant as any,
      {} as any, // audit
      {} as any, // notifications
      {} as any, // settings
      {} as any, // printLifecycle
    );
  });

  describe('resolveInvoice', () => {
    it('returns Invoice data when record exists in Invoice table', async () => {
      prisma.client.invoice.findFirst.mockResolvedValue({
        id: 'inv-1', invoiceNumber: 'INV-001', partnerId: 'p-1',
        totalAmount: '100', items: [
          { id: 'li-1', productId: 'prod-1', description: 'Coffee', quantity: '2', unitPrice: '50', total: '100', lineNumber: 1 },
        ],
      });
      prisma.client.partner.findFirst.mockResolvedValue({ id: 'p-1', name: 'Alice' });
      prisma.client.product.findMany.mockResolvedValue([{ id: 'prod-1', name: 'Coffee', sku: 'CF-01' }]);

      const result = await svc.resolveInvoice('inv-1');
      expect(result).toBeTruthy();
      expect(result.id).toBe('inv-1');
      expect(result.partner!.name).toBe('Alice');
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].product?.name).toBe('Coffee');
      expect(prisma.client.order.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to the open tab Order when no Invoice record exists', async () => {
      prisma.client.invoice.findFirst.mockResolvedValue(null);
      prisma.client.order.findFirst.mockResolvedValue({
        id: 'ord-1', orderNumber: 'ORD-001', partnerId: 'p-2',
        totalAmount: '200', openedAt: new Date(), createdAt: new Date(),
        items: [
          { id: 'oi-1', productId: 'prod-2', description: 'Tea', quantity: '1', unitPrice: '200', discountPercent: '0', modifiers: [] },
        ],
      });
      prisma.client.partner.findFirst.mockResolvedValue({ id: 'p-2', name: 'Bob' });
      prisma.client.product.findMany.mockResolvedValue([{ id: 'prod-2', name: 'Tea', sku: 'TE-01' }]);

      const result = await svc.resolveInvoice('ord-1');
      expect(result.id).toBe('ord-1');
      expect(result.documentNumber).toBe('ORD-001');
      expect(result.partner!.name).toBe('Bob');
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].product?.name).toBe('Tea');
    });

    it('throws NotFoundException when neither table has the record', async () => {
      prisma.client.invoice.findFirst.mockResolvedValue(null);
      prisma.client.order.findFirst.mockResolvedValue(null);
      await expect(svc.resolveInvoice('missing')).rejects.toThrow();
    });
  });

  describe('discounted receipt totals', () => {
    const discountedInvoice = {
      id: 'inv-discounted',
      invoiceNumber: 'INV-2026-000112',
      partnerId: 'p-1',
      issueDate: new Date('2026-09-12T18:59:00.000Z'),
      paymentMode: 'cash',
      subtotal: '38700',
      discountTotal: '4300',
      taxAmount: '0',
      totalAmount: '38700',
      amountPaid: '38700',
      items: [
        { id: 'li-1', description: 'Vanilla', quantity: '2', unitPrice: '9000', discountPercent: '10', total: '16200', lineNumber: 1, modifiers: [] },
        { id: 'li-2', description: 'Boxenia', quantity: '2', unitPrice: '5000', discountPercent: '10', total: '9000', lineNumber: 2, modifiers: [] },
        { id: 'li-3', description: 'Mini-Boxenia', quantity: '5', unitPrice: '3000', discountPercent: '10', total: '13500', lineNumber: 3, modifiers: [] },
      ],
    };

    beforeEach(() => {
      prisma.client.invoice.findFirst.mockResolvedValue(discountedInvoice);
      prisma.client.partner.findFirst.mockResolvedValue({ id: 'p-1', name: 'Acme Retail Ltd' });
      prisma.client.product.findMany.mockResolvedValue([]);
      prisma.client.user = { findFirst: jest.fn().mockResolvedValue({ firstName: 'Admin', lastName: 'User' }) };
      (svc as any).settings = {
        get: jest.fn().mockResolvedValue({ value: {} }),
      };
      prisma.raw = {
        organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Abiliz Cafe and Patisserie' }) },
      };
    });

    it('prints the pre-discount subtotal and the reduced payable total', async () => {
      const receipt = await svc.buildTextReceipt(discountedInvoice.id);

      expect(receipt).toMatch(/Subtotal:\s+UGX 43,000/);
      expect(receipt).toMatch(/Discount:\s+-UGX 4,300/);
      expect(receipt).toMatch(/TOTAL:\s+UGX 38,700/);
      expect(receipt).toMatch(/Paid:\s+UGX 38,700/);
    });
  });

  describe('additional bill deltas', () => {
    it('returns only quantity added after earlier bill prints', async () => {
      prisma.client.document.findFirst.mockResolvedValue(null);
      prisma.client.order.findFirst.mockResolvedValue({
        id: 'ord-1',
        items: [
          { id: 'old', description: 'Coffee', quantity: 2, billPrintedQty: 2, lineNumber: 1 },
          { id: 'increased', description: 'Cake', quantity: 3, billPrintedQty: 1, lineNumber: 2 },
          { id: 'new', description: 'Water', quantity: 1, billPrintedQty: 0, lineNumber: 3 },
        ],
      });

      const lines = await (svc as any).getUnbilledLines('ord-1');

      expect(lines.map((line: any) => ({ id: line.id, quantity: line.quantity }))).toEqual([
        { id: 'increased', quantity: 2 },
        { id: 'new', quantity: 1 },
      ]);
    });
  });
});
