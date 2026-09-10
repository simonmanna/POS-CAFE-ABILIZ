/**
 * Bill ↔ receipt matching: the seam between goods receipts and vendor bills.
 *
 * `inv-audit-purchasing.spec.ts` proves the headline defect is gone (one
 * delivery is not booked twice). This suite covers the cases that fall out of
 * the fix and are just as easy to get wrong in production:
 *
 *   - a bill for less than was received leaves the remainder open
 *   - a bill priced above the receipt cost clears GRNI in full and books the
 *     difference to purchase price variance, instead of stranding it in 2150
 *   - cancelling a posted bill gives the receipt quantity back, so the
 *     corrected bill matches instead of receiving the delivery a second time
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
import { GoodsReceiptsService } from '../../../src/modules/procurement/goods-receipts.service';
import { VendorBillService } from '../../../src/modules/invoicing/vendor-bill/vendor-bill.service';
import { TenantContextService } from '../../../src/kernel/tenancy/tenant-context.service';
import { createAuditOrg, dropAuditOrg, onHand, accountBalance, AuditOrg } from './_harness';

describeDb('purchasing: vendor bill ↔ goods receipt matching', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let grns: GoodsReceiptsService;
  let bills: VendorBillService;
  let tenant: TenantContextService;
  let org: AuditOrg;
  let supplierId: string;

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run(
      {
        organizationId: org.organizationId,
        userId: 'match-user',
        permissions: ['expense:post', 'expense:cancel', 'goods_receipt:create', 'goods_receipt:post'],
      },
      fn,
    );

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'BILLMATCH');
    supplierId = (
      await prisma.partner.create({
        data: { organizationId: org.organizationId, code: 'BM-SUP', name: 'Matching Supplier', isSupplier: true },
      })
    ).id;

    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule, ProcurementModule, InvoicingModule],
    }).compile();
    await moduleRef.init();
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
        code: `${code}-${Date.now()}`,
        name: code,
        productType: 'stockable',
        trackInventory: true,
        costingMethod: 'AVCO',
        costPrice: 0,
        salesPrice: 0,
      } as any,
    });

  const receiveAdhoc = (productId: string, quantity: number, unitCost: number, description: string) =>
    asOrg(() =>
      grns.createAdhoc({
        partnerId: supplierId,
        warehouseId: org.mainLocationId,
        receivedAt: new Date().toISOString(),
        lines: [{ productId, description, quantity, unitCost }],
      } as any),
    );

  const postBill = async (productId: string, quantity: number, unitPrice: number, description: string) => {
    const bill = await asOrg(() =>
      bills.create({
        partnerId: supplierId,
        issueDate: new Date().toISOString(),
        lines: [{ productId, description, quantity, unitPrice, taxRate: 0 }],
      } as any),
    );
    await asOrg(() => bills.post(bill.id, { override3WM: true, overrideApproval: true }));
    return bill;
  };

  it('a bill for part of a delivery leaves the rest open, and the next bill closes it', async () => {
    const product = await makeProduct('BM-PARTIAL');
    await receiveAdhoc(product.id, 100, 10, 'Partial goods');

    const grniAfterReceipt = await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued);
    expect(grniAfterReceipt).toBeCloseTo(-1000, 2);

    await postBill(product.id, 60, 10, 'Partial goods');

    // Nothing physical moved — the goods were already here.
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(100);
    // 600 of the 1,000 accrual is cleared; 400 is still owed and unbilled.
    expect(await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued)).toBeCloseTo(-400, 2);

    await postBill(product.id, 40, 10, 'Partial goods (balance)');

    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(100);
    expect(await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued)).toBeCloseTo(0, 2);
    expect(await accountBalance(prisma, org.organizationId, org.accounts.accounts_payable)).toBeCloseTo(-1000, 2);
  }, 240_000);

  it('a bill priced above the receipt cost clears GRNI in full and books the gap to price variance', async () => {
    const product = await makeProduct('BM-PPV');
    await receiveAdhoc(product.id, 50, 4, 'Milk');

    const grniBefore = await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued);
    const ppvBefore = await accountBalance(prisma, org.organizationId, org.accounts.purchase_price_variance);
    const apBefore = await accountBalance(prisma, org.organizationId, org.accounts.accounts_payable);

    // Received at 4.00, invoiced at 4.50 — 25.00 of variance over 50 units.
    await postBill(product.id, 50, 4.5, 'Milk');

    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(50);
    // The accrual clears completely: it must not keep the 25 difference.
    expect((await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued)) - grniBefore).toBeCloseTo(
      200,
      2,
    );
    // The gap lands in PPV as a debit (an expense), not in inventory.
    expect((await accountBalance(prisma, org.organizationId, org.accounts.purchase_price_variance)) - ppvBefore).toBeCloseTo(
      25,
      2,
    );
    // The supplier is owed the invoice, not the receipt cost.
    expect((await accountBalance(prisma, org.organizationId, org.accounts.accounts_payable)) - apBefore).toBeCloseTo(
      -225,
      2,
    );
  }, 240_000);

  it('cancelling a posted bill releases the receipt quantity it claimed', async () => {
    const product = await makeProduct('BM-CANCEL');
    await receiveAdhoc(product.id, 10, 5, 'Sugar');

    const grniAfterReceipt = await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued);
    const bill = await postBill(product.id, 10, 5, 'Sugar');
    expect((await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued)) - grniAfterReceipt).toBeCloseTo(
      50,
      2,
    );

    await asOrg(() => bills.cancel(bill.id));

    // The accrual is back where the receipt left it...
    expect(await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued)).toBeCloseTo(
      grniAfterReceipt,
      2,
    );
    // ...and so is the matching cursor, so the delivery is open again.
    const lines = await prisma.goodsReceiptLine.findMany({
      where: { organizationId: org.organizationId, productId: product.id },
    });
    expect(lines.map((l) => Number(l.billedQuantity))).toEqual([0]);
    expect(
      await prisma.vendorBillReceiptMatch.count({ where: { organizationId: org.organizationId, vendorBillId: bill.id } }),
    ).toBe(0);

    // The corrected bill matches the same delivery instead of receiving it again.
    await postBill(product.id, 10, 5, 'Sugar (corrected)');
    expect(await onHand(prisma, org.organizationId, product.id, org.mainLocationId)).toBe(10);
    expect(await accountBalance(prisma, org.organizationId, org.accounts.grni_accrued)).toBeCloseTo(0, 2);
  }, 240_000);
});
