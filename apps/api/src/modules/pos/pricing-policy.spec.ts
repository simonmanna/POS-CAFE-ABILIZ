import { discountedLines, assertPricingAuthority } from './pricing-policy';
import { DocumentBuilderService } from '../invoicing/document/document-builder.service';
import { TaxCalculationService } from '../invoicing/tax/tax-calculation.service';

describe('Authoritative POS pricing', () => {
  const builder = new DocumentBuilderService({} as any, {} as any, {} as any, new TaxCalculationService(), {} as any);
  const db: any = { tax: { findFirst: async () => ({ id: 'vat', rate: 18, isInclusive: false, isCompound: false }) } };

  it.each([false, true])('applies fixed line + order discounts before tax (inclusive=%s)', async (inclusive) => {
    const priced = discountedLines([{ description: 'Coffee', quantity: 2, unitPrice: 118, taxId: 'vat', taxInclusive: inclusive, discountType: 'fixed_amount', discountAmount: 36 }], { transactionDiscountType: 'fixed_amount', transactionDiscountAmount: 82 });
    const total = await builder.prepareLines(db, priced);
    expect(total.total.toString()).toBe(inclusive ? '118' : '139.24');
    expect(total.taxAmount.toString()).toBe(inclusive ? '18' : '21.24');
  });

  it('checks the combined discount, rather than approving each component independently', async () => {
    const ctx: any = { tenant: { organizationId: 'org', permissions: ['pos:discount'] }, prisma: { raw: { organization: { findUnique: async () => ({ settings: { discountApproval: { tier1: 10 } } }) } } }, overrides: { verifyOperationApproval: jest.fn() } };
    await expect(assertPricingAuthority(ctx, [{ quantity: 1, unitPrice: 100, discountPercent: 6 }], { transactionDiscountPercent: 6, discountReason: 'Promotion' })).rejects.toThrow('manager approval');
    await assertPricingAuthority(ctx, [{ quantity: 1, unitPrice: 100, discountPercent: 6 }], { transactionDiscountPercent: 6, discountReason: 'Promotion', overrideById: 'manager', overridePin: '1234' });
    expect(ctx.overrides.verifyOperationApproval).toHaveBeenCalledWith('manager', '1234', 'discount');
  });

  it('rejects an impossible discount and a fixed discount without a reason', async () => {
    expect(() => discountedLines([{ quantity: 1, unitPrice: 10 }], { transactionDiscountType: 'fixed_amount', transactionDiscountAmount: 11 })).toThrow('exceeds');
    const ctx: any = { tenant: { permissions: ['pos:discount'] }, prisma: { raw: { organization: { findUnique: async () => ({}) } } } };
    await expect(assertPricingAuthority(ctx, [{ quantity: 1, unitPrice: 100, discountPercent: 0, discountType: 'fixed_amount', discountAmount: 1 }], {})).rejects.toThrow('reason');
  });
});
