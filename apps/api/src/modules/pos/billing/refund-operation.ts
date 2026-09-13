import { recordBusinessOutcome } from '../../../kernel/idempotency/business-outcome';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { dec } from '../../../kernel/common/money';
import { resolvePosStockLocation } from '../../inventory/pos-stock-location';

export interface RefundOptions {
  overrideById?: string;
  overridePin?: string;
  requireOverride?: boolean;
  cashSessionId?: string;
  lines?: Array<{ lineId: string; quantity: number }>;
  stockDisposition?: 'restock' | 'waste' | 'no_return';
}

/** Financial reversal and goods disposition are separate, auditable decisions. */
export async function refundInvoice(ctx: any, invoiceId: string, reason: string | undefined, opts: RefundOptions = {}) {
  if (!reason?.trim()) throw new BadRequestException('A refund reason is required');
  if (!opts.overrideById) throw new BadRequestException('Manager approval is required for a refund');
  await ctx.overrides.verifyOperationApproval(opts.overrideById, opts.overridePin, 'manual_refund');
  if (!['restock', 'waste', 'no_return'].includes(opts.stockDisposition ?? '')) throw new BadRequestException('Choose the returned goods disposition');
  const orgId = ctx.tenant.organizationId;
  const result = await ctx.prisma.client.$transaction(async (tx: any) => {
    // Consistent lock order with collections and shift close: session, invoice, credit.
    if (opts.cashSessionId) await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', opts.cashSessionId, orgId);
    await tx.$queryRawUnsafe('SELECT id FROM "Invoice" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', invoiceId, orgId);
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: orgId }, include: { items: true } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (['refunded', 'cancelled'].includes(inv.status) || inv.settlementStatus === 'written_off') throw new BadRequestException('Invoice cannot be refunded');
    if (!inv.receivableAccountId) throw new BadRequestException('Reconcile this legacy invoice’s original posting before refunding it');
    const byId = new Map<string, any>(inv.items.map((it: any) => [it.id, it]));
    const requested = opts.lines ?? inv.items.map((it: any) => ({ lineId: it.id, quantity: Number(dec(it.quantity).minus(it.refundedQty)) })).filter((it: any) => it.quantity > 0);
    if (!requested.length) throw new BadRequestException('Nothing remains to refund');
    const seen = new Set<string>();
    const selections = requested.map((sel: any) => {
      if (seen.has(sel.lineId)) throw new BadRequestException('Duplicate refund line');
      seen.add(sel.lineId);
      const src = byId.get(sel.lineId);
      if (!src) throw new BadRequestException('Refund line is not on this invoice');
      const quantity = dec(sel.quantity);
      if (!quantity.isFinite() || !quantity.gt(0) || quantity.gt(dec(src.quantity).minus(src.refundedQty))) throw new BadRequestException('Refund quantity exceeds the remaining quantity');
      // Menu items are restockable via the recipe snapshot (ingredient-level).
      // Direct products without a productId cannot be restocked.
      if (opts.stockDisposition === 'restock' && !src.productId && !src.menuItemId) {
        throw new BadRequestException('Cannot restock this line type');
      }
      return { src, quantity };
    });
    let total = dec(0);
    const journalLines: any[] = [];
    for (const { src, quantity } of selections) {
      const fraction = quantity.div(src.quantity);
      const subtotal = dec(src.subtotal).times(fraction).toDecimalPlaces(6);
      const tax = dec(src.taxAmount).times(fraction).toDecimalPlaces(6);
      total = total.plus(subtotal).plus(tax);
      if (!src.accountId) throw new BadRequestException('Original line revenue account is missing; reconcile the invoice before refunding');
      journalLines.push({ accountId: src.accountId, debit: subtotal.toString(), partnerId: inv.partnerId });
      if (tax.gt(0)) {
        const taxAccount = src.taxAccountId;
        if (!taxAccount) throw new BadRequestException('Original tax posting account is missing');
        journalLines.push({ accountId: taxAccount, debit: tax.toString() });
      }
    }
    if (!total.gt(0) || dec(inv.amountRefunded).plus(total).gt(dec(inv.totalAmount).plus('0.000001'))) throw new BadRequestException('Refund exceeds remaining invoice value');
    const refund = await tx.posRefund.create({ data: { organizationId: orgId, invoiceId, cashSessionId: opts.cashSessionId, amount: total, reason: reason.trim(), stockDisposition: opts.stockDisposition, items: selections.map(({ src, quantity }: any) => ({ lineId: src.id, quantity: quantity.toString(), subtotal: dec(src.subtotal).times(quantity.div(src.quantity)).toDecimalPlaces(6).toString(), taxAmount: dec(src.taxAmount).times(quantity.div(src.quantity)).toDecimalPlaces(6).toString() })), payments: [], approvedById: opts.overrideById, createdBy: ctx.tenant.userId } });
    journalLines.push({ accountId: inv.receivableAccountId, credit: total.toString(), partnerId: inv.partnerId });
    const entry = await ctx.posting.post({ journalCode: 'SALES', date: new Date().toISOString(), postingKey: `pos_refund:${refund.id}`, description: `Refund ${inv.invoiceNumber}: ${reason}`, sourceType: 'pos_refund', sourceId: refund.id, branchId: inv.branchId ?? undefined, lines: journalLines }, tx);

    // Credit unpaid AR first; return only money actually collected. Allocate the
    // returned amount over original tenders, never over invoice.paymentMode.
    const arReduction = dec(inv.amountResidual).lt(total) ? dec(inv.amountResidual) : total;
    let payout = total.minus(arReduction);
    const allocations = await tx.paymentAllocation.findMany({ where: { invoiceId, organizationId: orgId, payment: { direction: 'inbound', status: { not: 'cancelled' } } }, include: { payment: true }, orderBy: { id: 'asc' } });
    for (const id of [...new Set<string>(allocations.map((a: any) => a.paymentId))].sort()) await tx.$queryRawUnsafe('SELECT id FROM "Payment" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', id, orgId);
    const available = allocations.map((a: any) => ({ allocationId: a.id, payment: a.payment, amount: dec(a.amount).minus(a.refundedAmount ?? 0) })).filter((a: any) => a.amount.gt(0));
    const collected = available.reduce((s: any, a: any) => s.plus(a.amount), dec(0));
    if (payout.gt(collected)) throw new BadRequestException('Collected payment allocations do not cover this refund');
    const paymentLinks: any[] = [];
    const payoutTotal = payout;
    for (let i = 0; i < available.length && payout.gt(0); i++) {
      const { allocationId, payment, amount } = available[i];
      const share = i === available.length - 1 ? payout : payoutTotal.times(amount).div(collected).toDecimalPlaces(6);
      if (!share.gt(0)) continue;
      if (payment.paymentMethod === 'cash' && !opts.cashSessionId) throw new BadRequestException('Select the current open register for the cash refund');
      const returned = await ctx.payments.createCustomerRefund({ partnerId: inv.partnerId, paymentDate: new Date().toISOString(), paymentMethod: payment.paymentMethod, amount: Number(share), accountId: payment.paymentMethod === 'cash' ? undefined : payment.accountId, cashSessionId: opts.cashSessionId, refundOfId: payment.id, reference: `Refund ${refund.id} of ${payment.paymentNumber}` }, tx, { allowSessionOwnerMismatch: true });
      await tx.payment.update({ where: { id: payment.id }, data: { refundedAmount: { increment: share } } });
      await tx.paymentAllocation.update({ where: { id: allocationId }, data: { refundedAmount: { increment: share } } });
      paymentLinks.push({ originalPaymentId: payment.id, paymentId: returned.id, amount: share.toString(), accountId: returned.accountId });
      payout = payout.minus(share);
    }
    if (opts.stockDisposition === 'restock') {
      const jobs = await tx.stockPostingJob.count({ where: { invoiceId, status: { not: 'done' } } });
      if (jobs) throw new BadRequestException('Resolve pending stock posting before restocking this return');
      for (const { src, quantity } of selections) {
        // Use the recipe snapshot when available (menu items with ingredients)
        // so historical COGS is preserved regardless of current MenuProduct changes.
        const ingredients = await tx.invoiceItemRecipeIngredient.findMany({
          where: { invoiceItemId: src.id, organizationId: orgId },
        });
        if (ingredients.length > 0) {
          // Restock from the snapshot: the exact ingredients that were consumed
          // Return the goods to the store the sale relieved: the selling shift's
          // register location when there is one.
          const saleSession = inv.cashSessionId ? await tx.cashSession.findFirst({ where: { id: inv.cashSessionId, organizationId: orgId }, select: { registerLocationId: true, cashRegister: { select: { locationId: true } } } }) : null;
          const posLoc = await resolvePosStockLocation(ctx.prisma, orgId, tx, saleSession?.registerLocationId ?? saleSession?.cashRegister?.locationId);
          const locId = posLoc?.id;
          if (!locId) throw new BadRequestException('No active warehouse configured — cannot restock inventory');
          for (const ing of ingredients) {
            const fraction = quantity.div(src.quantity);
            const returnQty = dec(ing.quantity).times(fraction).toDecimalPlaces(6);
            if (returnQty.lte(0)) continue;
            await ctx.stock.receiveReturn({
              productId: ing.productId,
              locationId: locId,
              quantity: Number(returnQty),
              unitCost: Number(ing.unitCost),
              reference: `Refund ${refund.id}`,
              sourceType: 'pos_refund',
              sourceId: refund.id,
            }, tx);
          }
        } else {
          // Fallback for legacy rows and direct-product issues: derive from ledger
          const issues = await tx.inventoryLedger.findMany({
            where: { organizationId: orgId, productId: src.productId, variantId: src.variantId ?? null, referenceId: invoiceId, referenceType: 'pos_invoice', quantityChange: { lt: 0 } },
          });
          const locations = [...new Set(issues.map((it: any) => it.locationId))];
          if (locations.length !== 1) throw new BadRequestException('Original stock issue location is missing or ambiguous; resolve the stock disposition first');
          const product = await tx.product.findFirst({ where: { id: src.productId, organizationId: orgId } });
          if (!product || product.serialTracking || product.batchTracking) throw new BadRequestException('Tracked returns require an identified stock return; choose no return and record the stock disposition separately');
          const issuedQty = issues.reduce((n: any, it: any) => n.plus(dec(it.quantityChange).abs()), dec(0));
          const issuedValue = issues.reduce((n: any, it: any) => n.plus(dec(it.quantityChange).abs().times(it.unitCost)), dec(0));
          const unitCost = issuedValue.div(issuedQty);
          const soldQty = inv.items.filter((it: any) => it.productId === src.productId && (it.variantId ?? null) === (src.variantId ?? null) && !it.menuItemId).reduce((n: any, it: any) => n.plus(it.quantity), dec(0));
          const returnedBaseQty = issuedQty.times(quantity).div(soldQty).toDecimalPlaces(6);
          await ctx.stock.receiveReturn({ productId: src.productId, variantId: src.variantId ?? undefined, locationId: locations[0], quantity: Number(returnedBaseQty), unitCost: Number(unitCost), reference: `Refund ${refund.id}`, sourceType: 'pos_refund', sourceId: refund.id }, tx);
        }
      }
    }
    for (const { src, quantity } of selections) await tx.invoiceItem.update({ where: { id: src.id }, data: { refundedQty: { increment: quantity } } });
    const refunded = dec(inv.amountRefunded).plus(total);
    const fullyRefunded = refunded.gte(dec(inv.totalAmount).minus('0.000001'));
    await tx.invoice.update({ where: { id: invoiceId }, data: { amountRefunded: refunded, amountResidual: dec(inv.amountResidual).minus(arReduction), refundedBy: ctx.tenant.userId, version: { increment: 1 }, ...(fullyRefunded ? { status: 'refunded', settlementStatus: 'settled' } : {}) } });
    await tx.posRefund.update({ where: { id: refund.id }, data: { payments: paymentLinks, journalEntryId: entry.id } });
    await ctx.audit.recordInTx(tx, { entity: 'Invoice', entityId: invoiceId, action: 'update', newValues: { refundId: refund.id, amount: total.toString(), reason, stockDisposition: opts.stockDisposition, payments: paymentLinks, approvedById: opts.overrideById } });
    const closed = fullyRefunded ? await ctx.closeOrderForInvoice(tx, invoiceId) : null;
    const outcome = { invoiceId, refundId: refund.id, status: fullyRefunded ? 'refunded' : 'partially_refunded', amount: total.toString(), amountReturned: payoutTotal.toString(), payments: paymentLinks, closed };
    await recordBusinessOutcome(tx, outcome, true);
    return outcome;
  });
  return result;
}
