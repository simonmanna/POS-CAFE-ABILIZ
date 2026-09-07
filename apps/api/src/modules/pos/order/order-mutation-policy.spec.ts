/* eslint-disable @typescript-eslint/no-explicit-any */
import { PosOrdersService } from './pos-orders.service';
import { assertOrderCancellationAllowed, isMeaningfulReason } from './order-mutation-policy';

/**
 * Audit #2 N-02 — a whole-order cancel carries the same authority as a per-line
 * void.
 *
 * The defect these tests lock down: `voidItem` demanded `pos:void` + a reason +
 * a manager PIN to remove ONE line the kitchen had already cooked, while
 * cancelling the entire order — directly via POST /pos/orders/:id/cancel, or by
 * saving an empty cart — demanded nothing at all. Fire, serve, clear the cart,
 * take the cash, with the strongest control in the system sitting one endpoint
 * away.
 *
 * What must hold now:
 *   1. an order the kitchen never saw still cancels in one tap (no regression);
 *   2. an order with fired food needs the pos:void right, read LIVE;
 *   3. ...and a reason a manager could actually review — the auto-filled
 *      "Order emptied" placeholder is explicitly not one;
 *   4. ...and a transaction-bound manager approval, scoped to a VOID;
 *   5. the audit row names the cooked items that were destroyed.
 */
describe('N-02 — whole-order cancellation policy', () => {
  const orgId = 'org-1';

  const firedLine = { id: 'i1', description: 'Nile Special', quantity: 2, kitchenPrintedQty: 2, cancelled: false, lineNumber: 1 };
  const unfiredLine = { id: 'i2', description: 'Still Water', quantity: 1, kitchenPrintedQty: null, cancelled: false, lineNumber: 2 };

  const ctxFor = (permissions: string[], overrides: any) => ({
    prisma: { raw: { user: { findFirst: jest.fn().mockResolvedValue({ id: 'cashier-1', roles: [{ permissions }] }) } } },
    tenant: { organizationId: orgId, userId: 'cashier-1' },
    overrides,
  });

  const txWith = (items: any[]) => ({ orderItem: { findMany: jest.fn().mockResolvedValue(items) } });

  describe('isMeaningfulReason', () => {
    it('rejects the placeholder the empty-cart save used to auto-fill', () => {
      expect(isMeaningfulReason('Order emptied')).toBe(false);
      expect(isMeaningfulReason('  ')).toBe(false);
      expect(isMeaningfulReason('n/a')).toBe(false);
      expect(isMeaningfulReason('ab')).toBe(false);
    });

    it('accepts a real explanation', () => {
      expect(isMeaningfulReason('Customer left before service')).toBe(true);
    });
  });

  describe('assertOrderCancellationAllowed', () => {
    it('lets an order the kitchen never saw cancel with no ceremony', async () => {
      const overrides = { verifyOperationApproval: jest.fn() };
      const fired = await assertOrderCancellationAllowed(
        ctxFor([], overrides) as any, txWith([unfiredLine]), 'o1', {},
      );
      expect(fired).toEqual([]);
      expect(overrides.verifyOperationApproval).not.toHaveBeenCalled();
    });

    it('refuses a cashier without pos:void once food was fired', async () => {
      const overrides = { verifyOperationApproval: jest.fn() };
      await expect(assertOrderCancellationAllowed(
        ctxFor(['pos:checkout'], overrides) as any, txWith([firedLine]), 'o1',
        { reason: 'Customer left', overrideById: 'mgr-1', overridePin: '1234' },
      )).rejects.toThrow(/void permission/i);
    });

    it('refuses the auto-filled placeholder reason', async () => {
      const overrides = { verifyOperationApproval: jest.fn() };
      await expect(assertOrderCancellationAllowed(
        ctxFor(['pos:void'], overrides) as any, txWith([firedLine]), 'o1',
        { reason: 'Order emptied', overrideById: 'mgr-1', overridePin: '1234' },
      )).rejects.toThrow(/give a reason/i);
    });

    it('refuses when no manager approved it', async () => {
      const overrides = { verifyOperationApproval: jest.fn() };
      await expect(assertOrderCancellationAllowed(
        ctxFor(['pos:void'], overrides) as any, txWith([firedLine]), 'o1',
        { reason: 'Customer left before service' },
      )).rejects.toThrow(/manager approval and PIN/i);
      expect(overrides.verifyOperationApproval).not.toHaveBeenCalled();
    });

    it('verifies the approval as a VOID, so a discount grant cannot be replayed', async () => {
      const overrides = { verifyOperationApproval: jest.fn().mockResolvedValue({ id: 'mgr-1' }) };
      const fired = await assertOrderCancellationAllowed(
        ctxFor(['pos:void'], overrides) as any, txWith([firedLine, unfiredLine]), 'o1',
        { reason: 'Customer left before service', overrideById: 'mgr-1', overridePin: '1234' },
      );
      expect(overrides.verifyOperationApproval).toHaveBeenCalledWith('mgr-1', '1234', 'void');
      expect(fired).toEqual([{ id: 'i1', description: 'Nile Special', quantity: 2, kitchenPrintedQty: 2 }]);
    });
  });

  describe('cancelOrder wires the policy in', () => {
    const order = { id: 'o1', organizationId: orgId, orderNumber: 'ORD-1', status: 'confirmed', tableId: 't1', version: 3, invoiceId: null };
    let tx: any;
    let audit: any;
    let overrides: any;

    const build = (permissions: string[], items: any[]) => {
      tx = {
        order: { findFirst: jest.fn().mockResolvedValue(order), update: jest.fn().mockResolvedValue(order) },
        orderItem: { findMany: jest.fn().mockResolvedValue(items), count: jest.fn().mockResolvedValue(items.length) },
        posTable: { findFirst: jest.fn().mockResolvedValue({ id: 't1', status: 'occupied' }), update: jest.fn() },
        $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      };
      audit = { record: jest.fn().mockResolvedValue(undefined), recordInTx: jest.fn().mockResolvedValue(undefined) };
      overrides = { verifyOperationApproval: jest.fn().mockResolvedValue({ id: 'mgr-1' }) };
      const prisma = {
        client: { $transaction: jest.fn(async (cb: any) => cb(tx)), order: { findFirst: jest.fn().mockResolvedValue(order) } },
        raw: { user: { findFirst: jest.fn().mockResolvedValue({ id: 'cashier-1', roles: [{ permissions }] }) } },
      };
      return new PosOrdersService(
        prisma as any, { organizationId: orgId, userId: 'cashier-1' } as any, audit as any,
        { publish: jest.fn() } as any, { next: jest.fn() } as any, {} as any,
        {} as any, {} as any, {} as any, {} as any, overrides as any,
        {} as any, { transition: jest.fn().mockResolvedValue({}) } as any, {} as any,
      );
    };

    it('still cancels an unfired order with no reason and no manager', async () => {
      await build(['pos:checkout'], [unfiredLine]).cancelOrder('o1');
      expect(overrides.verifyOperationApproval).not.toHaveBeenCalled();
      expect(tx.order.update).toHaveBeenCalled();
    });

    it('blocks the fire, serve, clear-the-cart route', async () => {
      const svc = build(['pos:checkout'], [firedLine]);
      await expect(svc.cancelOrder('o1', 'Order emptied', 3)).rejects.toThrow(/void permission/i);
      expect(tx.order.update).not.toHaveBeenCalled();
    });

    it('names the cooked items in the audit row when it does go through', async () => {
      const svc = build(['pos:void'], [firedLine]);
      await svc.cancelOrder('o1', 'Customer walked out', 3, { overrideById: 'mgr-1', overridePin: '1234' });
      const row = audit.recordInTx.mock.calls.find((c: any) => c[1]?.action === 'cancel');
      expect(row).toBeDefined();
      expect(row[1].newValues).toMatchObject({
        reason: 'Customer walked out',
        approvedById: 'mgr-1',
        firedItems: [{ description: 'Nile Special', quantity: 2, firedQuantity: 2 }],
      });
    });
  });
});
