/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PosInvoiceService } from './pos-invoice.service';

function mockPrisma(): any {
  return {
    client: {
      $transaction: jest.fn((cb: any) => cb({ invoice: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn() }, invoiceItem: { create: jest.fn(), findMany: jest.fn() }, invoiceItemModifier: { createMany: jest.fn() } })),
      order: { findFirst: jest.fn(), update: jest.fn() },
      orderItem: { findMany: jest.fn() },
      invoice: { findFirst: jest.fn(), update: jest.fn() },
      invoiceItem: { findMany: jest.fn().mockResolvedValue([]) },
      receipt: { create: jest.fn().mockResolvedValue({ id: 'rcpt-1' }) },
      receiptItem: { createMany: jest.fn() },
      accountMapping: { findFirst: jest.fn() },
    },
  };
}

describe('PosInvoiceService', () => {
  const orgId = 'test-org';
  const userId = 'test-user';
  let prisma: any;
  let tenant: any;
  let svc: PosInvoiceService;
  let mockPosting: any;
  let mockDetermination: any;
  let mockBuilder: any;
  let mockSequence: any;
  let mockPayments: any;
  let mockStock: any;

  beforeEach(() => {
    prisma = mockPrisma();
    tenant = { organizationId: orgId, userId };
    mockBuilder = { prepareLines: jest.fn(), groupForPosting: jest.fn() };
    mockSequence = { next: jest.fn().mockResolvedValue('INV-2026-0001') };
    mockPayments = { createReceipt: jest.fn() };
    mockPosting = { post: jest.fn() };
    mockDetermination = { mapped: jest.fn() };
    mockStock = { issue: jest.fn(), receive: jest.fn() };
    svc = new PosInvoiceService(
      prisma as any,
      tenant as any,
      {} as any, // audit
      {} as any, // events
      mockBuilder as any,
      mockSequence as any,
      mockPayments as any,
      mockPosting as any,
      mockDetermination as any,
      mockStock as any,
      {} as any, // receipts
    );
  });

  describe('storeCreditAccountId', () => {
    it('returns the mapped account when mapping exists', async () => {
      prisma.client.accountMapping.findFirst.mockResolvedValue({ key: 'store_credit', accountId: 'sc-acc-1' });
      const result = await (svc as any).storeCreditAccountId();
      expect(result).toBe('sc-acc-1');
    });

    it('throws BadRequestException when mapping is missing', async () => {
      prisma.client.accountMapping.findFirst.mockResolvedValue(null);
      await expect((svc as any).storeCreditAccountId()).rejects.toThrow(BadRequestException);
    });
  });

  describe('postInvoiceGl', () => {
    const mockInvoice = {
      id: 'inv-1', invoiceNumber: 'INV-001', partnerId: 'p-1',
      totalAmount: '100', issueDate: new Date(), paymentMode: 'cash',
    };
    const mockItems = [{ id: 'li-1', accountId: 'rev-acc', total: 80 }];

    beforeEach(() => {
      mockBuilder.groupForPosting.mockResolvedValue({
        counterAccount: 'ar-acc',
        itemByAccount: [['rev-acc', 80]],
        taxByAccount: [['tax-acc', 20]],
      });
      mockPosting.post.mockResolvedValue({ id: 'je-1' });
    });

    it('uses AR counter-account when paymentMode is credit', async () => {
      const inv = { ...mockInvoice, paymentMode: 'credit' };
      await (svc as any).postInvoiceGl(prisma.client, inv, mockItems);
      const lines = mockPosting.post.mock.calls[0][0].lines;
      expect(lines[0].accountId).toBe('ar-acc'); // AR
    });

    it('uses cash counter-account when paymentMode is cash', async () => {
      mockDetermination.mapped.mockResolvedValue('cash-acc');
      await (svc as any).postInvoiceGl(prisma.client, mockInvoice, mockItems);
      const lines = mockPosting.post.mock.calls[0][0].lines;
      expect(lines[0].accountId).toBe('cash-acc');
      expect(mockDetermination.mapped).toHaveBeenCalledWith('default_cash', expect.anything());
    });

    it('uses AR counter-account when paymentMode is null (default)', async () => {
      const inv = { ...mockInvoice, paymentMode: null };
      mockDetermination.mapped.mockResolvedValue('cash-acc');
      await (svc as any).postInvoiceGl(prisma.client, inv, mockItems);
      const lines = mockPosting.post.mock.calls[0][0].lines;
      expect(lines[0].accountId).toBe('ar-acc');
      expect(mockDetermination.mapped).not.toHaveBeenCalled();
    });

    it('posts with SALES journal code', async () => {
      await (svc as any).postInvoiceGl(prisma.client, mockInvoice, mockItems);
      expect(mockPosting.post.mock.calls[0][0].journalCode).toBe('SALES');
    });
  });

  describe('receivePayment', () => {
    const mockInvoice = {
      id: 'inv-1', invoiceNumber: 'INV-001', partnerId: 'p-1',
      totalAmount: '100', amountResidual: 100, status: 'posted',
      paymentMode: 'cash', settlementStatus: 'unsettled',
    };

    beforeEach(() => {
      prisma.client.invoice.findFirst.mockResolvedValue(mockInvoice);
      prisma.client.accountMapping.findFirst.mockResolvedValue({ key: 'store_credit', accountId: 'sc-acc' });
      mockPayments.createReceipt.mockResolvedValue({ id: 'pay-1' });
    });

    it('records a payment with skipGlPosting for cash mode', async () => {
      await svc.receivePayment('inv-1', { paymentMethod: 'cash', amountTendered: 100 });
      expect(mockPayments.createReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ skipGlPosting: true, paymentMethod: 'cash' }),
      );
    });

    it('does not skip GL posting for credit mode', async () => {
      prisma.client.invoice.findFirst.mockResolvedValue({ ...mockInvoice, paymentMode: 'credit' });
      await svc.receivePayment('inv-1', { paymentMethod: 'cash', amountTendered: 100 });
      expect(mockPayments.createReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ skipGlPosting: false }),
      );
    });

    it('uses store_credit account for store credit tender', async () => {
      await svc.receivePayment('inv-1', {
        tenders: [{ method: 'store_credit', amount: 100 }],
      });
      expect(mockPayments.createReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'sc-acc' }),
      );
    });
  });
});
