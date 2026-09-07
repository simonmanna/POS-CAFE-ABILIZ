import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { AccountResolverService } from '../posting/account-resolver.service';
import { BALANCE_AFFECTING_STATUSES } from '../posting/posting.types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ZERO = new Prisma.Decimal(0);
const TOLERANCE = new Prisma.Decimal('0.01');

/**
 * Independent POS → GL reconciliation (C-20) + inventory/COGS lag monitor (C-08).
 *
 * Unlike the tie-out (which reuses the account mappings the posting engine used),
 * this control re-derives both sides from INDEPENDENT sources:
 *
 *   POS side:  Invoice / InvoiceItem rows (what the café actually sold)
 *   GL side :  JournalLine rows bucketed by report section (revenue, tax, contra)
 *
 * If both sides agree, the chain POS → Invoice → GL is proven end-to-end for the
 * window. If they disagree, the variance is reported per bucket so an operator
 * can investigate (a manual journal to a revenue account, a missed posting, or
 * a data-migration bug are the usual causes).
 *
 * The inventory section re-derives:
 *
 *   Stock side: InventoryLedger movement value for POS issues
 *   GL side  :  JournalLine on the `cogs` report section
 *
 * plus the async stock-posting backlog counts — the operational window (C-08)
 * where revenue is booked but COGS has not landed yet. It is a monitoring
 * surface, not a blocking check: the period-close flow already refuses to close
 * while the backlog is non-empty.
 */
@Injectable()
export class PosGlReconciliationService {
  private readonly logger = new Logger('PosGlReconciliationService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly accounts: AccountResolverService,
  ) {}

  /**
   * Reconcile POS sales vs GL revenue / tax / discount for a date window, and
   * report the inventory/COGS posting lag. All queries are explicitly org-scoped
   * (C-01 hardening) — never rely on the tenancy extension alone.
   */
  async reconcile(range: { from?: string; to?: string } = {}) {
    const organizationId = this.tenant.organizationId;
    const from = range.from ? new Date(range.from) : new Date(Date.now() - 30 * 86400 * 1000);
    const to = range.to ? new Date(range.to) : new Date();
    if (to.getTime() < from.getTime()) {
      throw new Error('`to` must be after `from`');
    }

    // ── POS side — what the POS invoices actually say ─────────────────────
    // POS sales live in the `Invoice` table (R2); back-office sales invoices in
    // `Document`. Both post revenue through the same engine, so both count.
    // Refunds are counted SEPARATELY, split into their revenue and tax portions
    // from the immutable PosRefund.items record (each line carries the refunded
    // subtotal + taxAmount at 6dp). Basis: invoices bucket by issueDate (drives
    // the original sale JE), refunds by createdAt (drives the refund JE) — both
    // sides of each comparison therefore share one posting-date basis (R-1/R-2).
    const [posAgg, docAgg, glSections, stockBacklog, stockCogs, refundRows] = await Promise.all([
      this.prisma.client.invoice.aggregate({
        where: {
          organizationId,
          issueDate: { gte: from, lte: to },
          status: { in: ['posted', 'paid', 'refunded'] },
        },
        _sum: {
          subtotal: true,
          taxAmount: true,
          discountTotal: true,
          totalAmount: true,
        },
        _count: { _all: true },
      }),
      this.prisma.client.document.aggregate({
        where: {
          organizationId,
          documentType: 'sales_invoice',
          issueDate: { gte: from, lte: to },
          status: { in: ['posted', 'paid'] },
        },
        _sum: {
          subtotal: true,
          taxAmount: true,
          discountTotal: true,
          totalAmount: true,
        },
        _count: { _all: true },
      }),
      this.glSectionTotals(organizationId, from, to),
      this.prisma.client.stockPostingJob.groupBy({
        by: ['status'],
        where: { organizationId, createdAt: { gte: from, lte: to } },
        _count: { _all: true },
      }),
      this.prisma.client.inventoryLedger.aggregate({
        where: {
          organizationId,
          createdAt: { gte: from, lte: to },
          referenceType: { in: ['pos_invoice', 'pos_invoice_extra', 'menu_recipe'] },
          quantityChange: { lt: 0 },
        },
        _sum: { totalValue: true },
      }),
      this.prisma.client.posRefund.findMany({
        where: { organizationId, createdAt: { gte: from, lte: to } },
        select: { amount: true, items: true },
      }),
    ]);

    // POS-side totals (gross), plus the refund split.
    const posSubtotal = new Prisma.Decimal((posAgg._sum.subtotal as any) ?? 0)
      .plus(new Prisma.Decimal((docAgg._sum?.subtotal as any) ?? 0));
    const posTax = new Prisma.Decimal((posAgg._sum.taxAmount as any) ?? 0)
      .plus(new Prisma.Decimal((docAgg._sum?.taxAmount as any) ?? 0));
    const posDiscount = new Prisma.Decimal((posAgg._sum.discountTotal as any) ?? 0)
      .plus(new Prisma.Decimal((docAgg._sum?.discountTotal as any) ?? 0));
    const posInvoiceCount = (posAgg._count as any) + ((docAgg._count as any) ?? 0);

    // R-1: split each refund into revenue vs tax portions from its recorded
    // line fractions. amountRefunded (invoice header) mixes both portions and
    // cannot be used — comparing it against GL revenue produces a false variance
    // equal to the refunded tax on every tax-inclusive sale.
    let refundCount = 0;
    let refundedRevenue = ZERO;
    let refundedTax = ZERO;
    let refundTotal = ZERO;
    for (const r of refundRows as any[]) {
      refundCount++;
      refundTotal = refundTotal.plus(new Prisma.Decimal(r.amount ?? 0));
      // items[] rows carry { subtotal, taxAmount } per refunded line fraction.
      for (const it of (Array.isArray(r.items) ? r.items : []) as any[]) {
        refundedRevenue = refundedRevenue.plus(new Prisma.Decimal(it.subtotal ?? 0));
        refundedTax = refundedTax.plus(new Prisma.Decimal(it.taxAmount ?? 0));
      }
    }

    // GL-side totals by section, signed for display.
    const glRevenue = glSections.get('revenue') ?? ZERO;
    const glOtherIncome = glSections.get('other_income') ?? ZERO;
    const glContraRevenue = glSections.get('contra_revenue') ?? ZERO;
    const glTax = glSections.get('tax') ?? ZERO;

    // The POS posts NET revenue (discount folded in — C-09 net method), so the
    // expected GL revenue for the window is gross subtotal minus discounts,
    // minus the refunded REVENUE portion (not the full refund amount).
    const expectedRevenue = posSubtotal.minus(posDiscount).minus(refundedRevenue);
    const actualRevenue = glRevenue.plus(glOtherIncome).minus(glContraRevenue);

    const revenueVariance = actualRevenue.minus(expectedRevenue);
    // Expected tax = gross POS tax minus the refunded TAX portion. (The refund
    // journal debits the tax account for exactly the refunded tax fraction.)
    const expectedTax = posTax.minus(refundedTax);
    const taxVariance = glTax.minus(expectedTax);

    // ── Inventory / COGS lag (C-08) ────────────────────────────────────────
    const cogsGl = glSections.get('cogs') ?? ZERO;
    const stockCogsValue = new Prisma.Decimal((stockCogs._sum.totalValue as any) ?? 0);
    const backlog: Record<string, number> = {};
    for (const g of stockBacklog as any[]) backlog[g.status] = g._count;
    const unpostedJobs =
      (backlog.pending ?? 0) + (backlog.processing ?? 0) + (backlog.failed ?? 0);

    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      pos: {
        invoiceCount: posInvoiceCount,
        grossSubtotal: posSubtotal.toString(),
        discounts: posDiscount.toString(),
        tax: posTax.toString(),
        // R-1: refund split — revenue and tax portions derived from the
        // immutable PosRefund.items line fractions, never from the invoice's
        // mixed amountRefunded header field.
        refundedRevenue: refundedRevenue.toString(),
        refundedTax: refundedTax.toString(),
        refundedTotal: refundTotal.toString(),
        expectedNetRevenue: expectedRevenue.toString(),
        expectedNetTax: expectedTax.toString(),
        refundCount,
      },
      gl: {
        revenue: glRevenue.toString(),
        otherIncome: glOtherIncome.toString(),
        contraRevenue: glContraRevenue.toString(),
        tax: glTax.toString(),
        actualNetRevenue: actualRevenue.toString(),
        cogs: cogsGl.toString(),
      },
      variance: {
        revenue: revenueVariance.toString(),
        revenueBalanced: revenueVariance.abs().lessThanOrEqualTo(TOLERANCE),
        tax: taxVariance.toString(),
        taxBalanced: taxVariance.abs().lessThanOrEqualTo(TOLERANCE),
      },
      inventory: {
        // Stock-side COGS (value of POS issues in the window) vs GL COGS.
        stockCogsValue: stockCogsValue.toString(),
        glCogs: cogsGl.toString(),
        cogsVariance: cogsGl.minus(stockCogsValue).toString(),
        cogsBalanced: cogsGl.minus(stockCogsValue).abs().lessThanOrEqualTo(TOLERANCE),
        // Async stock-posting backlog — the C-08 operational window.
        jobCounts: backlog,
        unpostedJobs,
        note:
          unpostedJobs > 0
            ? `${unpostedJobs} stock-posting job(s) in this window have not posted COGS yet. ` +
              'Revenue is booked ahead of COGS; drain the queue (Posting Monitor) before closing the period.'
            : 'All stock-posting jobs in this window have posted.',
      },
      balanced:
        revenueVariance.abs().lessThanOrEqualTo(TOLERANCE) &&
        taxVariance.abs().lessThanOrEqualTo(TOLERANCE),
    };
  }

  /**
   * Sum the ledger for the window, bucketed by each account's report section and
   * signed by its normal balance (revenue reads credit-positive, contra reads
   * debit-positive, tax reads credit-positive).
   */
  private async glSectionTotals(
    organizationId: string,
    from: Date,
    to: Date,
  ): Promise<Map<string, Prisma.Decimal>> {
    const grouped = await this.prisma.client.journalLine.groupBy({
      by: ['accountId'],
      where: {
        organizationId,
        entry: {
          status: { in: [...BALANCE_AFFECTING_STATUSES] },
          postingDate: { gte: from, lte: to },
        },
      },
      _sum: { baseDebit: true, baseCredit: true },
    });

    const accountIds = (grouped as any[]).map((g) => g.accountId);
    const meta = await this.accounts.meta(accountIds);

    const out = new Map<string, Prisma.Decimal>();
    for (const g of grouped as any[]) {
      const acct = meta.get(g.accountId);
      if (!acct || !acct.reportSection) continue;
      const debit = new Prisma.Decimal(g._sum.baseDebit ?? 0);
      const credit = new Prisma.Decimal(g._sum.baseCredit ?? 0);
      // Display-signed: credit-normal accounts are credit − debit (positive when
      // credited), debit-normal accounts are debit − credit.
      const value =
        acct.normalBalance === 'credit' ? credit.minus(debit) : debit.minus(credit);
      out.set(acct.reportSection, (out.get(acct.reportSection) ?? ZERO).plus(value));
    }
    return out;
  }
}
