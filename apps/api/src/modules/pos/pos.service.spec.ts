/* eslint-disable @typescript-eslint/no-explicit-any */
import { PosService } from './pos.service';

describe('PosService', () => {
  const orgId = 'test-org';
  let prisma: any;
  let tenant: any;
  let svc: PosService;

  beforeEach(() => {
    prisma = { client: { $transaction: jest.fn((cb: any) => cb({})), order: { create: jest.fn(), update: jest.fn() }, partner: { findFirst: jest.fn(), upsert: jest.fn() }, product: { findFirst: jest.fn(), findMany: jest.fn() } } } as any;
    tenant = { organizationId: orgId, userId: 'test-user' };
    svc = new PosService(
      prisma as any,
      tenant as any,
      {} as any, // audit
      {} as any, // events
      {} as any, // builder
      {} as any, // invoices
      {} as any, // payments
      {} as any, // creditNotes
      {} as any, // stock
      {} as any, // overrides
      {} as any, // notifications
      {} as any, // modifiers
      {} as any, // variants
      {} as any, // accompaniments
      {} as any, // kds
      {} as any, // loyalty
      {} as any, // printLifecycle
      {} as any, // receipts
      {} as any, // tables
      {} as any, // orders
      {} as any, // billing
    );
  });

  describe('resolvePaymentMode', () => {
    it('returns "cash" for a single cash tender', () => {
      const mode = (svc as any).resolvePaymentMode([{ method: 'cash', amount: 100 }]);
      expect(mode).toBe('cash');
    });

    it('returns "card" for a single card tender', () => {
      const mode = (svc as any).resolvePaymentMode([{ method: 'card', amount: 100 }]);
      expect(mode).toBe('card');
    });

    it('returns "mobile_money" for a single mobile_money tender', () => {
      const mode = (svc as any).resolvePaymentMode([{ method: 'mobile_money', amount: 100 }]);
      expect(mode).toBe('mobile_money');
    });

    it('returns "cash" for a single bank tender (bank -> cash)', () => {
      const mode = (svc as any).resolvePaymentMode([{ method: 'bank', amount: 100 }]);
      expect(mode).toBe('cash');
    });

    it('returns "credit" for a single store_credit tender', () => {
      const mode = (svc as any).resolvePaymentMode([{ method: 'store_credit', amount: 100 }]);
      expect(mode).toBe('credit');
    });

    it('returns "mixed" for multiple tender methods', () => {
      const mode = (svc as any).resolvePaymentMode([
        { method: 'cash', amount: 60 },
        { method: 'card', amount: 40 },
      ]);
      expect(mode).toBe('mixed');
    });
  });
});
