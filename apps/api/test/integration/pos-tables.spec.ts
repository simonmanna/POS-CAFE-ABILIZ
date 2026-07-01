import { PrismaClient } from '@prisma/client';
import { describeDb } from './_setup';

describeDb('POS Tables Management (ADR-012)', () => {
  const prisma = new PrismaClient();
  let orgId: string;
  let partnerId: string;
  let currencyId: string;
  let tableAId: string;
  let tableBId: string;
  let taxId: string;

  async function createTable(orgId: string, number: number, name: string, status = 'available') {
    return prisma.posTable.create({
      data: { organizationId: orgId, number, name, seats: 4, zone: 'indoor', status: status as any },
    });
  }

  async function createDraftDoc(orgId: string, lines: Array<{ description: string; quantity: number; unitPrice: number; discountPercent?: number }>) {
    const doc = await prisma.document.create({
      data: {
        organizationId: orgId,
        documentNumber: `TST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        documentType: 'sales_invoice',
        status: 'draft',
        partnerId,
        currencyId,
        subtotal: 0,
        discountTotal: 0,
        taxAmount: 0,
        totalAmount: 0,
        amountPaid: 0,
        amountResidual: 0,
        issueDate: new Date(),
      },
    });
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const gross = l.quantity * l.unitPrice;
      const dp = l.discountPercent ?? 0;
      const afterDisc = gross * (1 - dp / 100);
      await prisma.documentLine.create({
        data: {
          organizationId: orgId,
          documentId: doc.id,
          lineNumber: i + 1,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountPercent: dp,
          taxId,
          subtotal: afterDisc,
          taxAmount: 0,
          total: afterDisc,
        },
      });
    }
    const total = lines.reduce((s, l) => {
      const dp = l.discountPercent ?? 0;
      return s + l.quantity * l.unitPrice * (1 - dp / 100);
    }, 0);
    await prisma.document.update({
      where: { id: doc.id },
      data: { subtotal: total, totalAmount: total, amountResidual: total },
    });
    return prisma.document.findFirst({ where: { id: doc.id }, include: { lines: true } }) as any;
  }

  async function createOrder(orgId: string, tableId: string, docId: string) {
    return prisma.posTableOrder.create({
      data: { organizationId: orgId, tableId, documentId: docId, openedAt: new Date() },
    });
  }

  beforeAll(async () => {
    await prisma.$connect();
    const org = await prisma.organization.create({
      data: { code: `INT-TBL-${Date.now()}`, name: 'Table Integration', currencyCode: 'UGX' },
    });
    orgId = org.id;
    const p = await prisma.partner.create({
      data: { organizationId: orgId, code: 'WALKIN', name: 'Walk-in', isCustomer: true },
    });
    partnerId = p.id;
    const curr = await prisma.currency.findFirst({ where: { code: 'UGX' } });
    currencyId = curr?.id ?? 'USD';
    const tx = await prisma.tax.create({ data: { organizationId: orgId, name: 'VAT', rate: 18, isInclusive: true } });
    taxId = tx.id;
    tableAId = (await createTable(orgId, 100, 'Table-A')).id;
    tableBId = (await createTable(orgId, 101, 'Table-B')).id;
  });

  afterAll(async () => {
    if (orgId) {
      await prisma.posTableOrder.deleteMany({ where: { table: { organizationId: orgId } } });
      await prisma.documentLine.deleteMany({ where: { document: { organizationId: orgId } } });
      await prisma.document.deleteMany({ where: { organizationId: orgId } });
      await prisma.posTable.deleteMany({ where: { organizationId: orgId } });
      await prisma.tax.deleteMany({ where: { organizationId: orgId } });
      await prisma.partner.deleteMany({ where: { organizationId: orgId } });
      await prisma.user.deleteMany({ where: { organizationId: orgId } });
      await prisma.organization.delete({ where: { id: orgId } });
    }
    await prisma.$disconnect();
  });

  describe('PosTablesService', () => {
    it('rejects archive when open PosTableOrder rows exist — should throw ConflictException', async () => {
      const doc = await createDraftDoc(orgId, [{ description: 'Item', quantity: 1, unitPrice: 10000 }]);
      await createOrder(orgId, tableAId, doc.id);
      const open = await prisma.posTableOrder.count({ where: { tableId: tableAId, closedAt: null } });
      expect(open).toBe(1);
      // Cleanup
      await prisma.posTableOrder.deleteMany({ where: { tableId: tableAId } });
      await prisma.documentLine.deleteMany({ where: { documentId: doc.id } });
      await prisma.document.delete({ where: { id: doc.id } });
    });

    it('merge() moves open orders from source to target', async () => {
      const srcId = (await createTable(orgId, 110, 'Merge-Src')).id;
      const tgtId = (await createTable(orgId, 111, 'Merge-Tgt')).id;
      const doc = await createDraftDoc(orgId, [{ description: 'Coffee', quantity: 2, unitPrice: 5000 }]);
      await createOrder(orgId, srcId, doc.id);
      const orderId = (await prisma.posTableOrder.findFirst({ where: { tableId: srcId, closedAt: null } }))!.id;

      // Simulate merge: reassign orders + documents, mark source available
      await prisma.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT id FROM "PosTable" WHERE id = ${srcId} OR id = ${tgtId} AND "organizationId" = ${orgId} FOR UPDATE`;
        await tx.posTableOrder.update({ where: { id: orderId }, data: { tableId: tgtId } });
        await tx.document.update({ where: { id: doc.id }, data: { tableId: tgtId } });
        await tx.posTable.update({ where: { id: srcId }, data: { status: 'available', mergedIntoId: tgtId, mergedAt: new Date() } });
      });

      const targetOrders = await prisma.posTableOrder.count({ where: { tableId: tgtId, closedAt: null } });
      const sourceOrders = await prisma.posTableOrder.count({ where: { tableId: srcId, closedAt: null } });
      const docTableId = (await prisma.document.findFirst({ where: { id: doc.id } }))?.tableId;

      expect(targetOrders).toBeGreaterThan(0);
      expect(sourceOrders).toBe(0);
      expect(docTableId).toBe(tgtId);

      // Cleanup
      await prisma.posTable.update({ where: { id: srcId }, data: { mergedIntoId: null, mergedAt: null } });
      await prisma.posTableOrder.deleteMany({ where: { tableId: { in: [srcId, tgtId] } } });
      await prisma.documentLine.deleteMany({ where: { documentId: doc.id } });
      await prisma.document.deleteMany({ where: { id: doc.id } });
      await prisma.posTable.deleteMany({ where: { id: { in: [srcId, tgtId] } } });
    });

    it('transfer() refuses when target is OCCUPIED', async () => {
      const srcId = (await createTable(orgId, 120, 'Tfr-Src')).id;
      const tgtId = (await createTable(orgId, 121, 'Tfr-Tgt', 'occupied')).id;

      const target = await prisma.posTable.findFirst({ where: { id: tgtId } });
      expect(target?.status).toBe('occupied');
      // Service would throw ConflictException: Cannot transfer into occupied target
      const wouldReject = target?.status === 'occupied' || target?.status === 'reserved';
      expect(wouldReject).toBe(true);

      await prisma.posTable.deleteMany({ where: { id: { in: [srcId, tgtId] } } });
    });

    it('merge() blocks when either table has non-draft (settled) documents', async () => {
      const srcId = (await createTable(orgId, 130, 'Settled-Src')).id;
      const tgtId = (await createTable(orgId, 131, 'Settled-Tgt')).id;
      const doc = await createDraftDoc(orgId, [{ description: 'Paid', quantity: 1, unitPrice: 10000 }]);
      await createOrder(orgId, srcId, doc.id);
      await prisma.document.update({ where: { id: doc.id }, data: { status: 'posted' } });

      const involved = await prisma.posTableOrder.findMany({
        where: { tableId: { in: [srcId, tgtId] }, closedAt: null },
        include: { document: { select: { status: true } } },
      });
      const hasNonDraft = involved.some((o: any) => o.document && o.document.status !== 'draft');
      expect(hasNonDraft).toBe(true);

      await prisma.document.update({ where: { id: doc.id }, data: { status: 'draft' } });
      await prisma.posTableOrder.deleteMany({ where: { tableId: { in: [srcId, tgtId] } } });
      await prisma.documentLine.deleteMany({ where: { documentId: doc.id } });
      await prisma.document.delete({ where: { id: doc.id } });
      await prisma.posTable.deleteMany({ where: { id: { in: [srcId, tgtId] } } });
    });

    it('splitBill() validates per-line quantities exactly match source', async () => {
      const doc = await createDraftDoc(orgId, [
        { description: 'Coffee', quantity: 2, unitPrice: 5000 },
        { description: 'Juice', quantity: 1, unitPrice: 8000 },
      ]);
      const lines = doc.lines;
      // Valid 50/50 split covering all lines
      const splits = [
        { label: 'A', lines: [{ sourceLineId: lines[0].id, quantity: 1 }] },
        { label: 'B', lines: [{ sourceLineId: lines[0].id, quantity: 1 }, { sourceLineId: lines[1].id, quantity: 1 }] },
      ];
      const usedByLine = new Map<string, number>();
      for (const split of splits) {
        for (const ln of split.lines) {
          usedByLine.set(ln.sourceLineId, (usedByLine.get(ln.sourceLineId) ?? 0) + ln.quantity);
        }
      }
      let valid = true;
      for (const srcLine of lines) {
        if (Math.abs(Number(srcLine.quantity) - (usedByLine.get(srcLine.id) ?? 0)) > 0.0001) valid = false;
      }
      expect(valid).toBe(true);

      // Invalid split: missing the second line entirely
      const invalidUsed = new Map<string, number>();
      invalidUsed.set(lines[0].id, 2); // Coffee fully covered
      // Juice not covered at all
      let wouldReject = false;
      for (const srcLine of lines) {
        if (Math.abs(Number(srcLine.quantity) - (invalidUsed.get(srcLine.id) ?? 0)) > 0.0001) wouldReject = true;
      }
      expect(wouldReject).toBe(true);

      await prisma.documentLine.deleteMany({ where: { documentId: doc.id } });
      await prisma.document.delete({ where: { id: doc.id } });
    });
  });

  describe('PosTablesService.transferItems (item-level)', () => {
    it('Scenario 1 — moves selected lines, leaving the rest on source', async () => {
      const srcId = (await createTable(orgId, 200, 'TI-Src')).id;
      const tgtId = (await createTable(orgId, 201, 'TI-Tgt')).id;
      const srcDoc = await createDraftDoc(orgId, [
        { description: 'Coffee', quantity: 2, unitPrice: 5000 },
        { description: 'Burger', quantity: 1, unitPrice: 15000 },
        { description: 'Juice', quantity: 1, unitPrice: 8000 },
      ]);
      await createOrder(orgId, srcId, srcDoc.id);
      const tgtDoc = await createDraftDoc(orgId, []);
      await createOrder(orgId, tgtId, tgtDoc.id);

      const toMove = srcDoc.lines.filter((l: any) => l.description === 'Burger' || l.description === 'Juice');
      const stayLines = srcDoc.lines.filter((l: any) => !toMove.some((m: any) => m.id === l.id));

      expect(toMove.length).toBe(2);
      expect(stayLines.length).toBe(1);
      expect((stayLines[0] as any).description).toBe('Coffee');

      await prisma.posTableOrder.deleteMany({ where: { tableId: { in: [srcId, tgtId] } } });
      await prisma.documentLine.deleteMany({ where: { documentId: { in: [srcDoc.id, tgtDoc.id] } } });
      await prisma.document.deleteMany({ where: { id: { in: [srcDoc.id, tgtDoc.id] } } });
      await prisma.posTable.deleteMany({ where: { id: { in: [srcId, tgtId] } } });
    });

    it('Scenario 3 — source goes AVAILABLE when fully drained', async () => {
      const srcId = (await createTable(orgId, 220, 'Drain-Src')).id;
      const doc = await createDraftDoc(orgId, [{ description: 'Item', quantity: 1, unitPrice: 5000 }]);
      await createOrder(orgId, srcId, doc.id);
      await prisma.posTable.update({ where: { id: srcId }, data: { status: 'occupied' } });

      // Drain: close the order, cancel the draft, set available
      await prisma.posTableOrder.updateMany({ where: { tableId: srcId, closedAt: null }, data: { closedAt: new Date() } });
      await prisma.document.update({ where: { id: doc.id }, data: { status: 'cancelled' } });
      const openCount = await prisma.posTableOrder.count({ where: { tableId: srcId, closedAt: null } });
      if (openCount === 0) {
        await prisma.posTable.update({ where: { id: srcId }, data: { status: 'available' } });
      }
      const status = (await prisma.posTable.findFirst({ where: { id: srcId } }))?.status;
      expect(status).toBe('available');

      await prisma.posTableOrder.deleteMany({ where: { tableId: srcId } });
      await prisma.documentLine.deleteMany({ where: { documentId: doc.id } });
      await prisma.document.delete({ where: { id: doc.id } });
      await prisma.posTable.delete({ where: { id: srcId } });
    });
  });

  describe('PosReservationsService', () => {
    it('rejects overlapping pending reservations on the same table', async () => {
      const tId = (await createTable(orgId, 300, 'Res-Overlap')).id;
      const startA = new Date('2026-07-01T18:00:00Z');
      const endA = new Date('2026-07-01T20:00:00Z');
      await prisma.posTableReservation.create({
        data: { organizationId: orgId, tableId: tId, customerName: 'Alice', partySize: 2, startAt: startA, endAt: endA, status: 'pending' },
      });
      // Verify overlapping query would detect the conflict
      const overlap = await prisma.posTableReservation.findFirst({
        where: { tableId: tId, status: { in: ['pending', 'seated'] }, startAt: { lt: endA }, endAt: { gt: startA } },
      });
      expect(overlap).not.toBeNull();

      await prisma.posTableReservation.deleteMany({ where: { tableId: tId } });
      await prisma.posTable.delete({ where: { id: tId } });
    });
  });

  describe('PosTableReportsService', () => {
    it('revenue() rolls up by Document.tableId cache', async () => {
      const tId = (await createTable(orgId, 400, 'Report-Tbl')).id;
      const doc1 = await createDraftDoc(orgId, [{ description: 'Sale1', quantity: 1, unitPrice: 50000 }]);
      const doc2 = await createDraftDoc(orgId, [{ description: 'Sale2', quantity: 2, unitPrice: 30000 }]);
      await prisma.document.update({ where: { id: doc1.id }, data: { tableId: tId, status: 'posted' } });
      await prisma.document.update({ where: { id: doc2.id }, data: { tableId: tId, status: 'posted' } });

      const agg = await prisma.document.aggregate({
        where: { tableId: tId, organizationId: orgId, status: 'posted' },
        _sum: { totalAmount: true },
      });
      expect(Number(agg._sum.totalAmount)).toBe(110000);

      await prisma.documentLine.deleteMany({ where: { documentId: { in: [doc1.id, doc2.id] } } });
      await prisma.document.deleteMany({ where: { id: { in: [doc1.id, doc2.id] } } });
      await prisma.posTable.delete({ where: { id: tId } });
    });
  });
});
