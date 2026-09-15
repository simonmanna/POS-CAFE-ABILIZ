import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { scopedPrisma } from '../scoped-prisma';
import { PosReceiptsService } from '../../src/modules/pos/pos-receipts.service';
import { PosPrintLifecycleService } from '../../src/modules/pos/pos-print-lifecycle.service';

/**
 * Paper KOT behaves like the bill: the first KOT prints the whole order, a
 * later one only what was added since. Regression: auto-send put station-routed
 * lines on the KDS on every save (kitchenPrintedQty = quantity), and the KOT
 * compared against that — so the very first KOT said "No new items".
 */
const isolated = !!process.env.DATABASE_URL && /^\/pos_stage1_\d+$/.test(new URL(process.env.DATABASE_URL!).pathname);
(isolated ? describe : describe.skip)('Stage 1: paper KOT deltas', () => {
  const org = randomUUID();
  const db = scopedPrisma(new PrismaClient(), () => org);
  let receipts: PosReceiptsService, orderId: string, latteId: string;

  beforeAll(async () => {
    await db.$connect();
    await db.currency.upsert({ where: { code: 'USD' }, update: {}, create: { code: 'USD', name: 'US Dollar', symbol: '$' } });
    await db.organization.create({ data: { id: org, code: `KOT-${Date.now()}`, name: 'Isolated KOT', currencyCode: 'USD' } });
    const txRun = (fn: (tx: any) => Promise<any>) => db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${org}, true)`;
      return fn(tx);
    }, { timeout: 20000 });
    const client = new Proxy(db, { get(target, prop) { return prop === '$transaction' ? txRun : Reflect.get(target, prop); } });
    const prisma: any = { client, raw: db };
    const tenant: any = { organizationId: org, userId: null, optionalOrganizationId: org };
    const settings: any = { get: async () => null };
    receipts = new PosReceiptsService(prisma, tenant, { record: jest.fn(), recordInTx: jest.fn() } as any, {} as any, settings, new PosPrintLifecycleService(prisma, settings, tenant));
    const order = await db.order.create({
      data: {
        organizationId: org, orderNumber: 'ORD-KOT-1', orderType: 'dine_in', status: 'confirmed',
        items: {
          create: [
            // Both already on the KDS board via auto-send, never on paper.
            { organizationId: org, menuItemId: randomUUID(), description: 'Latte', quantity: 2, unitPrice: 5000, kitchenPrintedQty: 2, kitchenStatus: 'sent', lineNumber: 1 },
            { organizationId: org, menuItemId: randomUUID(), description: 'Croissant', quantity: 1, unitPrice: 4000, kitchenPrintedQty: 1, kitchenStatus: 'sent', lineNumber: 2 },
          ],
        },
      } as any,
      include: { items: true },
    });
    orderId = order.id;
    latteId = order.items.find((i: any) => i.description === 'Latte')!.id;
  }, 30000);

  afterAll(async () => { await db.$disconnect(); });

  it('first KOT prints the whole order even though the KDS already has it', async () => {
    const first = await receipts.printKotDelta(orderId);
    expect(first.printedCount).toBe(2);
    expect(first.text).toMatch(/Latte/);
    expect(first.text).toMatch(/Croissant/);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).kotPrintCount).toBe(1);
  });

  it('pressing KOT again prints nothing', async () => {
    const again = await receipts.printKotDelta(orderId);
    expect(again.printedCount).toBe(0);
  });

  it('an additional KOT prints only the added quantity', async () => {
    await db.orderItem.update({ where: { id: latteId }, data: { quantity: 3 } });
    const extra = await receipts.printKotDelta(orderId);
    expect(extra.printedCount).toBe(1);
    expect(extra.text).toMatch(/Latte/);
    expect(extra.text).not.toMatch(/Croissant/);
    expect(Number((await db.orderItem.findUniqueOrThrow({ where: { id: latteId } })).kotPrintedQty)).toBe(3);
    expect((await receipts.printKotDelta(orderId)).printedCount).toBe(0);
  });
});
