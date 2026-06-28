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
      expect(prisma.client.document.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to Document when no Invoice record exists', async () => {
      prisma.client.invoice.findFirst.mockResolvedValue(null);
      prisma.client.document.findFirst.mockResolvedValue({
        id: 'doc-1', documentNumber: 'DOC-001', partnerId: 'p-2',
        totalAmount: '200',
      });
      prisma.client.documentLine.findMany.mockResolvedValue([
        { id: 'dl-1', productId: 'prod-2', description: 'Tea', quantity: '1', unitPrice: '200', total: '200', lineNumber: 1 },
      ]);
      prisma.client.partner.findFirst.mockResolvedValue({ id: 'p-2', name: 'Bob' });
      prisma.client.product.findMany.mockResolvedValue([{ id: 'prod-2', name: 'Tea', sku: 'TE-01' }]);

      const result = await svc.resolveInvoice('doc-1');
      expect(result.id).toBe('doc-1');
      expect(result.partner!.name).toBe('Bob');
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].product?.name).toBe('Tea');
    });

    it('throws NotFoundException when neither table has the record', async () => {
      prisma.client.invoice.findFirst.mockResolvedValue(null);
      prisma.client.document.findFirst.mockResolvedValue(null);
      await expect(svc.resolveInvoice('missing')).rejects.toThrow();
    });
  });
});
