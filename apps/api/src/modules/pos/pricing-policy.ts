import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { dec } from '../../kernel/common/money';

/** Normalize line and order discounts once; quote and invoice use identical inputs. */
export function discountedLines(lines: any[], input: any): any[] {
  const type = input.transactionDiscountType ?? 'percentage';
  const value = dec(type === 'fixed_amount' ? input.transactionDiscountAmount ?? 0 : input.transactionDiscountPercent ?? 0);
  if (!value.isFinite() || value.lt(0) || (type === 'percentage' && value.gt(100))) throw new BadRequestException('Invalid order discount');
  const amounts = lines.map((line) => {
    const gross = dec(line.quantity).times(line.unitPrice);
    const discount = line.discountType === 'fixed_amount' ? dec(line.discountAmount ?? 0) : gross.times(dec(line.discountPercent ?? 0)).div(100);
    if (!gross.isFinite() || gross.lt(0) || !discount.isFinite() || discount.lt(0) || discount.gt(gross)) throw new BadRequestException('Invalid line price or discount');
    return { gross, discount, net: gross.minus(discount) };
  });
  const net = amounts.reduce((s, a) => s.plus(a.net), dec(0));
  if (type === 'fixed_amount' && value.gt(net)) throw new BadRequestException('Order discount exceeds the remaining subtotal');
  let allocated = dec(0);
  return lines.map((line, i) => {
    const a = amounts[i];
    const extra = type === 'percentage' ? a.net.times(value).div(100)
      : net.eq(0) ? dec(0) : i === lines.length - 1 ? value.minus(allocated) : value.times(a.net).div(net).toDecimalPlaces(6);
    allocated = allocated.plus(extra);
    return { ...line, discountType: 'fixed_amount', discountAmount: Number(a.discount.plus(extra)), discountPercent: 0 };
  });
}

/** What the discount rules make of a cart, without deciding anything yet. */
export interface PricingAuthority {
  /** Largest effective line discount in the cart, as a percentage of gross. */
  maxDiscountPercent: number;
  /** The org's tier-1 approval threshold (`settings.discountApproval.tier1`). */
  threshold: number;
  /** Total money discounted across the cart. */
  discountAmount: number;
  /**
   * Audit#2 N-06 — the org's absolute-amount tier
   * (`settings.discountApproval.tier1Amount`); 0 disables it.
   *
   * Percent alone is not a control on a large bill: 9% of a 5,000,000 UGX
   * banquet is 450,000 given away under a 10% threshold with nobody asked. The
   * pre-remediation terminal did carry a hardcoded 50,000 amount prompt; F-03
   * removed it without giving the server an equivalent, so the cap disappeared.
   */
  thresholdAmount: number;
  /** True when a discount is present but no reason has been supplied for it. */
  requiresReason: boolean;
  /** True when this cashier cannot authorise this discount on their own. */
  requiresApproval: boolean;
  /** Whether the caller currently holds `pos:discount` (read live, not claimed). */
  hasDiscountPermission: boolean;
}

/**
 * Evaluate the discount rules WITHOUT enforcing them.
 *
 * Audit F-02/F-03 — the quote endpoint used to say nothing about discount
 * policy, so a cashier could apply a discount, auto-save it, walk to the payment
 * screen and only there discover that the sale could not complete. The frontend
 * meanwhile carried its own hardcoded threshold, which disagreed with the org's
 * configured one. Both now read this single function: the terminal calls it
 * through `POST /pos/orders/quote` to decide what to prompt for, and the settle
 * path calls it through `assertPricingAuthority` to decide what to allow.
 */
export async function evaluatePricingAuthority(ctx: any, lines: any[], input: any): Promise<PricingAuthority> {
  const discounted = discountedLines(lines, input);
  const maxDiscountPercent = discounted.reduce((m, l) => {
    const gross = Number(l.quantity) * Number(l.unitPrice);
    return Math.max(m, gross > 0 ? Number(l.discountAmount) / gross * 100 : 0);
  }, 0);

  // An undiscounted cart has no policy to evaluate, so it asks the database
  // nothing — the settle path runs this on every sale.
  if (maxDiscountPercent === 0) {
    return {
      maxDiscountPercent: 0, threshold: DEFAULT_DISCOUNT_TIER1,
      discountAmount: 0, thresholdAmount: 0,
      requiresReason: false, requiresApproval: false, hasDiscountPermission: true,
    };
  }

  // A-030: never trust the (up to 12h-stale) POS-token permission claims for a
  // money decision — re-read the caller's CURRENT roles from the database, so
  // a revoked pos:discount bites on the very next request.
  const permissions = await currentPermissions(ctx, ctx.tenant.userId);
  const org = await ctx.prisma.raw.organization.findUnique({ where: { id: ctx.tenant.organizationId }, select: { settings: true } });
  const threshold = resolveDiscountThreshold((org?.settings as any)?.discountApproval?.tier1);
  const thresholdAmount = resolveDiscountAmountThreshold((org?.settings as any)?.discountApproval?.tier1Amount);
  const discountAmount = discounted.reduce((sum, l) => sum + Number(l.discountAmount ?? 0), 0);

  const hasDiscountPermission = permissions.includes('pos:discount');
  // An order-level discount always needs its own reason; a line discount is
  // satisfied by its own, so a cart of reasoned lines does not need one too.
  const orderDiscount = Number(input.transactionDiscountPercent || input.transactionDiscountAmount) > 0;
  const everyLineReasoned = lines.every((l) => !(Number(l.discountPercent) || Number(l.discountAmount)) || l.discountReason?.trim());
  const requiresReason = !input.discountReason?.trim() && (orderDiscount || !everyLineReasoned);
  const requiresApproval = !hasDiscountPermission
    || maxDiscountPercent > threshold
    || (thresholdAmount > 0 && discountAmount > thresholdAmount);

  return {
    maxDiscountPercent, threshold, discountAmount, thresholdAmount,
    requiresReason, requiresApproval, hasDiscountPermission,
  };
}

/** Fallback when an org has not configured `discountApproval.tier1`. */
export const DEFAULT_DISCOUNT_TIER1 = 10;

/**
 * Default for the absolute-amount tier. 0 = disabled, which keeps every existing
 * org behaving exactly as it does today until someone sets a figure.
 */
export const DEFAULT_DISCOUNT_TIER1_AMOUNT = 0;

/** The org's absolute-amount threshold, clamped and defaulted. */
export function resolveDiscountAmountThreshold(configured: unknown): number {
  const n = Number(configured ?? DEFAULT_DISCOUNT_TIER1_AMOUNT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DISCOUNT_TIER1_AMOUNT;
}

/** The org's tier-1 threshold, clamped and defaulted. One reader, one rule. */
export function resolveDiscountThreshold(configured: unknown): number {
  const n = Number(configured ?? DEFAULT_DISCOUNT_TIER1);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : DEFAULT_DISCOUNT_TIER1;
}

export async function assertPricingAuthority(ctx: any, lines: any[], input: any): Promise<number> {
  const verdict = await evaluatePricingAuthority(ctx, lines, input);
  if (verdict.maxDiscountPercent === 0) return 0;
  if (verdict.requiresReason) throw new BadRequestException('A discount reason is required');
  if (verdict.requiresApproval) {
    if (!input.overrideById) throw new ForbiddenException('This discount requires manager approval and PIN');
    await ctx.overrides.verifyOperationApproval(input.overrideById, input.overridePin, 'discount');
  }
  return verdict.maxDiscountPercent;
}

/**
 * A-030 helper: resolve the caller's live permission set from their CURRENT
 * roles. Falls back to the tenant-context claims only when the caller cannot
 * be resolved (e.g. device-sync actor with no user row) — the sync plane
 * intentionally carries an empty claim set, so that fallback stays closed.
 */
export async function currentPermissions(ctx: any, userId?: string | null): Promise<string[]> {
  if (!userId) return [];
  const user = await ctx.prisma.raw.user.findFirst({
    where: { id: userId, isActive: true, deletedAt: null },
    include: { roles: true },
  });
  if (!user) return [];
  const perms = new Set<string>();
  for (const role of user.roles ?? []) for (const p of role.permissions ?? []) perms.add(p);
  return [...perms];
}
