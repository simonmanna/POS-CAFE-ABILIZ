/**
 * Withholding tax on supplier payments.
 *
 * `TaxCalculationService` computed `withholdingTotal` and threw it away — no
 * purchase code path ever turned it into a journal line, so the seeded
 * Withholding Tax Payable account (2160) never moved and the liability the
 * business owes the revenue authority was invisible in the books.
 *
 * WHT is deducted when the supplier is PAID: the payable is relieved in full,
 * the supplier receives the net, and the withheld portion becomes our liability.
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
import { VendorBillService } from '../../../src/modules/invoicing/vendor-bill/vendor-bill.service';
import { PaymentService } from '../../../src/modules/invoicing/payment/payment.service';
import { TenantContextService } from '../../../src/kernel/tenancy/tenant-context.service';
import { createAuditOrg, dropAuditOrg, accountBalance, AuditOrg } from './_harness';

describeDb('purchasing: withholding tax on supplier payments', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let bills: VendorBillService;
  let payments: PaymentService;
  let tenant: TenantContextService;
  let org: AuditOrg;
  let supplierId: string;

  const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
    tenant.run(
      {
        organizationId: org.organizationId,
        userId: 'wht-user',
        permissions: ['expense:post', 'expense:cancel', 'payment:create'],
      },
      fn,
    );

  beforeAll(async () => {
    await prisma.$connect();
    org = await createAuditOrg(prisma, 'WHT');
    supplierId = (
      await prisma.partner.create({
        data: { organizationId: org.organizationId, code: 'WHT-SUP', name: 'Withholding Supplier', isSupplier: true },
      })
    ).id;

    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule, ProcurementModule, InvoicingModule],
    }).compile();
    await moduleRef.init();
    bills = moduleRef.get(VendorBillService);
    payments = moduleRef.get(PaymentService);
    tenant = moduleRef.get(TenantContextService);
  }, 240_000);

  afterAll(async () => {
    await dropAuditOrg(prisma, org?.organizationId);
    await moduleRef?.close();
    await prisma.$disconnect();
  }, 120_000);

  /** A services bill (no stockable line, so no receipt matching involved). */
  const postServicesBill = async (total: number) => {
    const bill = await asOrg(() =>
      bills.create({
        partnerId: supplierId,
        issueDate: new Date().toISOString(),
        lines: [{ description: 'Consultancy', quantity: 1, unitPrice: total, taxRate: 0 }],
      } as any),
    );
    await asOrg(() => bills.post(bill.id, { override3WM: true, overrideApproval: true }));
    return bill;
  };

  it('relieves the payable in full, pays the supplier net, and credits withholding tax payable', async () => {
    const bill = await postServicesBill(1000);

    const apAfterBill = await accountBalance(prisma, org.organizationId, org.accounts.accounts_payable);
    const bankBefore = await accountBalance(prisma, org.organizationId, org.accounts.default_bank);
    const whtBefore = await accountBalance(prisma, org.organizationId, org.accounts.withholding_payable);

    // 6% withheld on a 1,000 payable: the supplier banks 940, URA is owed 60.
    const payment = await asOrg(() =>
      payments.createSupplierPayment({
        partnerId: supplierId,
        paymentDate: new Date().toISOString(),
        amount: 1000,
        paymentMethod: 'bank',
        withholdingAmount: 60,
        allocations: [{ documentId: bill.id, amount: 1000 }],
      } as any),
    );

    // The supplier's account is settled in full — they owe us nothing further,
    // and we owe them nothing further.
    expect((await accountBalance(prisma, org.organizationId, org.accounts.accounts_payable)) - apAfterBill).toBeCloseTo(
      1000,
      2,
    );
    // Only the net actually left the bank.
    expect((await accountBalance(prisma, org.organizationId, org.accounts.default_bank)) - bankBefore).toBeCloseTo(
      -940,
      2,
    );
    // The withheld 60 is now our liability to the revenue authority.
    expect((await accountBalance(prisma, org.organizationId, org.accounts.withholding_payable)) - whtBefore).toBeCloseTo(
      -60,
      2,
    );

    const row = await prisma.payment.findFirst({ where: { id: (payment as any).id } });
    expect(Number(row!.withholdingAmount)).toBe(60);

    // And the bill itself is fully settled, not left showing a 60 residual.
    const settled = await prisma.document.findFirst({ where: { id: bill.id } });
    expect(Number(settled!.amountResidual)).toBeCloseTo(0, 2);
  }, 240_000);

  it('refuses a withholding larger than the payment', async () => {
    const bill = await postServicesBill(500);
    await expect(
      asOrg(() =>
        payments.createSupplierPayment({
          partnerId: supplierId,
          paymentDate: new Date().toISOString(),
          amount: 500,
          paymentMethod: 'bank',
          withholdingAmount: 500,
          allocations: [{ documentId: bill.id, amount: 500 }],
        } as any),
      ),
    ).rejects.toThrow(/less than the payment amount/i);
  }, 240_000);
});
