/**
 * AUDIT — H1 (Tier A): does posting a vendor bill re-receive goods that a
 * goods receipt already brought into stock?
 *
 * `invoicing-workflows.initializer.ts:213-241` loops every bill line whose
 * product has `trackInventory` and calls `StockService.receiveFromBill`
 * unconditionally. There is no link back to a GoodsReceiptNote, no
 * `receivedQuantity` check, and no flag on the bill to say "goods already in".
 * If that is what it does, then the ordinary AP workflow —
 *
 *     PO → goods receipt (stock in) → supplier's invoice arrives → post bill
 *
 * — books the same physical delivery into stock twice.
 *
 * Two cases are exercised because the two receiving paths treat GRNI
 * differently:
 *   A. PO-driven receive (clears GRNI immediately via the receipt voucher)
 *   B. ad-hoc goods receipt (deliberately leaves GRNI open for the bill)
 *
 * Case B is the intended pairing, so if stock still doubles there, the defect
 * is in the normal happy path and not an edge case.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { describeDb } from '../_setup';
import { KernelModule } from '../../../src/kernel/kernel.module';
import { DocumentsModule } from '../../../src/modules/documents/documents.module';
import { CoreModule } from '../../../src/modules/core/core.module';
import { InventoryModule } from '../../../src/modules/inventory/inventory.module';
import { ProcurementModule } from '../../../src/modules/procurement/procurement.module';
import { InvoicingModule } from '../../../src/modules/invoicing/invoicing.module';
import { PurchaseOrdersService } from '../../../src/modules/procurement/purchase-orders.service';
import { GoodsReceiptsService } from '../../../src/modules/procurement/goods-receipts.service';
import { VendorBillService } from '../../../src/modules/invoicing/vendor-bill/vendor-bill.service';
import { TenantContextService } from '../../../src/kernel/tenancy/tenant-context.service';
import { createAuditOrg, dropAuditOrg, onHand, accountBalance, AuditOrg } from './_harness';

describeDb('AUDIT: purchasing — receiving vs vendor bill (H1)', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let po: PurchaseOrdersService;
  let grns: GoodsReceiptsService;
  let bills: VendorBillService;
  let tenant: TenantContextService;
  let org: AuditOrg;
  let supplierId: string;

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> => tenant.run({ organizationId: org.organizationId, userId: 'audit-user', permissions: ['expense:post','expense:cancel','invoice:post','invoice:cancel','payment:void','credit_note:post','goods_receipt:create','goods_receipt:post'] }, fn);

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'PURCH');
    // The receipt voucher path needs an input-tax mapping.
    const inputTax = await prisma.account.findFirst({
      where: { organizationId: org.organizationId, code: 'PURCH-2200' },
    });
    if (inputTax) {
      await prisma.accountMapping.create({
        data: { organizationId: org.organizationId, key: 'tax_receivable', accountId: inputTax.id },
      });
    }
    supplierId = (
      await prisma.partner.create({
        data: { organizationId: org.organizationId, code: 'AUD-SUP', name: 'Audit Supplier', isSupplier: true },
      })
    ).id;

    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule, ProcurementModule, InvoicingModule],
    }).compile();
    await moduleRef.init();
    po = moduleRef.get(PurchaseOrdersService);
    grns = moduleRef.get(GoodsReceiptsService);
    bills = moduleRef.get(VendorBillService);
    tenant = moduleRef.get(TenantContextService);
  }, 240_000);

  afterAll(async () => {
    await dropAuditOrg(prisma, org?.organizationId);
    await moduleRef?.close();
    await prisma.$disconnect();
  }, 120_000);

  const makeProduct = (code: string) =>
    prisma.product.create({
      data: {
        organizationId: org.organizationId,
        code, name: code,
        productType: 'stockable', trackInventory: true,
        costingMethod: 'AVCO', costPrice: 0, salesPrice: 0,
      } as any,
    });

  it('H1-A: a PO receipt followed by the supplier bill must not receive the goods twice', async () => {
    const product = await makeProduct('H1-A-BEANS');

    const order = await asOrg(() =>
      po.create({
        partnerId: supplierId,
        warehouseId: org.mainLocationId,
        paymentType: 'credit',
        currencyCode: 'UGX',
        lines: [{ productId: product.id, description: 'Beans', quantity: 100, unitPrice: 10, taxRate: 0 }],
      } as any),
    );
    await asOrg(() =>
      po.receive(order.id, {
        warehouseId: org.mainLocationId,
        lines: [{ productId: product.id, description: 'Beans', quantity: 100, unitCost: 10 }],
      } as any),
    );

    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(100);
    const stockAfterReceipt = await accountBalance(prisma, org.organizationId, org.accounts.stock_valuation);
    const apAfterReceipt = await accountBalance(prisma, org.organizationId, org.accounts.accounts_payable);

    // The supplier's invoice for that same delivery arrives and is posted.
    const bill = await asOrg(() =>
      bills.create({
        partnerId: supplierId,
        issueDate: new Date().toISOString(),
        lines: [{ productId: product.id, description: 'Beans', quantity: 100, unitPrice: 10, taxRate: 0 }],
      } as any),
    );
    await asOrg(() => bills.post(bill.id, { override3WM: true, overrideApproval: true }));

    // EVIDENCE dump — recorded in the audit report regardless of pass/fail.
    // eslint-disable-next-line no-console
    console.log('[H1-A EVIDENCE]', JSON.stringify({
      onHandAfterPoReceipt: 100,
      onHandAfterBillPost: await onHand(prisma, org.organizationId, product.id, org.mainLocationId),
      stockValuationAfterReceipt: stockAfterReceipt,
      stockValuationAfterBill: await accountBalance(prisma, org.organizationId, org.accounts.stock_valuation),
      apAfterReceipt: apAfterReceipt,
      apAfterBill: await accountBalance(prisma, org.organizationId, org.accounts.accounts_payable),
      grniAfterBill: await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued),
      ledgerRows: await prisma.inventoryLedger.count({ where: { organizationId: org.organizationId, productId: product.id } }),
    }));

    // EXPECTED: one physical delivery = 100 units on hand, valued once.
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(100);
    expect(await accountBalance(prisma, org.organizationId, org.accounts.stock_valuation)).toBeCloseTo(
      stockAfterReceipt, 2,
    );
    // And the supplier is owed 1,000 once, not twice.
    expect(await accountBalance(prisma, org.organizationId, org.accounts.accounts_payable)).toBeCloseTo(
      apAfterReceipt, 2,
    );
  }, 240_000);

  it('H1-B: the intended GRN → bill pairing must clear GRNI without re-receiving stock', async () => {
    const product = await makeProduct('H1-B-MILK');

    // Ad-hoc goods receipt: stock in, GRNI deliberately left open for the bill.
    await asOrg(() =>
      grns.createAdhoc({
        partnerId: supplierId,
        warehouseId: org.mainLocationId,
        receivedAt: new Date().toISOString(),
        lines: [{ productId: product.id, description: 'Milk', quantity: 50, unitCost: 4 }],
      } as any),
    );

    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(50);
    const grniAfterReceipt = await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued);
    // GRNI is a liability: goods received, not yet billed → credit balance.
    expect(grniAfterReceipt).toBeCloseTo(-200, 2);

    const bill = await asOrg(() =>
      bills.create({
        partnerId: supplierId,
        issueDate: new Date().toISOString(),
        lines: [{ productId: product.id, description: 'Milk', quantity: 50, unitPrice: 4, taxRate: 0 }],
      } as any),
    );
    await asOrg(() => bills.post(bill.id, { override3WM: true, overrideApproval: true }));

    // eslint-disable-next-line no-console
    console.log('[H1-B EVIDENCE]', JSON.stringify({
      onHandAfterGrn: 50,
      onHandAfterBillPost: await onHand(prisma, org.organizationId, product.id, org.mainLocationId),
      grniAfterGrn: grniAfterReceipt,
      grniAfterBill: await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued),
      ledgerRows: await prisma.inventoryLedger.findMany({
        where: { organizationId: org.organizationId, productId: product.id },
        select: { type: true, quantityChange: true, unitCost: true, referenceType: true, referenceId: true },
      }),
    }));

    // EXPECTED: the bill clears the accrual and changes nothing physical.
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(50);
    expect(await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued)).toBeCloseTo(0, 2);
  }, 240_000);

  it('H18: a bill priced in the purchase unit must not land as base units', async () => {
    // A product bought by the case (24 base units) and stocked in base units.
    const uomCategory = await prisma.uomCategory.create({
      data: { organizationId: org.organizationId, name: `AUD-UNITS-${Date.now()}` } as any,
    });
    const baseUom = await prisma.unitOfMeasure.create({
      data: {
        organizationId: org.organizationId, categoryId: uomCategory.id,
        code: `AUD-EA-${Date.now()}`, name: 'Each', factor: 1,
      } as any,
    });
    const caseUom = await prisma.unitOfMeasure.create({
      data: {
        organizationId: org.organizationId, categoryId: uomCategory.id,
        code: `AUD-CASE-${Date.now()}`, name: 'Case of 24', factor: 24,
      } as any,
    });
    await prisma.uomCategory.update({
      where: { id: uomCategory.id },
      data: { referenceUomId: baseUom.id } as any,
    });

    const product = await prisma.product.create({
      data: {
        organizationId: org.organizationId, code: `H18-SODA-${Date.now()}`, name: 'Soda',
        productType: 'stockable', trackInventory: true, costingMethod: 'AVCO',
        costPrice: 0, salesPrice: 0,
        uomId: baseUom.id, purchaseUomId: caseUom.id, salesUomId: baseUom.id,
      } as any,
    });

    const bill = await asOrg(() =>
      bills.create({
        partnerId: supplierId,
        issueDate: new Date().toISOString(),
        // 10 CASES at 240 per case = 2,400 → 240 base units at 10 each.
        lines: [{ productId: product.id, description: 'Soda (cases)', quantity: 10, unitPrice: 240, taxRate: 0 }],
      } as any),
    );
    await asOrg(() => bills.post(bill.id, { override3WM: true, overrideApproval: true }));

    const q = await prisma.stockItem.findFirst({
      where: { organizationId: org.organizationId, productId: product.id, locationId: org.mainLocationId },
    });
    // eslint-disable-next-line no-console
    console.log('[H18 EVIDENCE]', JSON.stringify({
      billedQuantity: 10, billedUnitPrice: 240, purchaseUomFactor: 24,
      expectedBaseUnits: 240, expectedUnitCost: 10,
      actualOnHand: Number(q?.quantity ?? 0),
      actualRunningAverageCost: Number(q?.runningAverageCost ?? 0),
    }));

    // EXPECTED: the purchase unit is honoured — 10 cases = 240 each.
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(240);
  }, 240_000);
});
