/* eslint-disable @typescript-eslint/no-explicit-any */
import { discountedLines, evaluatePricingAuthority, assertPricingAuthority, resolveDiscountThreshold } from './pricing-policy';
import { DocumentBuilderService } from '../invoicing/document/document-builder.service';
import { TaxCalculationService } from '../invoicing/tax/tax-calculation.service';

/**
 * Audit F-02 / F-03 — the discount rules have to be knowable BEFORE the payment
 * screen, and there has to be exactly one copy of them.
 *
 * The defects: the quote endpoint said nothing about discount policy, so a
 * cashier could apply a reason-less discount, auto-save it, and only discover at
 * Charge that the sale could not complete — the one place they cannot fix it.
 * Meanwhile the terminal carried its own hardcoded 10% / 50,000 threshold that
 * disagreed with the org's configured `discountApproval.tier1`.
 *
 * `evaluatePricingAuthority` is that single copy: the quote reads it to prompt,
 * and `assertPricingAuthority` wraps it to enforce. These tests pin them to the
 * same answers.
 */
describe('pricing policy — one rule, read twice (F-02/F-03)', () => {
  const ctx = (opts: { tier1?: unknown; tier1Amount?: unknown; permissions?: string[] } = {}) => ({
    tenant: { organizationId: 'org-1', userId: 'u-1' },
    prisma: {
      raw: {
        organization: { findUnique: jest.fn().mockResolvedValue({ settings: { discountApproval: { tier1: opts.tier1, tier1Amount: opts.tier1Amount } } }) },
        user: { findFirst: jest.fn().mockResolvedValue({ id: 'u-1', roles: [{ permissions: opts.permissions ?? ['pos:discount'] }] }) },
      },
    },
    overrides: { verifyOperationApproval: jest.fn().mockResolvedValue({ id: 'mgr' }) },
  });

  const line = (over: any = {}) => ({ quantity: 1, unitPrice: 10000, discountPercent: 0, discountType: 'percentage', discountAmount: 0, ...over });

  describe('resolveDiscountThreshold', () => {
    it('defaults to 10 when unset', () => expect(resolveDiscountThreshold(undefined)).toBe(10));
    it('defaults to 10 when unparseable', () => expect(resolveDiscountThreshold('abc')).toBe(10));
    it('clamps into 0..100', () => {
      expect(resolveDiscountThreshold(-5)).toBe(0);
      expect(resolveDiscountThreshold(140)).toBe(100);
    });
    it('honours a configured value', () => expect(resolveDiscountThreshold(5)).toBe(5));
  });

  describe('evaluatePricingAuthority', () => {
    it('touches no database at all for an undiscounted cart', async () => {
      const c = ctx();
      const v = await evaluatePricingAuthority(c, [line()], {});
      expect(v).toEqual({ maxDiscountPercent: 0, threshold: 10, discountAmount: 0, thresholdAmount: 0, requiresReason: false, requiresApproval: false, hasDiscountPermission: true });
      expect(c.prisma.raw.organization.findUnique).not.toHaveBeenCalled();
      expect(c.prisma.raw.user.findFirst).not.toHaveBeenCalled();
    });

    /**
     * Audit#2 N-06 — percent alone is not a control on a large bill. 9% of a
     * 5,000,000 UGX banquet is 450,000 given away under a 10% threshold with
     * nobody asked. F-03 removed the terminal's hardcoded 50,000 amount prompt
     * without giving the server an equivalent; this is that equivalent.
     */
    describe('absolute-amount tier (N-06)', () => {
      const bigLine = { quantity: 1, unitPrice: 5_000_000, discountPercent: 9, discountType: 'percentage', discountAmount: 0 };

      it('is disabled by default, so existing orgs are unchanged', async () => {
        const v = await evaluatePricingAuthority(ctx(), [bigLine], { discountReason: 'Regular' });
        expect(v.thresholdAmount).toBe(0);
        expect(v.discountAmount).toBeCloseTo(450_000);
        expect(v.requiresApproval).toBe(false);
      });

      it('demands approval once the money given away crosses the tier', async () => {
        const v = await evaluatePricingAuthority(ctx({ tier1Amount: 100_000 }), [bigLine], { discountReason: 'Regular' });
        expect(v.requiresApproval).toBe(true);
      });

      it('leaves a small discount alone even under a tight amount tier', async () => {
        const v = await evaluatePricingAuthority(
          ctx({ tier1Amount: 100_000 }),
          [{ quantity: 1, unitPrice: 10_000, discountPercent: 5, discountType: 'percentage', discountAmount: 0 }],
          { discountReason: 'Regular' },
        );
        expect(v.discountAmount).toBeCloseTo(500);
        expect(v.requiresApproval).toBe(false);
      });

      it('sums the whole cart, so many small line discounts still trip it', async () => {
        const many = Array.from({ length: 6 }, () => ({ quantity: 1, unitPrice: 500_000, discountPercent: 5, discountType: 'percentage', discountAmount: 0 }));
        const v = await evaluatePricingAuthority(ctx({ tier1Amount: 100_000 }), many, { discountReason: 'Staff party' });
        expect(v.maxDiscountPercent).toBeCloseTo(5); // under the percent tier
        expect(v.discountAmount).toBeCloseTo(150_000);
        expect(v.requiresApproval).toBe(true);
      });
    });

    it('flags a line discount with no reason — the F-02 case', async () => {
      const v = await evaluatePricingAuthority(ctx(), [line({ discountPercent: 5 })], {});
      expect(v.maxDiscountPercent).toBeCloseTo(5);
      expect(v.requiresReason).toBe(true);
      expect(v.requiresApproval).toBe(false);
    });

    it('is satisfied by a reason on the line itself', async () => {
      const v = await evaluatePricingAuthority(ctx(), [line({ discountPercent: 5, discountReason: 'Staff' })], {});
      expect(v.requiresReason).toBe(false);
    });

    it('still wants a reason for an order-level discount even when every line has one', async () => {
      const v = await evaluatePricingAuthority(
        ctx(), [line({ discountPercent: 5, discountReason: 'Staff' })], { transactionDiscountPercent: 5 },
      );
      expect(v.requiresReason).toBe(true);
    });

    it('reads the ORG threshold, not a hardcoded 10 — the F-03 case', async () => {
      const under = await evaluatePricingAuthority(ctx({ tier1: 5 }), [line({ discountPercent: 4, discountReason: 'r' })], { discountReason: 'r' });
      expect(under.threshold).toBe(5);
      expect(under.requiresApproval).toBe(false);

      const over = await evaluatePricingAuthority(ctx({ tier1: 5 }), [line({ discountPercent: 8, discountReason: 'r' })], { discountReason: 'r' });
      expect(over.threshold).toBe(5);
      expect(over.requiresApproval).toBe(true);
    });

    it('requires approval for ANY discount from a cashier without pos:discount', async () => {
      const v = await evaluatePricingAuthority(
        ctx({ permissions: ['pos:checkout'] }), [line({ discountPercent: 1, discountReason: 'r' })], { discountReason: 'r' },
      );
      expect(v.hasDiscountPermission).toBe(false);
      expect(v.requiresApproval).toBe(true);
    });

    it('measures a fixed-amount discount as a percentage of gross', async () => {
      const v = await evaluatePricingAuthority(
        ctx(), [line({ discountType: 'fixed_amount', discountAmount: 2500, discountReason: 'r' })], { discountReason: 'r' },
      );
      expect(v.maxDiscountPercent).toBeCloseTo(25);
      expect(v.requiresApproval).toBe(true);
    });
  });

  describe('assertPricingAuthority enforces exactly what the quote advertised', () => {
    it('lets an undiscounted sale through', async () => {
      await expect(assertPricingAuthority(ctx(), [line()], {})).resolves.toBe(0);
    });

    it('rejects a reason-less discount', async () => {
      await expect(assertPricingAuthority(ctx(), [line({ discountPercent: 5 })], {}))
        .rejects.toThrow(/discount reason is required/i);
    });

    it('rejects an over-threshold discount with no approver', async () => {
      await expect(assertPricingAuthority(ctx({ tier1: 5 }), [line({ discountPercent: 20, discountReason: 'r' })], { discountReason: 'r' }))
        .rejects.toThrow(/manager approval/i);
    });

    it('accepts it once a manager PIN is verified for the discount kind', async () => {
      const c = ctx({ tier1: 5 });
      await expect(assertPricingAuthority(c, [line({ discountPercent: 20, discountReason: 'r' })], {
        discountReason: 'r', overrideById: 'mgr-1', overridePin: '1234',
      })).resolves.toBeCloseTo(20);
      expect(c.overrides.verifyOperationApproval).toHaveBeenCalledWith('mgr-1', '1234', 'discount');
    });
  });
});

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
