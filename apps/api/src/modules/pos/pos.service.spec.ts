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
      {} as any, // approvals
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

    it('classifies a bank tender as electronic, never physical cash', () => {
      const mode = (svc as any).resolvePaymentMode([{ method: 'bank', amount: 100 }]);
      expect(mode).toBe('card');
    });

    it('does not label prepaid store credit as unpaid house credit', () => {
      const mode = (svc as any).resolvePaymentMode([{ method: 'store_credit', amount: 100 }]);
      expect(mode).toBe('mixed');
    });

    it('returns "mixed" for multiple tender methods', () => {
      const mode = (svc as any).resolvePaymentMode([
        { method: 'cash', amount: 60 },
        { method: 'card', amount: 40 },
      ]);
      expect(mode).toBe('mixed');
    });
  });

  describe('requireCashSession', () => {
    beforeEach(() => {
      prisma.client.cashSession = { findFirst: jest.fn() };
    });

    it('refuses another cashier’s drawer unless the org declared the till shared', async () => {
      // F17: money must land in the drawer of the person who counts it. A waiter
      // on a shared terminal either hands the register over or the site opts in.
      const other = { id: 'drawer-1', status: 'open', userId: 'other-cashier', cashRegister: { isActive: true, deletedAt: null } };
      prisma.client.cashSession.findFirst.mockResolvedValue(other);
      prisma.client.organizationModule = { findUnique: jest.fn().mockResolvedValue({ config: {} }) };
      await expect((svc as any).requireCashSession({ cashSessionId: 'drawer-1', paymentMethod: 'cash' })).rejects.toThrow(/another cashier/i);

      prisma.client.organizationModule.findUnique.mockResolvedValue({ config: { sharedDrawer: true } });
      await expect((svc as any).requireCashSession({ cashSessionId: 'drawer-1', paymentMethod: 'cash' })).resolves.toBe('drawer-1');
    });

    it('accepts the caller’s own open drawer', async () => {
      prisma.client.cashSession.findFirst.mockResolvedValueOnce({ id: 'drawer-1', status: 'open', userId: 'test-user', cashRegister: { isActive: true, deletedAt: null } });
      const id = await (svc as any).requireCashSession({ cashSessionId: 'drawer-1', paymentMethod: 'cash' });
      expect(id).toBe('drawer-1');
    });

    it('rejects a closed original drawer instead of silently selecting another one', async () => {
      prisma.client.cashSession.findFirst.mockResolvedValue({ id: 'drawer-1', status: 'closed', userId: 'other' });
      await expect((svc as any).requireCashSession({ cashSessionId: 'drawer-1', paymentMethod: 'cash' })).rejects.toThrow(/original register session/i);
      expect(prisma.client.cashSession.findFirst).toHaveBeenCalledTimes(1);
    });
    it('requires an explicitly selected register for physical cash', async () => {
      await expect((svc as any).requireCashSession({ paymentMethod: 'cash' })).rejects.toThrow(/Select an open register/i);
      expect(prisma.client.cashSession.findFirst).not.toHaveBeenCalled();
    });

    it('requires register attribution for electronic sales too', async () => {
      prisma.client.cashSession.findFirst.mockResolvedValueOnce(null); // own
      await expect((svc as any).requireCashSession({ tenders: [{ method: 'card', amount: 100 }] })).rejects.toThrow('Select an open register');
    });
  });
});
