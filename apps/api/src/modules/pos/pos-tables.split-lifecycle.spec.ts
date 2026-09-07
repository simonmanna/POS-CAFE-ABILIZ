/* eslint-disable @typescript-eslint/no-explicit-any */
import { PosTablesService } from './pos-tables.service';

/**
 * Audit #2 N-08b — splitting a bill must not re-fire the kitchen.
 *
 * The defect: `splitBill` stashed each source line's kitchen lifecycle in a map
 * keyed on `productId`, then copied it onto the child lines. A cafe line is a
 * MenuItem — it carries `menuItemId` and NO `productId` — so the lookup was
 * always null, the child inherited `kitchenPrintedQty: null`, and the next fire
 * computed `delta = full quantity`. Splitting a table's bill re-sent every dish
 * to the kitchen: duplicate cooking, duplicate KOTs, wasted food, on one of the
 * most routine operations in a restaurant.
 *
 * The mirror defect: for product lines it copied the source's WHOLE fired
 * quantity onto EACH child, so splitting 4 fired beers 3 + 1 left the 3-line
 * claiming 4 fired. Adding a 4th beer to that child then produced delta 0 and
 * the kitchen never saw it.
 *
 * What must hold now: fired quantity is carried per SOURCE LINE (exact — the id
 * is already on every split line) and ALLOCATED across the children.
 */
describe('N-08b — split bill preserves the kitchen lifecycle', () => {
  const orgId = 'org-1';
  const tableId = 't1';

  let tx: any;
  let svc: PosTablesService;
  /** Every orderItem.update issued during the split, in order. */
  let updates: Array<{ where: any; data: any }>;
  /** Rows `rebuildOrderItems` created, per child order id. */
  let createdByOrder: Map<string, any[]>;

  /**
   * Drive `splitBill` over a source order whose lines look like whatever the
   * caller describes, and return the lifecycle each child line ended up with.
   */
  const runSplit = async (
    sourceItems: Array<{ id: string; description: string; quantity: number; fired: number | null; productId?: string | null }>,
    splits: Array<{ label: string; lines: Array<{ sourceItemId: string; quantity: number }> }>,
  ) => {
    const items = sourceItems.map((s, i) => ({
      id: s.id,
      organizationId: orgId,
      orderId: 'src-order',
      lineNumber: i + 1,
      // The cafe shape: a MenuItem line has no productId at all.
      productId: s.productId ?? null,
      menuItemId: s.productId ? null : `menu-${s.id}`,
      description: s.description,
      quantity: s.quantity,
      unitPrice: 10000,
      discountPercent: 0,
      taxId: null,
      taxInclusive: false,
      modifiers: [],
      cancelled: false,
      kitchenPrintedQty: s.fired,
      kitchenStatus: s.fired ? 'sent' : 'pending',
      kitchenPrintCount: s.fired ? 1 : 0,
      kitchenLastPrintedAt: s.fired ? new Date('2026-09-07T10:00:00Z') : null,
      cancelPrintCount: 0,
      cancelLastPrintedAt: null,
      lastKitchenPrintedById: s.fired ? 'waiter-1' : null,
    }));

    tx.order.findFirst.mockResolvedValue({
      id: 'src-order', organizationId: orgId, orderNumber: 'ORD-9', orderType: 'dine_in',
      status: 'confirmed', invoiceId: null, tableId, partnerId: 'p1', branchId: null, items,
    });

    await svc.splitBill({ tableId, sourceOrderId: 'src-order', splits } as any);

    // Map each update back to the child row it targeted.
    const rowById = new Map<string, any>();
    for (const rows of createdByOrder.values()) for (const r of rows) rowById.set(r.id, r);
    return updates
      .filter((u) => rowById.has(u.where.id))
      .map((u) => ({ quantity: Number(rowById.get(u.where.id).quantity), ...u.data }));
  };

  beforeEach(() => {
    updates = [];
    createdByOrder = new Map();
    let childSeq = 0;

    tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      posTable: {
        findFirst: jest.fn().mockResolvedValue({ id: tableId, organizationId: orgId, status: 'occupied', number: 5 }),
        update: jest.fn(),
      },
      order: {
        findFirst: jest.fn(),
        create: jest.fn(async ({ data }: any) => {
          const id = `child-${++childSeq}`;
          createdByOrder.set(id, []);
          return { id, ...data };
        }),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      posTableOrder: {
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      orderItem: {
        // rebuildOrderItems reads the old rows, deletes them, then re-creates.
        findMany: jest.fn(async ({ where, orderBy }: any) => {
          const rows = createdByOrder.get(where.orderId) ?? [];
          return orderBy ? [...rows].sort((a, b) => a.lineNumber - b.lineNumber) : rows;
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `ci-${data.orderId}-${data.lineNumber}`, ...data };
          (createdByOrder.get(data.orderId) ?? []).push(row);
          return row;
        }),
        update: jest.fn(async (args: any) => { updates.push(args); return {}; }),
        count: jest.fn().mockResolvedValue(1),
      },
      orderItemModifier: { createMany: jest.fn(), deleteMany: jest.fn() },
    };

    const prisma = { client: { $transaction: jest.fn(async (cb: any) => cb(tx)) } };
    const builder = {
      // Identity pricing: this spec is about the kitchen lifecycle, not tax.
      prepareLines: jest.fn(async (_db: any, lines: any[]) => ({
        subtotal: 0, discountTotal: 0, taxAmount: 0, total: 0,
        prepared: lines.map((l, i) => ({ ...l, lineNumber: i + 1, subtotal: 0, taxAmount: 0, total: 0 })),
      })),
    };

    svc = new PosTablesService(
      prisma as any,
      { organizationId: orgId, userId: 'cashier-1' } as any,
      { record: jest.fn(), recordInTx: jest.fn().mockResolvedValue(undefined) } as any,
      { publish: jest.fn(), subscribe: jest.fn(), on: jest.fn() } as any,
      builder as any,
      { next: jest.fn().mockResolvedValue('ORD-NEW') } as any,
      {} as any,
      { transition: jest.fn().mockResolvedValue({}) } as any,
    );
  });

  it('carries fired quantity onto MenuItem children (the cafe re-fire bug)', async () => {
    const applied = await runSplit(
      [{ id: 'i1', description: 'Rolex', quantity: 2, fired: 2 }],
      [
        { label: 'A', lines: [{ sourceItemId: 'i1', quantity: 1 }] },
        { label: 'B', lines: [{ sourceItemId: 'i1', quantity: 1 }] },
      ],
    );

    // Before the fix this array was EMPTY — `productId` was null so the loop
    // hit `continue` for every child, leaving kitchenPrintedQty null and the
    // whole order primed to re-fire.
    expect(applied).toHaveLength(2);
    for (const a of applied) {
      expect(a.kitchenPrintedQty).toBe(a.quantity);
      expect(a.kitchenStatus).toBe('sent');
    }
  });

  it('allocates fired quantity across children instead of copying it to each', async () => {
    const applied = await runSplit(
      [{ id: 'i1', description: 'Nile Special', quantity: 4, fired: 4, productId: 'p-beer' }],
      [
        { label: 'A', lines: [{ sourceItemId: 'i1', quantity: 3 }] },
        { label: 'B', lines: [{ sourceItemId: 'i1', quantity: 1 }] },
      ],
    );

    const byQty = new Map(applied.map((a) => [a.quantity, a.kitchenPrintedQty]));
    expect(byQty.get(3)).toBe(3);
    expect(byQty.get(1)).toBe(1);
    // The old code wrote 4 onto both, so the total claimed was 8 for 4 beers.
    expect(applied.reduce((s, a) => s + Number(a.kitchenPrintedQty ?? 0), 0)).toBe(4);
  });

  it('leaves a child unfired when the source line was only partly fired', async () => {
    // 3 ordered, only 2 ever sent to the kitchen.
    const applied = await runSplit(
      [{ id: 'i1', description: 'Chapati', quantity: 3, fired: 2 }],
      [
        { label: 'A', lines: [{ sourceItemId: 'i1', quantity: 2 }] },
        { label: 'B', lines: [{ sourceItemId: 'i1', quantity: 1 }] },
      ],
    );

    const first = applied.find((a) => a.quantity === 2)!;
    const second = applied.find((a) => a.quantity === 1)!;
    expect(first.kitchenPrintedQty).toBe(2);
    // Nothing left to claim — this one genuinely still has to reach the kitchen.
    expect(second.kitchenPrintedQty).toBeNull();
    expect(second.kitchenStatus).toBe('pending');
  });

  it('does not invent a fired quantity for an order the kitchen never saw', async () => {
    const applied = await runSplit(
      [{ id: 'i1', description: 'Water', quantity: 2, fired: null }],
      [
        { label: 'A', lines: [{ sourceItemId: 'i1', quantity: 1 }] },
        { label: 'B', lines: [{ sourceItemId: 'i1', quantity: 1 }] },
      ],
    );

    for (const a of applied) {
      expect(a.kitchenPrintedQty).toBeNull();
      expect(a.kitchenStatus).toBe('pending');
    }
  });
});
