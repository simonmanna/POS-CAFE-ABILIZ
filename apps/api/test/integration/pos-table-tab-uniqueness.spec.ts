import { PrismaClient } from '@prisma/client';
import { describeDb } from './_setup';

/**
 * Audit #2 N-04 — one open dine-in tab per table, proven at the database.
 *
 * The defect: `PosOrdersService.createOrder` enforced this with a bare SELECT
 * inside a READ COMMITTED transaction. Two terminals opening the same table at
 * the same moment both read "no open tab" and both inserted. The second tab is
 * invisible to `getOpenOrderForTable` (it returns one row and filters
 * `invoiceId: null`), so its food is served and never billed, and the table
 * stays held until someone finds the row in the database.
 *
 * The service now takes a `FOR UPDATE` lock on the PosTable row, which closes
 * the race for that code path. These tests deliberately bypass the service and
 * write through Prisma directly, because the point of migration
 * `20260907120000_one_open_tab_per_table` is that the invariant is true of the
 * DATA — not of one function that happens to check it. A future endpoint, an
 * Android sync replay or a manual fix-up script gets the same answer.
 *
 * The carve-outs matter as much as the rule: a BILLED order still holds the
 * table but must not block the next round on it, and a cancelled or closed
 * order must not hold it at all.
 */
describeDb('N-04 — one open dine-in tab per table', () => {
  const prisma = new PrismaClient();
  let orgId: string;
  let partnerId: string;
  let tableId: string;

  const openTab = (over: Record<string, unknown> = {}) => ({
    organizationId: orgId,
    orderNumber: `N04-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    orderType: 'dine_in' as const,
    status: 'confirmed' as const,
    tableId,
    partnerId,
    ...over,
  });

  beforeAll(async () => {
    await prisma.$connect();
    const org = await prisma.organization.create({
      data: { code: `INT-N04-${Date.now()}`, name: 'Tab Uniqueness', currencyCode: 'UGX' },
    });
    orgId = org.id;
    const p = await prisma.partner.create({
      data: { organizationId: orgId, code: 'WALKIN', name: 'Walk-in', isCustomer: true },
    });
    partnerId = p.id;
    const table = await prisma.posTable.create({
      data: { organizationId: orgId, number: 400, name: 'N04-Table', seats: 4, zone: 'indoor', status: 'available' },
    });
    tableId = table.id;
  });

  afterEach(async () => {
    await prisma.orderItem.deleteMany({ where: { organizationId: orgId } });
    await prisma.order.deleteMany({ where: { organizationId: orgId } });
  });

  afterAll(async () => {
    if (orgId) {
      await prisma.orderItem.deleteMany({ where: { organizationId: orgId } });
      await prisma.order.deleteMany({ where: { organizationId: orgId } });
      await prisma.posTable.deleteMany({ where: { organizationId: orgId } });
      await prisma.partner.deleteMany({ where: { organizationId: orgId } });
      await prisma.organization.delete({ where: { id: orgId } });
    }
    await prisma.$disconnect();
  });

  it('refuses a second open tab on the same table', async () => {
    await prisma.order.create({ data: openTab() });
    await expect(prisma.order.create({ data: openTab() })).rejects.toThrow(/unique|constraint/i);
    expect(await prisma.order.count({ where: { organizationId: orgId, tableId } })).toBe(1);
  });

  /**
   * The race itself. Both inserts are issued before either resolves, so they
   * reach Postgres concurrently — exactly the two-terminal case. Without the
   * index both commit; with it, one is rejected.
   */
  it('lets exactly one of two concurrent opens win', async () => {
    const results = await Promise.allSettled([
      prisma.order.create({ data: openTab() }),
      prisma.order.create({ data: openTab() }),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(await prisma.order.count({ where: { organizationId: orgId, tableId } })).toBe(1);
  });

  it('does not block a fresh round once the first order is billed', async () => {
    const invoice = await prisma.invoice.create({
      data: {
        organizationId: orgId,
        invoiceNumber: `N04-INV-${Date.now()}`,
        partnerId,
        issueDate: new Date(),
        subtotal: 0, taxAmount: 0, totalAmount: 0, amountResidual: 0,
        status: 'posted',
      },
    });
    await prisma.order.create({ data: openTab({ invoiceId: invoice.id, status: 'completed' }) });

    // A billed order still holds the table, but the next party's round must be
    // able to start — the guard in createOrder makes the same carve-out.
    await expect(prisma.order.create({ data: openTab() })).resolves.toBeDefined();
    expect(await prisma.order.count({ where: { organizationId: orgId, tableId } })).toBe(2);

    await prisma.order.deleteMany({ where: { organizationId: orgId } });
    await prisma.invoice.delete({ where: { id: invoice.id } });
  });

  it('does not let a cancelled or closed order hold the table', async () => {
    await prisma.order.create({ data: openTab({ status: 'cancelled' }) });
    await prisma.order.create({ data: openTab({ status: 'closed' }) });
    await expect(prisma.order.create({ data: openTab() })).resolves.toBeDefined();
  });

  it('scopes the rule per organization and per table', async () => {
    const other = await prisma.posTable.create({
      data: { organizationId: orgId, number: 401, name: 'N04-Other', seats: 2, zone: 'indoor', status: 'available' },
    });
    await prisma.order.create({ data: openTab() });
    await expect(prisma.order.create({ data: openTab({ tableId: other.id }) })).resolves.toBeDefined();
    await prisma.order.deleteMany({ where: { organizationId: orgId } });
    await prisma.posTable.delete({ where: { id: other.id } });
  });

  /**
   * Regression guard. The first cut of this index broke split-bill settlement:
   * `PosSplitService.settleBill` raises a second dine-in order on the SAME table
   * (via `createOrderFromResolved`) and invoices it inside the same transaction,
   * while the source tab is still open and unbilled. That is a bill-carrier, not
   * a tab the floor opened, and it is marked `sourceDocumentType`.
   */
  it('lets a split bill raise its bill-carrier order on an occupied table', async () => {
    await prisma.order.create({ data: openTab() });
    await expect(
      prisma.order.create({ data: openTab({ sourceDocumentType: 'pos_split_bill' }) }),
    ).resolves.toBeDefined();
    // …and two carriers can coexist while several split bills settle.
    await expect(
      prisma.order.create({ data: openTab({ sourceDocumentType: 'pos_split_bill' }) }),
    ).resolves.toBeDefined();
  });

  it('ignores takeaway and delivery orders, which carry no table', async () => {
    await prisma.order.create({ data: openTab({ orderType: 'takeaway', tableId: null }) });
    await expect(
      prisma.order.create({ data: openTab({ orderType: 'takeaway', tableId: null }) }),
    ).resolves.toBeDefined();
  });
});
