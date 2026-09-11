import { businessOperation } from '../../kernel/idempotency/business-outcome';
import { assertPricingAuthority, resolveDiscountAmountThreshold, resolveDiscountThreshold } from './pricing-policy';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import { resolvePosStockLocation } from '../inventory/pos-stock-location';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { ApprovalsService } from '../../kernel/approvals/approvals.service';
import { EventBus } from '../../kernel/events/event-bus';
import { StockService } from '../inventory/stock.service';
import { PosOverridesService } from './pos-overrides.service';
import { PosModifiersService } from './pos-modifiers.service';
import { PosVariantService } from './pos-variant.service';
import { PosAccompanimentService } from './pos-accompaniment.service';
import { PosKdsService } from './pos-kds.service';
import { PosLoyaltyService } from './pos-loyalty.service';
import { PosPrintLifecycleService } from './pos-print-lifecycle.service';
import { PosReceiptsService } from './pos-receipts.service';
import { dec } from '../../kernel/common/money';
import { resolveOccurredAt } from '../../kernel/common/occurred-at';
import { EVENTS } from '@erp/shared';
import { NotificationsService } from '../../kernel/notifications/notifications.service';
import { PosTablesService } from './pos-tables.service';
import { PosOrdersService } from './order/pos-orders.service';
import { PosInvoiceService } from './billing/pos-invoice.service';
import { resolveCreditStatus } from './billing/credit-status';
import { withLegacyOrderStatus } from './order-status.util';
import type { CreateOrderDto } from './order/dto/order.dto';

export interface CheckoutLineModifier {
  modifierId: string;
  name: string;
  priceDelta: number;
}

export interface CheckoutLine {
  productId?: string;
  /** Menu-based sale: the sellable MenuItem. On checkout its recipe (MenuProduct)
   *  is what decrements stock, not a single product. */
  menuItemId?: string;
  sku?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxId?: string;
  discountPercent?: number;
  /** 'percentage' (default) or 'fixed_amount'. When 'fixed_amount', `discountAmount` is the line discount in currency. */
  discountType?: 'percentage' | 'fixed_amount';
  /** Total fixed discount for this line (in currency). Ignored unless discountType === 'fixed_amount'. */
  discountAmount?: number;
  discountReason?: string;
  note?: string;
  /** P4: modifier add-ons. Their priceDeltas are baked into unitPrice. */
  modifiers?: CheckoutLineModifier[];
  /** Selected variant id. Variant price replaces basePrice. */
  variantId?: string;
  /** Selected accompaniment option ids (one per group). */
  accompanimentOptionIds?: string[];
  /** P4: if set, this line is a combo. Backend expands it on checkout. */
  comboId?: string;
  /** P10: override the product's taxInclusive flag for this line. */
  taxInclusive?: boolean;
  /** P5 course grouping for fire/hold (1=starter, 2=main, 3=dessert, …). */
  course?: number;
}

export interface PaymentTender {
  accountId?: string;
  method: 'cash' | 'bank' | 'card' | 'mobile_money' | 'store_credit';
  amount: number;
  reference?: string;
}

export interface CheckoutInput {
  partnerId?: string;
  lines: CheckoutLine[];
  /** Multiple tenders: e.g. 60k cash + 40k card across one UGX 100k check. */
  tenders?: PaymentTender[];
  /** Back-compat: single-method tender. Ignored if `tenders` is supplied. */
  paymentMethod?: 'cash' | 'bank' | 'card' | 'mobile_money';
  amountTendered?: number;
  cashSessionId?: string;
  branchId?: string;
  reference?: string;
  notes?: string;
  /** P2: manager override required when discount is above the org's tier1 threshold. */
  overrideById?: string;
  /** P3: manager override PIN — required when `overrideById` is set (F-OVR). */
  overridePin?: string;
  /** P2: order-level discount (%). Applied AFTER line discounts. */
  transactionDiscountPercent?: number;
  /** Order-level discount type. 'percentage' (default) or 'fixed_amount'. */
  transactionDiscountType?: 'percentage' | 'fixed_amount';
  /** Order-level fixed discount amount (in currency). Ignored unless transactionDiscountType === 'fixed_amount'. */
  transactionDiscountAmount?: number;
  /** Reason for the discount (required for manual discounts > 0). */
  discountReason?: string;
  /** POS Tables (T1): table the sale is being rung on. When set, the
   *  server creates a PosTableOrder row and flips the table to OCCUPIED
   *  in the same transaction. On payment completion, the table auto-flips
   *  to DIRTY (needs cleaning). */
  tableId?: string;
  /** POS Tables (T1): party size (display only on the table card). */
  guestCount?: number;
  /** Order type: dine-in, takeaway, or delivery. When omitted, inferred
   *  from tableId (table → dine_in, no table → takeaway). */
  orderType?: 'dine_in' | 'takeaway' | 'delivery';
  /** Offline-first: when the sale was actually rung up on the device. Drives
   *  Invoice.issueDate (GL date, report buckets) + the Payment date on replay.
   *  Validated: not future, ≤ 7 days old. Omitted → now(). */
  expectedTotal?: number;
    expectedVersion?: number;
  occurredAt?: string;
  /** How the sale is settled. 'credit' books the whole bill to the customer's
   *  AR instead of collecting anything now — see SettleMode. */
  settleMode?: SettleMode;
}

/**
 * How a sale is settled.
 *
 * 'tender' (default) — the customer pays now, with one or more tenders.
 * 'credit'           — the customer pays LATER. Nothing is collected: no
 *                      Payment row, no cash movement, no drawer impact. The
 *                      invoice keeps its `Dr AR / Cr Revenue+Tax` entry from
 *                      billing time and stays unpaid (settlementStatus
 *                      'unsettled') until a payment is received against it.
 *
 * Credit is deliberately NOT a tender method: cash/card/mobile money describe
 * HOW the customer paid, credit describes that they have not.
 */
export type SettleMode = 'tender' | 'credit';

 // %

@Injectable()
export class PosService {
  async paymentAccounts() {
    const rows = await this.prisma.client.account.findMany({ where: { organizationId: this.tenant.organizationId, isActive: true, deletedAt: null, category: { key: { in: ['cash', 'petty_cash', 'bank', 'mobile_money', 'current_asset'] } } }, include: { category: true }, orderBy: { code: 'asc' } });
    const clearing = await this.prisma.client.accountMapping.findFirst({ where: { organizationId: this.tenant.organizationId, key: 'card_clearing' } });
    return rows.filter((a: any) => a.category.key !== 'current_asset' || a.id === clearing?.accountId).map((a: any) => ({ id: a.id, code: a.code, name: a.name, accountType: a.category.key }));
  }
  private readonly logger = new Logger('PosService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly stock: StockService,
    private readonly overrides: PosOverridesService,
    private readonly notifications: NotificationsService,
    private readonly modifiers: PosModifiersService,
    private readonly variants: PosVariantService,
    private readonly accompaniments: PosAccompanimentService,
    private readonly kds: PosKdsService,
    private readonly loyalty: PosLoyaltyService,
    private readonly printLifecycle: PosPrintLifecycleService,
    private readonly receipts: PosReceiptsService,
    private readonly tables: PosTablesService,
    private readonly orders: PosOrdersService,
    private readonly billing: PosInvoiceService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * F.5b — Record a synchronous POS manager override (discount/refund) into the
   * unified approval ledger. The manager PIN *is* the approval, so this never
   * blocks the sale: it is awaited (to stay inside the request's tenant context)
   * but can never throw. Threshold policy lives centrally in ApprovalWorkflow.
   */
  private async recordPosOverride(
    entityType: 'pos_discount' | 'pos_refund',
    approverId: string,
    snapshot: Record<string, unknown>,
    entityId?: string,
  ): Promise<void> {
    try {
      await this.approvals.recordSynchronousOverride({
        entityType,
        entityId: entityId ?? randomUUID(),
        approverId,
        snapshot,
      });
    } catch (err) {
      this.logger.warn(`Failed to record ${entityType} override in approval ledger: ${String(err)}`);
    }
  }

  /**
   * Counter sale — the canonical Order → Invoice → Receipt pipeline. Creates an
   * Order from the cart, fires the kitchen, generates the Invoice (which posts
   * its own GL + deducts stock), then takes payment (which writes the Receipt +
   * ReceiptItems and closes the order). Every counter sale now persists into the
   * Order/Invoice/InvoiceItem/Receipt/ReceiptItem tables — NOT Document.
   */
  async checkout(input: CheckoutInput) {
    const op = businessOperation.getStore();
    const previous = op?.recovery?.orderId
      ? await this.orders.getOrder(op.recovery.orderId)
      : op ? await this.prisma.client.order.findFirst({ where: { organizationId: this.tenant.organizationId, clientOperationKey: op.key } }) : null;
    if (previous) return this.settleResolvedOrder(previous, input);
    if (!input.lines?.length) throw new BadRequestException('Cart is empty');
    const orgId = this.tenant.organizationId;

    // Offline-first: validate the client business timestamp up front so a bad
    // device clock fails the whole sale before any write happens.
    resolveOccurredAt(input.occurredAt);

    // H1 — a sale that collects physical cash MUST post against an open drawer
    // session owned by the caller, otherwise the GL cash leg diverges from the
    // till (no CashMovement is written). Resolve/validate it before anything.
    const cashSessionId = await this.requireCashSession(input);
    input = { ...input, cashSessionId };

    // Credit needs a real customer to owe the money — checked before any write.
    const isCredit = input.settleMode === 'credit';
    if (isCredit) await this.assertCreditCustomer(input.partnerId);

    // Manager-override guard for high discounts (validates line + tx discount).
    const quote = await this.orders.quote(input as any);
    const effectiveDiscount = await assertPricingAuthority(this, quote.baseLines, input);
    if (input.expectedTotal != null && Math.abs(quote.total - input.expectedTotal) > 0.000001) throw new BadRequestException('The price changed. Refresh the quote before payment.');

    await this.billing.preflightPayment(quote.total, input, input.partnerId);

    // 1) Operational Order from the cart. resolveLines folds variants /
    //    accompaniments / modifiers and expands combos, and validates rules.
    const order = await this.orders.createOrder({
      orderType: input.orderType ?? (input.tableId ? 'dine_in' : 'takeaway'),
      tableId: input.tableId,
      partnerId: input.partnerId,
      branchId: input.branchId,
      cashSessionId: input.cashSessionId,
      guestCount: input.guestCount,
      notes: input.notes,
      lines: input.lines.map((l) => this.toOrderLine(l)),
    } as CreateOrderDto);

    // 2) Fire the new items to the kitchen (best-effort — never fails the sale).
    try { await this.orders.fireKitchen(order.id); } catch (e: any) { this.logger.warn(`fireKitchen failed: ${e?.message}`); }

    // 3) Generate the Invoice: posts Dr AR / Cr Revenue+Tax to the GL and
    //    deducts inventory at bill time. Preserve the order on failure.
    let invoice: any;
    try {
      invoice = await this.billing.generateInvoice(order.id, {
        cashSessionId: input.cashSessionId,
        transactionDiscountPercent: input.transactionDiscountPercent,
        transactionDiscountType: input.transactionDiscountType,
        transactionDiscountAmount: input.transactionDiscountAmount,
        discountReason: input.discountReason,
        overrideById: input.overrideById,
        overridePin: input.overridePin,
        expectedTotal: input.expectedTotal,
        expectedVersion: input.expectedVersion,
        branchId: input.branchId,
        occurredAt: input.occurredAt,
        // Credit leaves paymentMode null so postInvoiceGl keeps AR as the
        // counter-account. Sending 'cash' here would debit Cash for money that
        // was never collected.
        paymentMode: isCredit
          ? undefined
          : input.tenders?.length
            ? this.resolvePaymentMode(input.tenders)
            : input.paymentMethod === 'bank' ? 'card' : (input.paymentMethod ?? 'cash'),
      });
    } catch (e) {
      throw e;
    }

    // 4) Take payment + settle: writes Payment + allocation, the Receipt +
    //    ReceiptItems, marks the invoice settled and closes the order. On
    //    failure, preserve the invoice and operation for exact recovery.
    let pay: any;
    try {
      // Credit: collect nothing now — flag the invoice and leave it in AR.
      pay = isCredit
        ? await this.billing.settleCredit(invoice.id, { partnerId: input.partnerId })
        : await this.billing.receivePayment(invoice.id, {
            tenders: input.tenders,
            paymentMethod: input.paymentMethod,
            amountTendered: input.amountTendered,
            cashSessionId: input.cashSessionId,
            occurredAt: input.occurredAt,
          });
    } catch (e) {
      throw e;
    }

    // 5) Loyalty (best-effort, skip the walk-in).
    try {
      if (invoice.partnerId) {
        const partner = await this.prisma.client.partner.findFirst({ where: { id: invoice.partnerId, organizationId: orgId } });
        if (partner && partner.code !== 'WALKIN') {
          await this.loyalty.earnPoints({ partnerId: invoice.partnerId, documentId: invoice.id, amount: Number(invoice.totalAmount), reason: 'sale' });
        }
      }
    } catch (e: any) { this.logger.error(`loyalty earnPoints failed: ${e?.message}`); }

    this.events.publish(EVENTS.PosSaleCompleted, {
      organizationId: orgId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      cashSessionId: input.cashSessionId,
      total: invoice.totalAmount.toString(),
    });

    const tendered = input.amountTendered ?? Number(invoice.totalAmount);

    // Resolve receipt data so the frontend can display/print immediately.
    let receiptText: string | undefined;
    let receiptHtml: string | undefined;
    try {
      receiptText = await this.receipts.buildTextReceipt(invoice.id);
      receiptHtml = await this.receipts.buildHtmlReceipt(invoice.id);
    } catch { /* non-fatal */ }

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentIds: (pay?.paymentIds as string[]) ?? [],
      total: Number(invoice.totalAmount),
      // Nothing was handed over on a credit sale, so there is nothing to give back.
      change: isCredit ? 0 : (pay?.change ?? Math.max(0, tendered - Number(invoice.totalAmount))),
      settleMode: isCredit ? ('credit' as const) : ('tender' as const),
      /** Outstanding balance left on the customer's account (0 unless credit). */
      amountDue: isCredit ? Number(invoice.totalAmount) : 0,
      discountPercent: effectiveDiscount,
      receiptId: pay?.receiptId,
      receiptText,
      receiptHtml,
    };
  }

  /** Map a POS cart line to the Order DTO (raw — server-side folding/pricing). */
  private toOrderLine(l: CheckoutLine): any {
    return {
      productId: l.productId,
      menuItemId: l.menuItemId,
      sku: l.sku,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxId: l.taxId,
      discountPercent: l.discountPercent,
      discountType: l.discountType,
      discountAmount: l.discountAmount,
      discountReason: l.discountReason,
      note: l.note,
      modifiers: l.modifiers,
      variantId: l.variantId,
      accompanimentOptionIds: l.accompanimentOptionIds,
      comboId: l.comboId,
      taxInclusive: l.taxInclusive,
    };
  }


  /**
   * P9.C — Low-stock alert. Publishes a domain event AND writes a notification
   * so the manager's bell icon lights up. Rate-limited: only fires once per
   * product per 15 minutes so a busy shift doesn't spam.
   */
  private async publishLowStockAlert(input: {
    productId: string;
    productName: string;
    onHand: number;
    minQuantity: number;
    invoiceId: string;
  }): Promise<void> {
    const orgId = this.tenant.organizationId;
    // Rate-limit via AuditLog dedupe.
    const fifteenMinAgo = new Date(Date.now() - 15 * 60_000);
    const recent = await this.prisma.raw.auditLog.findFirst({
      where: {
        organizationId: orgId,
        entity: 'Product',
        entityId: input.productId,
        createdAt: { gte: fifteenMinAgo },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) return; // already alerted for this product in the last 15 min
    await this.audit.record({
      entity: 'Product',
      entityId: input.productId,
      action: 'update' as any,
      newValues: { lowStockAlert: { onHand: input.onHand, min: input.minQuantity, trigger: input.invoiceId } },
    });
    await this.notifications.send({
      organizationId: orgId,
      channel: 'in_app',
      category: 'inventory',
      title: `Low stock: ${input.productName}`,
      body: `On hand ${input.onHand} (min ${input.minQuantity}) after sale ${input.invoiceId}.`,
      payload: { kind: 'low_stock', productId: input.productId, onHand: input.onHand, minQuantity: input.minQuantity, invoiceId: input.invoiceId },
    });
  }

  /**
   * P9 helper — read on-hand for a product (first warehouse). Returns 0 if
   * the product has no stock record. Used by the menu card to render the
   * low-stock orange dot in the terminal.
   */
  async getOnHand(productId: string): Promise<number> {
    const orgId = this.tenant.organizationId;
    const warehouse = await resolvePosStockLocation(this.prisma, orgId);
    if (!warehouse) return 0;
    const item = await this.prisma.client.stockItem.findFirst({
      where: { organizationId: orgId, productId, locationId: warehouse.id },
    });
    return Number(item?.quantity ?? 0);
  }

  /**
   * Refund / void of a settled POS sale now goes through `PosInvoiceService.refund`
   * (canonical endpoint: POST /pos/invoices/:id/refund). The legacy
   * Document-table path that used to live here was deleted as part of POS
   * Sprint 1 hardening (audit F1) because it bypassed the FOR UPDATE lock and
   * per-line over-refund guard, and wrote credit notes that the new
   * Invoice-side reconciliation never saw.
   *
   * @deprecated Use {@link PosInvoiceService.refund} via the
   *   `POST /pos/invoices/:id/refund` endpoint.
   */

  /**
   * Void a sale. The canonical endpoint POST /pos/sales/:id/void delegates
   * straight to `PosInvoiceService.refund(... requireOverride: true ...)` —
   * the legacy `PosService.voidSale` shim that re-routed through the deleted
   * Document-based refund path was removed as part of POS Sprint 1 (audit F1).
   */

  // ─── Open-tab dine-in (M4) ───────────────────────────────────────────────
  //
  // A "tab" is a persistent draft Document linked to an open PosTableOrder. The
  // waiter opens a tab, adds rounds (each round appends lines + can fire the
  // kitchen), the running bill is always readable, and the tab is settled — and
  // only then posted + paid + stock-issued + the table marked dirty — at the end.

  /** Return the open (unbilled) tab for a table — the running bill — or null. */
  async getTab(tableId: string) {
    const order = await this.orders.getOpenOrderForTable(tableId);
    if (!order) return null;
    return this.toTabView(order);
  }

  /**
   * Rehydrate ANY open order (table-bound or tableless) into the terminal's tab
   * view — the resume primitive for the Odoo-style Orders panel. Reuses toTabView
   * so un-baked variant/accompaniment prices come back exactly as for a dine-in tab.
   */
  async resumeOrder(orderId: string) {
    const order = await this.orders.getOrder(orderId);
    return this.toTabView(order);
  }

  /**
   * Map an open Order (with items) to the tab view the POS terminal renders.
   * Keeps the historical "TabDocument" shape (lines + running totals) but sourced
   * from the Order aggregate — no Document involved.
   *
   * Lines carry the full variant/accompaniment state so the terminal can rebuild
   * its cart exactly on reload. `variantPrice` and `accompanimentPriceImpact` are
   * re-resolved from the DB here because OrderItem stores only the folded
   * unitPrice — without them the terminal can't un-bake the base price on the
   * next save and accompaniment charges would double.
   */
  private async toTabView(o: any) {
    const customer = o.partnerId ? await this.prisma.client.partner.findFirst({ where: { id: o.partnerId, organizationId: this.tenant.organizationId }, select: { id: true, code: true, name: true } }) : null;
    const items: any[] = o.items ?? [];

    const variantIds = [...new Set(items.map((it) => it.variantId).filter(Boolean))] as string[];
    const optionIds = [...new Set(items.flatMap((it) => it.accompanimentOptionIds ?? []))] as string[];
    const [variants, options] = await Promise.all([
      variantIds.length
        ? this.prisma.client.menuItemVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true, price: true } })
        : Promise.resolve([]),
      optionIds.length
        ? this.prisma.client.accompanimentOption.findMany({ where: { id: { in: optionIds } }, select: { id: true, priceImpact: true } })
        : Promise.resolve([]),
    ]);
    const variantPriceById = new Map((variants as any[]).map((v) => [v.id, Number(v.price)]));
    const optionImpactById = new Map((options as any[]).map((op) => [op.id, Number(op.priceImpact)]));

    // Names for every identity this view attributes work to: the order's waiter
    // plus each line's puncher. One query, and only for the ids whose name is
    // not already denormalised on the row.
    const staffIds = new Set<string>();
    if (o.waiterId) staffIds.add(o.waiterId);
    for (const it of items) {
      if (it.punchedById && !it.punchedByName) staffIds.add(it.punchedById);
    }
    const staff = staffIds.size
      ? await this.prisma.client.user.findMany({ where: { id: { in: Array.from(staffIds) } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const staffName = new Map((staff as any[]).map((u) => [u.id, `${u.firstName}${u.lastName ? ' ' + u.lastName : ''}`.trim()]));

    return {
      id: o.id,
      orderNumber: o.orderNumber,
      // Canonical status + the legacy alias, so in-field Android APKs that still
      // read 'open'/'preparing'/'served' keep working through the compat window.
      ...withLegacyOrderStatus(o.status),
      // Optimistic-lock token — the terminal echoes it back on save so a stale
      // full-replace from another device is rejected (H2) instead of clobbering.
      version: o.version ?? 0,
      subtotal: String(o.subtotal ?? 0),
      discountTotal: String(o.discountTotal ?? 0),
      taxAmount: String(o.taxAmount ?? 0),
      totalAmount: String(o.totalAmount ?? 0),
      guestCount: o.guestCount ?? null,
      partnerId: o.partnerId ?? null,
      customer,
      // Cart context for the Orders-panel resume (a tableless order restores its
      // own type; a dine-in one restores its table). Additive — tab reads ignore them.
      tableId: o.tableId ?? null,
      orderType: o.orderType ?? null,
      /// Who owns this order (opened it). Per-line attribution lives on each line.
      waiterId: o.waiterId ?? null,
      waiterName: o.waiterId ? (staffName.get(o.waiterId) ?? null) : null,
      transactionDiscountPercent: Number(o.transactionDiscountPercent ?? 0), transactionDiscountType: o.transactionDiscountType, transactionDiscountAmount: Number(o.transactionDiscountAmount ?? 0), discountReason: o.discountReason,
      cashSessionId: o.cashSessionId,
      lines: items.map((it: any) => {
        const qty = Number(it.quantity);
        const unit = Number(it.unitPrice);
        const disc = Number(it.discountPercent ?? 0);
        const total = qty * unit - (it.discountType === 'fixed_amount' ? Number(it.discountAmount ?? 0) : qty * unit * disc / 100);
        const accIds: string[] = it.accompanimentOptionIds ?? [];
        // OrderItem.note holds "user note | + accompaniment | + modifier" (the
        // folded KOT form). Return only the user part — the add-on names travel
        // in their own fields, and echoing the folded note back on save would
        // re-fold it and duplicate the "+ x" parts.
        const userNote = (it.note ?? '')
          .split(' | ')
          .filter((part: string) => part && !part.startsWith('+ '))
          .join(' | ');
        return {
          id: it.id,
          productId: it.productId ?? null,
          menuItemId: it.menuItemId ?? null,
          description: it.description,
          quantity: String(it.quantity),
          unitPrice: String(it.unitPrice),
          total: String(total),
          taxId: it.taxId ?? null,
          taxInclusive: it.taxInclusive ?? false,
          discountPercent: String(it.discountPercent ?? 0),
          discountType: it.discountType, discountAmount: String(it.discountAmount ?? 0), discountReason: it.discountReason, course: it.course,
          // A-016: the terminal needs to know a line is already with the kitchen
          // — that line may only leave through the audited void route.
          kitchenPrintedQty: Number(it.kitchenPrintedQty ?? 0),
          kitchenStatus: it.kitchenStatus ?? 'pending',
          // Per-item attribution: who punched THIS line (may differ from the
          // order's waiter when a colleague took a later round). Falls back to
          // the order owner for rows created before per-item stamping existed.
          punchedById: it.punchedById ?? o.waiterId ?? null,
          punchedByName: it.punchedByName
            ?? (it.punchedById ? staffName.get(it.punchedById) ?? null : null)
            ?? (o.waiterId ? staffName.get(o.waiterId) ?? null : null),
          note: userNote || null,
          variantId: it.variantId ?? null,
          variantName: it.variantName ?? null,
          variantPrice: it.variantId != null ? variantPriceById.get(it.variantId) ?? null : null,
          accompanimentOptionIds: accIds,
          accompanimentNames: it.accompanimentNames ?? [],
          accompanimentPriceImpact: accIds.reduce((s: number, oid: string) => s + (optionImpactById.get(oid) ?? 0), 0),
          modifiers: (it.modifiers ?? []).map((m: any) => ({
            modifierId: m.modifierId, name: m.name, priceDelta: String(m.priceDelta),
          })),
        };
      }),
    };
  }

  /** Record the table↔open-order occupancy link (denormalised for the table map). */
  private async linkTableOrder(tableId: string, orderId: string, guestCount?: number): Promise<void> {
    await this.prisma.client.posTableOrder.create({
      data: {
        organizationId: this.tenant.organizationId,
        tableId,
        orderId,
        guestCount: guestCount ?? null,
      },
    });
  }

  /** Close the table↔order occupancy link (does not free the table by itself). */
  private async closeTableLink(tableId: string, orderId: string): Promise<void> {
    await this.prisma.client.posTableOrder.updateMany({
      where: { tableId, orderId, closedAt: null },
      data: { closedAt: new Date() },
    });
  }

  /**
   * Add a round of items to a table's tab. Opens the Order on the first round and
   * appends to it thereafter (delegating to the Order aggregate, which prices,
   * validates and snapshots totals), flips the table OCCUPIED, and optionally
   * fires the new items to the kitchen. No GL / stock / cash effect happens until
   * the tab is settled.
   */
  async addToTab(input: {
    tableId: string;
    cashSessionId?: string;
    lines: CheckoutLine[];
    partnerId?: string;
    guestCount?: number;
    sendToKitchen?: boolean;
    overrideById?: string;
    overridePin?: string;
    expectedTotal?: number;
    expectedVersion?: number;
    transactionDiscountPercent?: number;
  }) {
    if (!input.lines?.length) throw new BadRequestException('No items to add');
    // Line discounts on a tab still need manager authority above the threshold.
    await this.assertDiscountAuthority({
      lines: input.lines,
      transactionDiscountPercent: input.transactionDiscountPercent,
      overrideById: input.overrideById,
        overridePin: input.overridePin,
        expectedTotal: input.expectedTotal,
        expectedVersion: input.expectedVersion,
    } as CheckoutInput);

    const lines = input.lines.map((l) => this.toOrderLine(l));
    const existing = await this.orders.getOpenOrderForTable(input.tableId);
    let order: any;
    if (existing) {
      order = await this.orders.addItems(existing.id, {
        lines,
        sendToKitchen: input.sendToKitchen,
        guestCount: input.guestCount,
        overrideById: input.overrideById,
        overridePin: input.overridePin,
        expectedTotal: input.expectedTotal,
        expectedVersion: input.expectedVersion,
        transactionDiscountPercent: input.transactionDiscountPercent,
      } as any);
    } else {
      order = await this.orders.createOrder({
        orderType: 'dine_in',
        tableId: input.tableId,
        cashSessionId: input.cashSessionId,
        partnerId: input.partnerId,
        guestCount: input.guestCount,
        overrideById: input.overrideById,
        overridePin: input.overridePin,
        expectedTotal: input.expectedTotal,
        expectedVersion: input.expectedVersion,
        lines,
      } as CreateOrderDto);
      await this.linkTableOrder(input.tableId, order.id, input.guestCount);
      if (input.sendToKitchen) {
        await this.orders.fireKitchen(order.id).catch((e: any) => this.logger.warn(`fireKitchen failed: ${e?.message}`));
      } else {
        await this.autoSendRoutedLines(order.id);
      }
    }
    return this.toTabView(order);
  }

  /**
   * Replace the table's open draft order with EXACTLY these lines (auto-save).
   * Source-of-truth write for the "one open order per table" model: the cart on
   * screen always equals the table's draft order. Creates the order on the first
   * save; when the line set becomes empty the draft is cancelled and the table is
   * freed. No GL / stock / cash effect — that all happens at settle. The only
   * kitchen effect is auto-send: lines whose MenuItem pins an explicit
   * `stationCode` go straight to that KDS station (see `autoSendRoutedLines`).
   */
  async saveTabItems(input: {
    tableId: string;
    cashSessionId?: string;
    lines: CheckoutLine[];
    partnerId?: string;
    guestCount?: number;
    /** H2 — the version the terminal last read; a mismatch means another device
     *  edited this tab first and this stale full-replace is rejected (409). */
    expectedVersion?: number;
    transactionDiscountPercent?: number;
    transactionDiscountType?: 'percentage' | 'fixed_amount';
    transactionDiscountAmount?: number;
    discountReason?: string;
    /** Audit#2 N-02 — why the cart was cleared; required once food was fired. */
    cancelReason?: string;
    overrideById?: string;
    overridePin?: string;
  }) {
    const existing = await this.orders.getOpenOrderForTable(input.tableId);

    // A split in progress pins the tab's items (SplitBillItems reference them by
    // id). Rewriting them here would orphan those refs, so block edits until the
    // split is settled or cancelled.
    if (existing) {
      const activeSplit = await this.prisma.client.splitBill.count({
        where: { sourceOrderId: existing.id, status: { not: 'void' } },
      });
      if (activeSplit > 0) {
        throw new BadRequestException('Split in progress — settle or cancel the split before changing this order.');
      }
    }
    // NOTE: a billed order (invoiceId set) still HOLDS the table but is invisible
    // to getOpenOrderForTable (which only returns the editable, un-billed tab). We
    // deliberately allow adding here — `existing` is null, so saveTabItems falls
    // through to createOrder(), which starts a NEW round/bill on the same table.
    // The prior billed bill settles independently; the table frees once every
    // order on it is closed. createOrder's guard only blocks a second UN-billed
    // tab, so it won't fight this.

    const lines = (input.lines ?? []).map((l) => this.toOrderLine(l));

    // Empty order → cancel the open order and free the table.
    //
    // Audit#2 N-02 — this short-circuits before `saveItems`, so it never met the
    // fired-item rule inside `writeItems`: clearing the cart voided every cooked
    // line for free while voiding ONE of them needed a manager. It now hands the
    // decision to the same policy `cancelOrder` uses. The default reason is
    // deliberately a placeholder the policy rejects, so an order the kitchen has
    // seen forces the cashier to supply a real one, while an untouched cart
    // still clears in one tap.
    if (lines.length === 0) {
      if (existing) {
        if (input.expectedVersion == null) throw new BadRequestException('An order version is required before clearing saved items');
        await this.orders.cancelOrder(
          existing.id,
          input.cancelReason ?? 'Order emptied',
          input.expectedVersion,
          { overrideById: input.overrideById, overridePin: input.overridePin },
        );
        await this.closeTableLink(input.tableId, existing.id);
      }
      return null;
    }

    let order: any;
    if (existing) {
      order = await this.orders.saveItems(existing.id, {
        ...input, lines,
        guestCount: input.guestCount,
        partnerId: input.partnerId,
        expectedVersion: input.expectedVersion,
      } as any);
    } else {
      order = await this.orders.createOrder({
        orderType: 'dine_in',
        ...input, lines,
      } as CreateOrderDto);
      await this.linkTableOrder(input.tableId, order.id, input.guestCount);
      await this.autoSendRoutedLines(order.id);
    }
    return this.toTabView(order);
  }

  /**
   * Auto-send: push every un-fired line that is pinned to a prep station
   * (`MenuItem.stationCode`) to the KDS. Items with no station configured are
   * untouched — they still wait for the cashier's explicit "Send to Kitchen".
   *
   * Best-effort by design: the kitchen display must never be able to fail a
   * sale, and `fireKitchen` is delta-based, so a retry re-sends nothing.
   */
  private async autoSendRoutedLines(orderId: string) {
    try {
      await this.orders.fireKitchen(orderId, { onlyRouted: true });
    } catch (e: any) {
      this.logger.warn(`auto-send to KDS failed for order ${orderId}: ${e?.message}`);
    }
  }

  /**
   * Fire the table's current open order to the kitchen display (KDS). Delegates
   * to the Order aggregate, which sends only the new / increased quantities
   * (delta) since the last fire and records cancellations for decreases.
   */
  async fireTabToKitchen(tableId: string) {
    const order = await this.orders.getOpenOrderForTable(tableId);
    if (!order) throw new BadRequestException('No open order to send to the kitchen');
    return this.orders.fireKitchen(order.id);
  }

  /**
   * Settle a table's open tab: post the draft invoice, issue stock, take the
   * tender(s), close the tab and mark the table dirty — reusing the same
   * recoverable sale path as a counter checkout.
   */
  async settleTab(input: {
    tableId: string;
    tenders?: PaymentTender[];
    paymentMethod?: 'cash' | 'bank' | 'card' | 'mobile_money';
    amountTendered?: number;
    transactionDiscountPercent?: number;
    transactionDiscountType?: 'percentage' | 'fixed_amount';
    transactionDiscountAmount?: number;
    discountReason?: string;
    overrideById?: string;
    overridePin?: string;
    cashSessionId?: string;
    expectedTotal?: number;
    expectedVersion?: number;
  occurredAt?: string;
    settleMode?: SettleMode;
    partnerId?: string;
  }) {
    const orgId = this.tenant.organizationId;

    // Offline-first: reject a bad client timestamp before any write.
    resolveOccurredAt(input.occurredAt);

    // H1 — a cash/mobile-money settle must post against an open drawer session
    // owned by the caller (so the till reconciles). Card-only tabs may settle
    // without one. Resolve/validate before touching the tab.
    const cashSessionId = await this.requireCashSession(input);
    input = { ...input, cashSessionId };

    // T-LOCK: lock the table row so two cashiers cannot settle the same tab concurrently.
    await this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        input.tableId,
        orgId,
      );
    });

    // The open tab IS an Order — settle it directly (no Document bridge).
    const recoveryOrderId = businessOperation.getStore()?.recovery?.orderId;
    const order = recoveryOrderId ? await this.orders.getOrder(recoveryOrderId) : await this.orders.getOpenOrderForTable(input.tableId);
    if (!order) throw new BadRequestException('No open tab to settle on this table');
    if (!order.items?.length) throw new BadRequestException('The tab is empty');

    return this.settleResolvedOrder(order, input);
  }

  /**
   * Settle ANY open order by id — the counter/retail + Orders-panel path. Mirrors
   * settleTab but locks the Order row (there may be no table) so it also settles a
   * tableless walk-in/takeaway/delivery order, or a dine-in order chosen from the
   * Orders list. Same recoverable sale path as a counter checkout.
   */
  async settleOrder(input: {
    orderId: string;
    tenders?: PaymentTender[];
    paymentMethod?: 'cash' | 'bank' | 'card' | 'mobile_money';
    amountTendered?: number;
    transactionDiscountPercent?: number;
    transactionDiscountType?: 'percentage' | 'fixed_amount';
    transactionDiscountAmount?: number;
    discountReason?: string;
    overrideById?: string;
    overridePin?: string;
    cashSessionId?: string;
    expectedTotal?: number;
    expectedVersion?: number;
  occurredAt?: string;
    settleMode?: SettleMode;
    partnerId?: string;
  }) {
    const orgId = this.tenant.organizationId;

    // Offline-first: reject a bad client timestamp before any write.
    resolveOccurredAt(input.occurredAt);

    // H1 — a cash/mobile-money settle must post against an open drawer session
    // owned by the caller. Card-only orders may settle without one.
    const cashSessionId = await this.requireCashSession(input);
    input = { ...input, cashSessionId };

    // Lock the order row so two cashiers cannot settle the same order concurrently.
    await this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM "Order" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        input.orderId,
        orgId,
      );
    });

    const order = await this.orders.getOrder(input.orderId);
    if (order.invoiceId && businessOperation.getStore()?.recovery?.orderId !== order.id) throw new BadRequestException('This order is already billed; collect against its existing invoice');
    if (order.status === 'cancelled' || order.status === 'closed') {
      throw new BadRequestException(`Order is ${order.status}`);
    }
    if (!order.items?.length) throw new BadRequestException('The order is empty');

    return this.settleResolvedOrder(order, input);
  }

  /**
   * Shared settle tail for an already-resolved, locked open order (table-bound or
   * not): split guard, PIN re-verify, generate the Invoice (GL + stock), take
   * payment (Receipt + close), free the table when dine-in, then loyalty / events
   * / receipt render. Recoverable exactly like a counter checkout, so GL,
   * stock, idempotency and cash-change stay byte-for-byte identical across
   * checkout / settleTab / settleOrder.
   *
   * `settleMode: 'credit'` swaps only the payment step for settleCredit — the
   * invoice, GL, stock, table release, loyalty and receipt render are the same
   * code, which is exactly why credit no longer needs its own pipeline.
   */
  private async settleResolvedOrder(
    order: any,
    input: {
      tableId?: string;
      tenders?: PaymentTender[];
      paymentMethod?: 'cash' | 'bank' | 'card' | 'mobile_money';
      amountTendered?: number;
      transactionDiscountPercent?: number;
      transactionDiscountType?: 'percentage' | 'fixed_amount';
      transactionDiscountAmount?: number;
      discountReason?: string;
      overrideById?: string;
      overridePin?: string;
      cashSessionId?: string;
      expectedTotal?: number;
    expectedVersion?: number;
  occurredAt?: string;
      settleMode?: SettleMode;
      partnerId?: string;
    },
  ) {
    const orgId = this.tenant.organizationId;

    // A split in progress owns settlement — settling the whole order here would
    // double-charge items already assigned to (and paid on) split bills.
    const activeSplit = await this.prisma.client.splitBill.count({ where: { sourceOrderId: order.id, status: { not: 'void' } } });
    if (activeSplit > 0) {
      throw new BadRequestException('This order has a split in progress — settle each split bill instead.');
    }

    if (order.cashSessionId && input.cashSessionId && order.cashSessionId !== input.cashSessionId) throw new BadRequestException('This order belongs to a different register session');
    if (!order.invoiceId && input.expectedVersion != null && order.version !== input.expectedVersion) throw new BadRequestException('The saved order changed. Review it before paying.');
    if (!order.invoiceId) {
      const pricedItems = order.items ?? (await this.orders.getOrder(order.id)).items;
      await assertPricingAuthority(this, pricedItems.map((i: any) => ({ ...i, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice) })), input);
    }
    // F-OVR: re-verify PIN if override is supplied
    if (input.overrideById) {
      await this.overrides.verifyOperationApproval(input.overrideById, input.overridePin, 'discount');
    }

    // The customer is often attached at charge time (the Charge dialog's picker),
    // long after the tab was opened against the walk-in. Move them onto the order
    // BEFORE it is billed, so the invoice, loyalty points and the house-account
    // statement all name the real customer instead of the walk-in.
    if (input.partnerId && input.partnerId !== order.partnerId) {
      await this.prisma.client.order.update({
        where: { id: order.id },
        data: { partnerId: input.partnerId },
      });
      order = { ...order, partnerId: input.partnerId };
    }

    // Credit needs a real customer to owe the money — checked BEFORE the
    // invoice is generated so we never bill an order we then can't settle.
    const isCredit = input.settleMode === 'credit';
    if (isCredit) await this.assertCreditCustomer(order.partnerId);

    if (!order.invoiceId) await this.billing.preflightOrderPayment(order, input);

    // Generate the Invoice (own GL + stock at bill time) then take payment
    // (writes the Receipt + ReceiptItems and closes the order).
    let invoice: any;
    try {
      invoice = await this.billing.generateInvoice(order.id, {
        cashSessionId: input.cashSessionId,
        transactionDiscountPercent: input.transactionDiscountPercent,
        transactionDiscountType: input.transactionDiscountType,
        transactionDiscountAmount: input.transactionDiscountAmount,
        discountReason: input.discountReason,
        overrideById: input.overrideById,
        overridePin: input.overridePin,
        expectedTotal: input.expectedTotal,
        expectedVersion: input.expectedVersion,
        occurredAt: input.occurredAt,
      });
    } catch (e: any) {
      this.logger.error(`[settle] invoice generation failed for order ${order.id}: ${e?.message ?? e}`);
      throw e;
    }
    let pay: any;
    try {
      // Credit: collect nothing. settleCredit flags the invoice, issues the
      // credit-issue receipt and closes the order, leaving the balance in AR.
      pay = isCredit
        ? await this.billing.settleCredit(invoice.id, { partnerId: order.partnerId })
        : await this.billing.receivePayment(invoice.id, {
            tenders: input.tenders,
            paymentMethod: input.paymentMethod,
            amountTendered: input.amountTendered,
            cashSessionId: input.cashSessionId,
            occurredAt: input.occurredAt,
          });
    } catch (e: any) {
      this.logger.error(`[settle] payment failed for invoice ${invoice.invoiceNumber} (${invoice.id}): ${e?.message ?? e}`);
      throw e;
    }

    // Close the tab: retire the table↔order link so the table frees (dine-in
    // only). The Order itself is closed by billing.receivePayment.
    let tableStatus: string | undefined;
    if (order.tableId) {
      try {
        const closeResult = await this.tables.closeTableOrder({ tableId: order.tableId, orderId: order.id });
        tableStatus = (closeResult as any)?.tableStatus;
      } catch (e: any) { this.logger.warn(`Close table failed: ${e?.message}`); }
    }

    // Loyalty (best-effort, skip the walk-in).
    try {
      if (invoice.partnerId) {
        const partner = await this.prisma.client.partner.findFirst({ where: { id: invoice.partnerId, organizationId: orgId } });
        if (partner && partner.code !== 'WALKIN') {
          await this.loyalty.earnPoints({ partnerId: invoice.partnerId, documentId: invoice.id, amount: Number(invoice.totalAmount), reason: 'sale' });
        }
      }
    } catch (e: any) { this.logger.error(`loyalty earnPoints failed: ${e?.message}`); }

    this.events.publish(EVENTS.PosSaleCompleted, {
      organizationId: orgId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      cashSessionId: input.cashSessionId,
      total: invoice.totalAmount.toString(),
    });

    const tendered = input.amountTendered ?? Number(invoice.totalAmount);

    let receiptText: string | undefined;
    let receiptHtml: string | undefined;
    try {
      receiptText = await this.receipts.buildTextReceipt(invoice.id);
      receiptHtml = await this.receipts.buildHtmlReceipt(invoice.id);
    } catch { /* non-fatal */ }

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentIds: (pay?.paymentIds as string[]) ?? [],
      total: Number(invoice.totalAmount),
      // Nothing was handed over on a credit sale, so there is nothing to give back.
      change: isCredit ? 0 : (pay?.change ?? Math.max(0, tendered - Number(invoice.totalAmount))),
      settleMode: isCredit ? ('credit' as const) : ('tender' as const),
      /** Outstanding balance left on the customer's account (0 unless credit). */
      amountDue: isCredit ? Number(invoice.totalAmount) : 0,
      tableStatus,
      receiptId: pay?.receiptId,
      receiptText,
      receiptHtml,
    };
  }

  /**
   * A credit sale must be owed by somebody. The walk-in partner is a placeholder
   * for anonymous cash customers — booking AR against it would create a debt no
   * one can be billed for, so it is rejected alongside a missing customer.
   *
   * This is a pre-flight check that runs BEFORE the invoice is generated, so the
   * cashier gets a clean rejection and can switch to cash instead of leaving a
   * billed-then-refunded invoice behind. The authoritative, race-safe limit test
   * still runs inside settleCredit (assertCreditAllowed) under a row lock; only
   * the conditions knowable without the invoice total are checked here.
   */
  private async assertCreditCustomer(partnerId?: string | null): Promise<void> {
    if (!partnerId) throw new BadRequestException('Select a customer to charge on account');
    const orgId = this.tenant.organizationId;
    const partner = await this.prisma.client.partner.findFirst({
      where: { id: partnerId, organizationId: orgId },
      select: { code: true },
    });
    if (!partner) throw new BadRequestException('Customer not found');
    if (partner.code === 'WALKIN') {
      throw new BadRequestException('The walk-in customer cannot buy on account — select a named customer');
    }
    const status = await resolveCreditStatus(this.prisma.client, orgId, partnerId);
    if (status.creditHold) {
      throw new BadRequestException('This customer is on credit hold — new credit sales are blocked');
    }
    if (status.creditLimit > 0 && status.outstanding >= status.creditLimit - 0.01) {
      throw new BadRequestException(
        `Credit limit reached: outstanding ${status.outstanding} of limit ${status.creditLimit}`,
      );
    }
  }

  /**
   * Barcode / SKU lookup for the terminal.
   *
   * Audit F-07 — the café terminal used to resolve a scan against the MenuItems
   * it happened to have loaded, so anything outside the current page or category
   * simply did not scan, and an unknown code produced no feedback at all. This
   * is the server-authoritative answer both terminals now use, and it searches
   * the MENU as well as the product catalogue: a café sells menu items, and a
   * menu item carries its own punch-in code.
   *
   * Menu matches lead — a MenuItem and a Product routinely share a code, and on
   * a café till the menu item is what was meant.
   */
  async findBySku(sku: string) {
    const orgId = this.tenant.organizationId;
    const [menuItems, products] = await Promise.all([
      this.prisma.client.menuItem.findMany({
        where: { organizationId: orgId, isAvailable: true, code: { equals: sku, mode: 'insensitive' } },
        take: 5,
      }),
      this.prisma.client.product.findMany({
        where: {
          organizationId: orgId,
          isActive: true,
          OR: [
            { sku: { equals: sku, mode: 'insensitive' } },
            { code: { equals: sku, mode: 'insensitive' } },
            { barcode: { equals: sku, mode: 'insensitive' } },
          ],
        },
        include: { stockItems: true },
        take: 5,
      }),
    ]);
    // One shape for the terminal: `kind` says which catalogue answered, and
    // `salesPrice` is the sellable price whichever it was.
    return [
      ...(menuItems as any[]).map((m) => ({
        ...m, kind: 'menu_item' as const, menuItemId: m.id,
        sku: m.code ?? null, salesPrice: m.basePrice,
      })),
      ...(products as any[]).map((p) => ({ ...p, kind: 'product' as const })),
    ].slice(0, 5);
  }

  async listForCashSession(cashSessionId: string) {
    const orgId = this.tenant.organizationId;
    return this.prisma.client.invoice.findMany({
      where: { organizationId: orgId, cashSessionId },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
  }

  // ─── helpers ─────────────────────────────────────────────────────────────


  /** True when the sale collects physical cash (cash or mobile money) and must
   *  therefore be attributed to an open drawer session for reconciliation. */
  private saleNeedsCashDrawer(input: { tenders?: PaymentTender[]; paymentMethod?: string }): boolean {
    const methods = input.tenders?.length
      ? input.tenders.map((t) => t.method)
      : [input.paymentMethod ?? 'cash']; // default tender is cash
    return methods.some((m) => m === 'cash');
  }

  /**
   * H1 / F17 — resolve the cash session a sale posts against and enforce the
   * drawer gate. Every POS sale needs an explicitly selected open register, and
   * by default that register must be the caller's own: money lands only in the
   * drawer of the cashier accountable for counting it. A drawer left open by
   * someone else is handed over (POST /pos/shift/handover), which closes it
   * against a blind count and opens a fresh session for the new cashier.
   *
   * A site that genuinely runs one till for several servers sets the POS module
   * config flag `sharedDrawer: true`. That is a deliberate, org-level decision
   * to accept a drawer no single person can be held to at close — it is not the
   * default, and it never re-enables picking a session the caller did not name.
   */
  private async requireCashSession(input: {
    cashSessionId?: string;
    tenders?: PaymentTender[];
    paymentMethod?: string;
    settleMode?: SettleMode;
  }): Promise<string | undefined> {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId ?? undefined;

    if (input.cashSessionId) {
      const session = await this.prisma.client.cashSession.findFirst({
        where: { id: input.cashSessionId, organizationId: orgId },
        include: { cashRegister: { select: { isActive: true, deletedAt: true } } },
      });
      if (!session || session.status !== 'open') throw new BadRequestException('The original register session is not open. Resolve the pending sale before selecting another session.');
      if (!session.cashRegister?.isActive || session.cashRegister.deletedAt) throw new BadRequestException('This register is no longer active. Close its session and select another register.');
      if (!userId || session.userId !== userId) {
        const shared = (await this.getPosSettings()).sharedDrawer === true;
        if (!shared) throw new BadRequestException('This register is open under another cashier. Complete a shift handover before selling on it, or enable the shared-drawer setting.');
      }
      return session.id;
    }
    throw new BadRequestException('Select an open register before completing any POS sale');
  }

  /**
   * Compute the maximum discount percentage in the cart (line + transaction) and
   * require a manager override if it exceeds the configured threshold.
   */
  private async assertDiscountAuthority(input: CheckoutInput): Promise<number> {
    const quote = await this.orders.quote(input as any);
    return assertPricingAuthority(this, quote.baseLines, input);
  }

  /** Derive the invoice's payment mode from a multi-tender array. */
  private resolvePaymentMode(tenders: PaymentTender[]): 'cash' | 'card' | 'mobile_money' | 'mixed' | 'credit' {
    const methods = new Set(tenders.map((t) => t.method));
    if (methods.size === 1) {
      const m = methods.values().next().value;
      if (m === 'cash') return 'cash' as const;
      if (m === 'card') return 'card' as const;
      if (m === 'mobile_money') return 'mobile_money' as const;
      if (m === 'bank') return 'card' as const;
      if (m === 'store_credit') return 'mixed' as const;
    }
    return 'mixed' as const;
  }

  private async resolveSkus(lines: CheckoutLine[]): Promise<Map<string, string>> {
    const skus = Array.from(new Set(lines.filter((l) => !l.productId && l.sku).map((l) => l.sku!.toLowerCase())));
    if (skus.length === 0) return new Map();
    const products = await this.prisma.client.product.findMany({
      where: {
        organizationId: this.tenant.organizationId,
        isActive: true,
        OR: [
          { sku: { in: skus, mode: 'insensitive' } },
          { code: { in: skus, mode: 'insensitive' } },
        ],
      },
      select: { id: true, sku: true, code: true },
    });
    const map = new Map<string, string>();
    for (const p of products) {
      if (p.sku) map.set(p.sku.toLowerCase(), p.id);
      if (p.code) map.set(p.code.toLowerCase(), p.id);
    }
    return map;
  }

  private async ensureWalkInCustomer(orgId: string): Promise<string> {
    const existing = await this.prisma.client.partner.findFirst({ where: { organizationId: orgId, code: 'WALKIN' } });
    if (existing) return existing.id;
    const created = await this.prisma.client.partner.create({
      data: {
        organizationId: orgId,
        code: 'WALKIN',
        name: 'Walk-in Customer',
        isCustomer: true,
        isCompany: false,
      },
    });
    return created.id;
  }

  /**
   * Return the POS module config (posMode, sharedDrawer, …) PLUS the pricing
   * policy the terminal has to obey.
   *
   * Audit F-03 — the terminal used to carry its own hardcoded discount
   * threshold (10% / 50,000), which silently disagreed with the org's
   * configured `settings.discountApproval.tier1`: lower the org value and
   * cashiers applied discounts unprompted, then hit a 403 at the payment
   * screen. There is one threshold now, and this is where the terminal reads it.
   */
  async getPosSettings(): Promise<Record<string, unknown>> {
    const orgId = this.tenant.organizationId;
    const [mod, org] = await Promise.all([
      this.prisma.client.organizationModule.findUnique({
        where: { organizationId_moduleName: { organizationId: orgId, moduleName: 'pos' } },
      }),
      this.prisma.raw.organization.findUnique({ where: { id: orgId }, select: { settings: true } }),
    ]);
    const config = (mod?.config as Record<string, unknown>) ?? { posMode: 'cafe' };
    return {
      ...config,
      discountApproval: {
        tier1: resolveDiscountThreshold((org?.settings as any)?.discountApproval?.tier1),
      },
    };
  }

  /** Update POS module config (posMode, sharedDrawer, etc). */
  async updatePosSettings(dto: { posMode?: string; sharedDrawer?: boolean }): Promise<Record<string, unknown>> {
    const existing = await this.prisma.client.organizationModule.findUnique({
      where: { organizationId_moduleName: { organizationId: this.tenant.organizationId, moduleName: 'pos' } },
    });
    const config = { ...((existing?.config as Record<string, unknown>) ?? {}), ...dto };
    await this.prisma.client.organizationModule.upsert({
      where: { organizationId_moduleName: { organizationId: this.tenant.organizationId, moduleName: 'pos' } },
      update: { config: config as any },
      create: { organizationId: this.tenant.organizationId, moduleName: 'pos', isActive: true, config: config as any },
    });
    // Sync the posMode as a Setting so offline devices see it via sync pull.
    if (dto.posMode) {
      await this.prisma.client.setting.upsert({
        where: {
          organizationId_scopeType_scopeId_key: {
            organizationId: this.tenant.organizationId,
            scopeType: 'organization',
            scopeId: '',
            key: 'pos.mode',
          },
        },
        update: { value: dto.posMode },
        create: {
          organizationId: this.tenant.organizationId,
          scope: 'organization',
          scopeType: 'organization',
          scopeId: '',
          key: 'pos.mode',
          value: dto.posMode,
        },
      });
    }
    return config;
  }
}
