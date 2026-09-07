/* eslint-disable @typescript-eslint/no-explicit-any */
import { PosOrdersService } from './pos-orders.service';

/**
 * A-016 / audit F-01 — an OrderItem is never deleted.
 *
 * The defect these tests lock down: `writeItems` used to `deleteMany` the whole
 * item set on every auto-save and re-create it, so a line taken off a cart left
 * NO trace — no audit row, no cancellation flag, no reason, no approver. A
 * waiter could fire an item to the kitchen, serve it, drop it before billing and
 * pocket the cash, and nothing in the order remembered the item had existed.
 *
 * What must hold now:
 *   1. a removed line is SOFT-cancelled, with who/when/why;
 *   2. the save writes one audit row carrying the whole diff;
 *   3. a line the kitchen already has cannot leave through a plain save at all;
 *   4. nor can its quantity be cut below what was fired;
 *   5. voiding demands a reason, and a manager once the kitchen is involved;
 *   6. a partial void pulls `kitchenPrintedQty` down so a re-fire cannot re-send
 *      what was just taken off.
 */
describe('PosOrdersService — item void is auditable (A-016)', () => {
  const orgId = 'org-1';
  let prisma: any;
  let tenant: any;
  let audit: any;
  let events: any;
  let kds: any;
  let overrides: any;
  let orderItem: any;
  let svc: PosOrdersService;

  /** One line, already fired to the kitchen at qty 2. */
  const firedRow = () => ({
    id: 'item-fired', orderId: 'o1', organizationId: orgId,
    productId: 'p1', menuItemId: null, variantName: null,
    description: 'Nile Special', quantity: 2, unitPrice: 6000,
    discountPercent: 0, discountType: 'percentage', discountAmount: 0, discountReason: null,
    taxId: null, taxInclusive: false, note: null, course: null,
    accompanimentNames: [], accompanimentOptionIds: [], modifiers: [],
    kitchenPrintedQty: 2, kitchenStatus: 'sent', kitchenPrintCount: 1,
    kitchenLastPrintedAt: new Date(), cancelPrintCount: 0, cancelLastPrintedAt: null,
    lastKitchenPrintedById: 'u1', cancelled: false, voidedQty: null,
  });

  /** The same line, never sent to the kitchen. */
  const unfiredRow = () => ({ ...firedRow(), id: 'item-unfired', description: 'Still Water', kitchenPrintedQty: null, kitchenStatus: 'pending', kitchenPrintCount: 0 });

  const order = { id: 'o1', organizationId: orgId, orderNumber: 'ORD-1', status: 'confirmed', tableId: 't1', version: 3, invoiceId: null, cashSessionId: null, transactionDiscountType: 'percentage', transactionDiscountPercent: 0, transactionDiscountAmount: 0, discountReason: null };

  beforeEach(() => {
    tenant = { organizationId: orgId, userId: 'cashier-1' };
    audit = { record: jest.fn().mockResolvedValue(undefined), recordInTx: jest.fn().mockResolvedValue(undefined) };
    events = { publish: jest.fn() };
    kds = { cancelOrderItemTickets: jest.fn().mockResolvedValue(1) };
    overrides = { verifyOperationApproval: jest.fn().mockResolvedValue({ id: 'mgr-1' }) };

    orderItem = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(async ({ data }: any) => ({ id: 'new-item', ...data })),
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    };

    const tx = {
      order: { findFirst: jest.fn().mockResolvedValue(order), update: jest.fn().mockResolvedValue(order) },
      orderItem,
      orderItemModifier: { createMany: jest.fn(), deleteMany: jest.fn() },
      posTable: { findFirst: jest.fn().mockResolvedValue({ id: 't1', status: 'occupied' }), update: jest.fn() },
      cashSession: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    };

    prisma = {
      client: {
        $transaction: jest.fn(async (cb: any) => cb(tx)),
        order: { findFirst: jest.fn().mockResolvedValue(order) },
        orderItem,
      },
      raw: {},
      __tx: tx,
    };

    const builder = {
      // Identity pricing: these tests are about the item lifecycle, not tax.
      prepareLines: jest.fn(async (_db: any, lines: any[]) => ({
        subtotal: 0, discountTotal: 0, taxAmount: 0, total: 0,
        prepared: lines.map((l, i) => ({ ...l, lineNumber: i + 1, subtotal: 0, taxAmount: 0, total: 0 })),
      })),
    };

    svc = new PosOrdersService(
      prisma as any, tenant as any, audit as any, events as any,
      { next: jest.fn() } as any, builder as any,
      {} as any, {} as any, {} as any, kds as any, overrides as any,
      {} as any, { transition: jest.fn().mockResolvedValue({}) } as any, {} as any,
    );
  });

  const writeItems = (resolved: any[], opts: any) =>
    (svc as any).writeItems(prisma.__tx, 'o1', resolved, opts);

  const resolvedLine = (over: any = {}) => ({
    productId: 'p1', menuItemId: null, description: 'Nile Special', quantity: 2, unitPrice: 6000,
    taxId: null, discountPercent: 0, discountType: undefined, discountAmount: undefined,
    discountReason: null, note: null, taxInclusive: false, modifiers: [],
    variantId: undefined, variantName: undefined, accompanimentNames: [], accompanimentOptionIds: [],
    course: null, ...over,
  });

  describe('a plain save', () => {
    it('soft-cancels a dropped line instead of deleting it', async () => {
      orderItem.findMany.mockResolvedValue([unfiredRow()]);

      await writeItems([], { replace: true });

      expect(orderItem.deleteMany).not.toHaveBeenCalled();
      const cancel = orderItem.update.mock.calls.find((c: any) => c[0].data?.cancelled === true);
      expect(cancel).toBeDefined();
      expect(cancel[0].where.id).toBe('item-unfired');
      expect(cancel[0].data).toMatchObject({ cancelled: true, voidedBy: 'cashier-1', voidedQty: 2 });
      expect(cancel[0].data.cancelledAt).toBeInstanceOf(Date);
      expect(String(cancel[0].data.cancelReason)).toMatch(/removed/i);
    });

    it('writes one audit row carrying the whole diff', async () => {
      orderItem.findMany.mockResolvedValue([unfiredRow()]);

      // A different catalog item, so it cannot match the existing row's
      // signature (which keys on product identity, not the printed name).
      await writeItems([resolvedLine({ productId: 'p2', description: 'Chapati' })], { replace: true });

      const diff = audit.recordInTx.mock.calls
        .map((c: any) => c[1])
        .find((v: any) => v?.newValues?.kind === 'items_saved');
      expect(diff).toBeDefined();
      expect(diff.entityId).toBe('o1');
      expect(diff.newValues.added).toEqual([{ description: 'Chapati', quantity: 2 }]);
      expect(diff.newValues.removed).toEqual([{ description: 'Still Water', quantity: 2 }]);
    });

    it('reports a quantity change as requantified, not as an add plus a remove', async () => {
      orderItem.findMany.mockResolvedValue([firedRow()]);

      await writeItems([resolvedLine({ quantity: 5 })], { replace: true });

      const diff = audit.recordInTx.mock.calls
        .map((c: any) => c[1])
        .find((v: any) => v?.newValues?.kind === 'items_saved');
      expect(diff.newValues).toEqual({
        kind: 'items_saved',
        added: [],
        requantified: [{ description: 'Nile Special', from: 2, to: 5 }],
        removed: [],
      });
    });

    it('keeps a matched line on its own row, preserving its kitchen lifecycle', async () => {
      orderItem.findMany.mockResolvedValue([firedRow()]);

      await writeItems([resolvedLine({ quantity: 3 })], { replace: true });

      expect(orderItem.create).not.toHaveBeenCalled();
      const upd = orderItem.update.mock.calls.find((c: any) => c[0].where.id === 'item-fired');
      expect(upd[0].data.quantity).toBe(3);
      // The lifecycle columns are absent from the update payload, so the row
      // keeps what it was fired with.
      expect(upd[0].data).not.toHaveProperty('kitchenPrintedQty');
      expect(upd[0].data).not.toHaveProperty('kitchenStatus');
    });

    it('refuses to drop a line the kitchen already has', async () => {
      orderItem.findMany.mockResolvedValue([firedRow()]);

      await expect(writeItems([], { replace: true })).rejects.toThrow(/already sent to the kitchen/i);
      expect(orderItem.update).not.toHaveBeenCalled();
    });

    it('refuses to cut a fired line below the quantity that was fired', async () => {
      orderItem.findMany.mockResolvedValue([firedRow()]);

      await expect(writeItems([resolvedLine({ quantity: 1 })], { replace: true }))
        .rejects.toThrow(/already sent to the kitchen/i);
    });

    it('still allows a fired line to be increased', async () => {
      orderItem.findMany.mockResolvedValue([firedRow()]);
      await expect(writeItems([resolvedLine({ quantity: 5 })], { replace: true })).resolves.toBeUndefined();
    });
  });

  describe('voidItem', () => {
    beforeEach(() => {
      orderItem.findMany.mockResolvedValue([]);
    });

    it('requires a reason', async () => {
      await expect(svc.voidItem('o1', 'item-unfired', { reason: '   ' } as any))
        .rejects.toThrow(/reason is required/i);
    });

    it('voids an unfired line with no manager approval', async () => {
      orderItem.findFirst.mockResolvedValue(unfiredRow());
      jest.spyOn(svc, 'getOrder').mockResolvedValue({ id: 'o1' } as any);

      await svc.voidItem('o1', 'item-unfired', { reason: 'Wrong item' } as any);

      expect(overrides.verifyOperationApproval).not.toHaveBeenCalled();
      const upd = orderItem.update.mock.calls.find((c: any) => c[0].where.id === 'item-unfired');
      expect(upd[0].data).toMatchObject({ cancelled: true, cancelReason: 'Wrong item', voidedBy: 'cashier-1', voidedQty: 2 });
    });

    it('refuses to void a fired line without a manager', async () => {
      orderItem.findFirst.mockResolvedValue(firedRow());

      await expect(svc.voidItem('o1', 'item-fired', { reason: 'Sent back' } as any))
        .rejects.toThrow(/manager approval/i);
    });

    it('accepts a fired line once a manager signs for it, and clears the kitchen ticket', async () => {
      orderItem.findFirst.mockResolvedValue(firedRow());
      jest.spyOn(svc, 'getOrder').mockResolvedValue({ id: 'o1' } as any);

      await svc.voidItem('o1', 'item-fired', { reason: 'Sent back', overrideById: 'mgr-1', overridePin: '1234' } as any);

      expect(overrides.verifyOperationApproval).toHaveBeenCalledWith('mgr-1', '1234', 'void');
      const upd = orderItem.update.mock.calls.find((c: any) => c[0].where.id === 'item-fired');
      expect(upd[0].data).toMatchObject({ cancelled: true, voidApprovedBy: 'mgr-1', voidedQty: 2 });
      expect(kds.cancelOrderItemTickets).toHaveBeenCalledWith('o1', 'item-fired', null, expect.stringMatching(/Sent back/));
      expect(events.publish).toHaveBeenCalledWith('pos.order.item_voided', expect.objectContaining({ orderItemId: 'item-fired', whole: true }));
    });

    it('records who, why and how much on the audit ledger', async () => {
      orderItem.findFirst.mockResolvedValue(firedRow());
      jest.spyOn(svc, 'getOrder').mockResolvedValue({ id: 'o1' } as any);

      await svc.voidItem('o1', 'item-fired', { reason: 'Spilled', overrideById: 'mgr-1', overridePin: '1234' } as any);

      const row = audit.recordInTx.mock.calls.map((c: any) => c[1]).find((v: any) => v?.newValues?.kind === 'item_void');
      expect(row).toMatchObject({
        entity: 'OrderItem', entityId: 'item-fired', action: 'cancel',
        newValues: expect.objectContaining({
          description: 'Nile Special', voidedQuantity: 2, whole: true,
          reason: 'Spilled', approvedById: 'mgr-1', hadBeenFired: true,
        }),
      });
    });

    it('pulls kitchenPrintedQty down on a partial void so a re-fire cannot re-send it', async () => {
      orderItem.findFirst.mockResolvedValue(firedRow());
      jest.spyOn(svc, 'getOrder').mockResolvedValue({ id: 'o1' } as any);

      await svc.voidItem('o1', 'item-fired', { reason: 'One returned', quantity: 1, overrideById: 'mgr-1', overridePin: '1234' } as any);

      const upd = orderItem.update.mock.calls.find((c: any) => c[0].where.id === 'item-fired');
      expect(upd[0].data).toMatchObject({ quantity: 1, kitchenPrintedQty: 1, voidedQty: 1 });
      expect(upd[0].data.cancelled).toBeUndefined();
      expect(kds.cancelOrderItemTickets).toHaveBeenCalledWith('o1', 'item-fired', 1, expect.any(String));
    });

    it('rejects a void quantity larger than the line', async () => {
      orderItem.findFirst.mockResolvedValue(firedRow());
      await expect(svc.voidItem('o1', 'item-fired', { reason: 'x', quantity: 9, overrideById: 'mgr-1', overridePin: '1' } as any))
        .rejects.toThrow(/between 0 and 2/i);
    });

    it('refuses to void the same line twice', async () => {
      orderItem.findFirst.mockResolvedValue({ ...firedRow(), cancelled: true });
      await expect(svc.voidItem('o1', 'item-fired', { reason: 'x' } as any))
        .rejects.toThrow(/already been voided/i);
    });
  });
});
