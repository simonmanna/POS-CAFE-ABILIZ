/* eslint-disable @typescript-eslint/no-explicit-any */
import { PosPrintLifecycleService } from './pos-print-lifecycle.service';

function mockTx(overrides?: Record<string, any>): any {
  return {
    invoice: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    order: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    document: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    documentLine: { updateMany: jest.fn() },
    orderItem: { updateMany: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    documentPrintLog: { create: jest.fn() },
    ...overrides,
  };
}

describe('PosPrintLifecycleService', () => {
  const orgId = 'test-org';
  const userId = 'test-user';
  let prisma: any;
  let tenant: any;
  let svc: PosPrintLifecycleService;

  beforeEach(() => {
    prisma = { client: {} } as any;
    tenant = { organizationId: orgId, userId: jest.fn().mockReturnValue(userId) };
    svc = new PosPrintLifecycleService(prisma, tenant, {} as any);
  });

  describe('resolvePrintTarget', () => {
    it('returns "invoice" when record exists in Invoice table', async () => {
      const tx = mockTx();
      tx.invoice.findFirst.mockResolvedValue({ id: 'inv-1' });
      const result = await (svc as any).resolvePrintTarget(tx, 'inv-1');
      expect(result).toBe('invoice');
    });

    it('returns "document" when no Invoice record exists', async () => {
      const tx = mockTx();
      tx.invoice.findFirst.mockResolvedValue(null);
      const result = await (svc as any).resolvePrintTarget(tx, 'doc-1');
      expect(result).toBe('document');
    });
  });

  describe('markBillPrinted', () => {
    it('updates Invoice when target is invoice', async () => {
      const tx = mockTx();
      tx.invoice.findFirst.mockResolvedValue({ id: 'inv-1' });
      tx.invoice.update.mockResolvedValue({});
      await svc.markBillPrinted(tx, 'inv-1', userId);
      expect(tx.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-1' },
          data: expect.objectContaining({ billPrintCount: { increment: 1 } }),
        }),
      );
      expect(tx.document.update).not.toHaveBeenCalled();
    });

    it('updates Document when target is document', async () => {
      const tx = mockTx();
      tx.invoice.findFirst.mockResolvedValue(null);
      tx.document.update.mockResolvedValue({});
      await svc.markBillPrinted(tx, 'doc-1', userId);
      expect(tx.document.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'doc-1' },
          data: expect.objectContaining({ billPrintCount: { increment: 1 } }),
        }),
      );
    });
  });

  describe('markLinesBilled', () => {
    it('checkpoints each active order-item quantity', async () => {
      const tx = mockTx();
      tx.invoice.findFirst.mockResolvedValue(null);
      tx.order.findFirst.mockResolvedValue({ id: 'ord-1' });
      tx.orderItem.findMany.mockResolvedValue([
        { id: 'line-1', quantity: 2 },
        { id: 'line-2', quantity: 1 },
      ]);

      await svc.markLinesBilled(tx, 'ord-1', userId);

      expect(tx.orderItem.update).toHaveBeenCalledTimes(2);
      expect(tx.orderItem.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'line-1' },
        data: expect.objectContaining({ billPrintedQty: 2, lastBillPrintedById: userId }),
      });
      expect(tx.orderItem.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'line-2' },
        data: expect.objectContaining({ billPrintedQty: 1, lastBillPrintedById: userId }),
      });
    });
  });

  describe('markReceiptPrinted', () => {
    it('increments receiptPrintCount on Invoice', async () => {
      const tx = mockTx();
      tx.invoice.findFirst.mockResolvedValue({ id: 'inv-1' });
      tx.invoice.update.mockResolvedValue({});
      await svc.markReceiptPrinted(tx, 'inv-1', userId);
      expect(tx.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-1' },
          data: expect.objectContaining({ receiptPrintCount: { increment: 1 } }),
        }),
      );
    });
  });

  describe('markKotPrinted', () => {
    it('increments kotPrintCount on Invoice', async () => {
      const tx = mockTx();
      tx.invoice.findFirst.mockResolvedValue({ id: 'inv-1' });
      tx.invoice.update.mockResolvedValue({});
      await svc.markKotPrinted(tx, 'inv-1', userId);
      expect(tx.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-1' },
          data: expect.objectContaining({ kotPrintCount: { increment: 1 } }),
        }),
      );
    });

    it('increments kotPrintCount on Document when target is document', async () => {
      const tx = mockTx();
      tx.invoice.findFirst.mockResolvedValue(null);
      tx.document.update.mockResolvedValue({});
      await svc.markKotPrinted(tx, 'doc-1', userId);
      expect(tx.document.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'doc-1' },
          data: expect.objectContaining({ kotPrintCount: { increment: 1 } }),
        }),
      );
    });
  });

  describe('getBillCopyNumber', () => {
    it('returns billPrintCount + 1 from Invoice', async () => {
      const tx = mockTx();
      tx.invoice.findFirst.mockResolvedValue({ id: 'inv-1' }); // resolvePrintTarget
      tx.invoice.findUnique.mockResolvedValue({ billPrintCount: 3 });
      const copy = await svc.getBillCopyNumber(tx, 'inv-1');
      expect(copy).toBe(4);
    });
  });

  describe('getReceiptCopyNumber', () => {
    it('returns receiptPrintCount + 1 from Invoice', async () => {
      const tx = mockTx();
      tx.invoice.findFirst.mockResolvedValue({ id: 'inv-1' }); // resolvePrintTarget
      tx.invoice.findUnique.mockResolvedValue({ receiptPrintCount: 5 });
      const copy = await svc.getReceiptCopyNumber(tx, 'inv-1');
      expect(copy).toBe(6);
    });
  });

  describe('getKotCopyNumber', () => {
    it('returns kotPrintCount + 1 from Invoice', async () => {
      const tx = mockTx();
      tx.invoice.findFirst.mockResolvedValue({ id: 'inv-1' }); // resolvePrintTarget
      tx.invoice.findUnique.mockResolvedValue({ kotPrintCount: 2 });
      const copy = await svc.getKotCopyNumber(tx, 'inv-1');
      expect(copy).toBe(3);
    });
  });

  describe('getKitchenDeltas', () => {
    it('excludes previously printed quantities and returns only additions', async () => {
      const tx = mockTx();
      tx.orderItem.findMany.mockResolvedValue([
        { id: 'same', quantity: 2, kitchenPrintedQty: 2, kitchenLastPrintedAt: new Date(), modifiers: [] },
        { id: 'increased', quantity: 3, kitchenPrintedQty: 1, kitchenLastPrintedAt: new Date(), modifiers: [] },
        { id: 'new', quantity: 1, kitchenPrintedQty: null, kitchenLastPrintedAt: null, modifiers: [] },
      ]);

      const delta = await svc.getKitchenDeltas(tx, 'ord-1');

      expect(delta.addLines.map(({ line, delta: qty }) => ({ id: line.id, qty }))).toEqual([
        { id: 'increased', qty: 2 },
        { id: 'new', qty: 1 },
      ]);
      expect(delta.unchangedLines.map(({ line }) => line.id)).toEqual(['same']);
    });
  });
});
