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

export async function assertPricingAuthority(ctx: any, lines: any[], input: any): Promise<number> {
  const discounted = discountedLines(lines, input);
  const max = discounted.reduce((m, l) => {
    const gross = Number(l.quantity) * Number(l.unitPrice);
    return Math.max(m, gross > 0 ? Number(l.discountAmount) / gross * 100 : 0);
  }, 0);
  if (max === 0) return 0;
  const permissions: string[] = ctx.tenant.permissions ?? [];
  const org = await ctx.prisma.raw.organization.findUnique({ where: { id: ctx.tenant.organizationId }, select: { settings: true } });
  const configured = Number((org?.settings as any)?.discountApproval?.tier1 ?? 10);
  const threshold = Number.isFinite(configured) ? Math.max(0, Math.min(100, configured)) : 10;
  if (!input.discountReason?.trim() && (Number(input.transactionDiscountPercent || input.transactionDiscountAmount) > 0 || !lines.every((l) => !(Number(l.discountPercent) || Number(l.discountAmount)) || l.discountReason?.trim()))) throw new BadRequestException('A discount reason is required');
  if (!permissions.includes('pos:discount') || max > threshold) {
    if (!input.overrideById) throw new ForbiddenException('This discount requires manager approval and PIN');
    await ctx.overrides.verifyOperationApproval(input.overrideById, input.overridePin, 'discount');
  }
  return max;
}
