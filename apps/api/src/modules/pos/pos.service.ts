/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { EventBus } from '../../kernel/events/event-bus';
import { DocumentBuilderService } from '../invoicing/document/document-builder.service';
import { InvoiceService } from '../invoicing/invoice/invoice.service';
import { PaymentService } from '../invoicing/payment/payment.service';
import { CreditNoteService } from '../invoicing/credit-note/credit-note.service';
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
import { EVENTS } from '@erp/shared';
import { NotificationsService } from '../../kernel/notifications/notifications.service';
import { PosTablesService } from './pos-tables.service';
import { PosOrdersService } from './order/pos-orders.service';
import { PosInvoiceService } from './billing/pos-invoice.service';
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
}

export interface PaymentTender {
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
  /** P2: manager override required when discount > 10% (see DEFAULT_MAX_DISCOUNT_WITHOUT_OVERRIDE). */
  overrideById?: string;
  /** P2: order-level discount (%). Applied AFTER line discounts. */
  transactionDiscountPercent?: number;
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
}

const DEFAULT_MAX_DISCOUNT_WITHOUT_OVERRIDE = 10; // %

@Injectable()
export class PosService {
  private readonly logger = new Logger('PosService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly builder: DocumentBuilderService,
    private readonly invoices: InvoiceService,
    private readonly payments: PaymentService,
    private readonly creditNotes: CreditNoteService,
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
  ) {}

  /**
   * Counter sale — the canonical Order → Invoice → Receipt pipeline. Creates an
   * Order from the cart, fires the kitchen, generates the Invoice (which posts
   * its own GL + deducts stock), then takes payment (which writes the Receipt +
   * ReceiptItems and closes the order). Every counter sale now persists into the
   * Order/Invoice/InvoiceItem/Receipt/ReceiptItem tables — NOT Document.
   */
  async checkout(input: CheckoutInput) {
    if (!input.lines?.length) throw new BadRequestException('Cart is empty');
    const orgId = this.tenant.organizationId;

    // H1 — a sale that collects physical cash MUST post against an open drawer
    // session owned by the caller, otherwise the GL cash leg diverges from the
    // till (no CashMovement is written). Resolve/validate it before anything.
    const cashSessionId = await this.requireCashSession(input);
    input = { ...input, cashSessionId };

    // Manager-override guard for high discounts (validates line + tx discount).
    const effectiveDiscount = await this.assertDiscountAuthority(input);

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
    //    deducts inventory at bill time. Roll the order back on failure.
    let invoice: any;
    try {
      invoice = await this.billing.generateInvoice(order.id, {
        transactionDiscountPercent: input.transactionDiscountPercent,
        branchId: input.branchId,
        paymentMode: input.tenders?.length
          ? this.resolvePaymentMode(input.tenders)
          : input.paymentMethod === 'bank' ? 'cash' : (input.paymentMethod ?? 'cash'),
      });
    } catch (e) {
      await this.orders.cancelOrder(order.id, 'checkout: invoice generation failed').catch(() => undefined);
      throw e;
    }

    // 4) Take payment + settle: writes Payment + allocation, the Receipt +
    //    ReceiptItems, marks the invoice settled and closes the order. On
    //    failure, refund (reverse GL + restock) so the books stay clean.
    let pay: any;
    try {
      pay = await this.billing.receivePayment(invoice.id, {
        tenders: input.tenders,
        paymentMethod: input.paymentMethod,
        amountTendered: input.amountTendered,
        cashSessionId: input.cashSessionId,
      });
    } catch (e) {
      await this.billing.refund(invoice.id, 'checkout: payment failed').catch(() => undefined);
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
      change: pay?.change ?? Math.max(0, tendered - Number(invoice.totalAmount)),
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
    const warehouse = await this.prisma.client.inventoryLocation.findFirst({
      where: { organizationId: orgId, type: 'warehouse', isActive: true },
    });
    if (!warehouse) return 0;
    const item = await this.prisma.client.stockItem.findFirst({
      where: { organizationId: orgId, productId, locationId: warehouse.id },
    });
    return Number(item?.quantity ?? 0);
  }

  /**
   * Refund a sale: posts a credit note (reverses revenue + tax), restocks the
   * refunded goods, and pays the customer back via the ORIGINAL tender method
   * (Dr Receivable, Cr Cash). Supports partial refunds via `lines`.
   *
   * Guards (H2): refuses once the sale is already fully reversed, and refuses a
   * refund that would exceed the remaining refundable amount.
   */
  async refund(input: {
    invoiceId: string;
    reason?: string;
    cashSessionId?: string;
    overrideById?: string;
    /** Partial refund: subset of the original lines + quantities. Omit for a full refund. */
    lines?: Array<{ lineId: string; quantity: number }>;
  }) {
    const orgId = this.tenant.organizationId;
    const original = await this.prisma.client.document.findFirst({
      where: { id: input.invoiceId, organizationId: orgId, documentType: 'sales_invoice' },
      include: { lines: true },
    });
    if (!original) throw new NotFoundException('Original invoice not found');
    if (input.overrideById) {
      // Refunds beyond a cashier's authority need a manager sign-off.
      await this.overrides.assertCanOverride(input.overrideById, 'manual_refund');
    }

    // H2 — guard against double / over-refund. Sum prior (non-cancelled) credit
    // notes raised against this invoice; refuse once the sale is fully reversed.
    const priorCreditNotes = await this.prisma.client.document.findMany({
      where: {
        organizationId: orgId,
        documentType: 'credit_note',
        reversedDocumentId: original.id,
        status: { not: 'cancelled' },
      },
      select: { totalAmount: true },
    });
    const alreadyRefunded = priorCreditNotes.reduce((s, c) => s + Number(c.totalAmount), 0);
    const originalTotal = Number((original as any).totalAmount);
    if (alreadyRefunded >= originalTotal - 0.01) {
      throw new ConflictException('This sale has already been fully refunded');
    }

    // Resolve the lines to reverse — a subset for a partial refund, else all.
    const selections = input.lines?.length
      ? input.lines.map((sel) => {
          const src = original.lines.find((l: any) => l.id === sel.lineId);
          if (!src) throw new BadRequestException(`Line ${sel.lineId} is not on the original invoice`);
          const q = Number(sel.quantity);
          if (!(q > 0) || q > Number(src.quantity)) {
            throw new BadRequestException(`Invalid refund quantity for line ${sel.lineId}`);
          }
          return { src, quantity: q };
        })
      : original.lines.map((src: any) => ({ src, quantity: Number(src.quantity) }));

    const warehouse = await this.prisma.client.inventoryLocation.findFirst({
      where: { organizationId: orgId, type: 'warehouse', isActive: true },
    });

    // 1) Build the credit note from the refunded lines.
    const creditNote = await this.builder.createDocument(
      this.prisma.client,
      'credit_note',
      {
        partnerId: original.partnerId,
        branchId: original.branchId ?? undefined,
        reference: `Refund of ${(original as any).documentNumber}`,
        notes: input.reason,
        issueDate: new Date().toISOString(),
        reversedDocumentId: original.id,
      } as any,
      selections.map(({ src, quantity }) => ({
        productId: src.productId,
        description: src.description,
        quantity,
        unitPrice: src.unitPrice,
        taxId: src.taxId,
        discountPercent: src.discountPercent,
        // P10: pass the taxInclusive flag from the original line through.
        taxInclusive: (src as any).taxInclusive,
      })),
    );

    const refundAmount = Number((creditNote as any).totalAmount);
    if (alreadyRefunded + refundAmount > originalTotal + 0.01) {
      // Discard the draft credit note we just built — it would over-refund.
      await this.prisma.client.document
        .update({ where: { id: creditNote.id }, data: { status: 'cancelled', notes: 'Voided: exceeds refundable amount' } })
        .catch(() => undefined);
      throw new BadRequestException('Refund exceeds the remaining refundable amount');
    }

    // 2) Post the credit note → Dr Revenue + Tax, Cr Receivable (reverses the sale).
    await this.creditNotes.post(creditNote.id);

    // 3) Restock the refunded quantities.
    if (warehouse) {
      for (const { src, quantity } of selections) {
        if (!src.productId) continue;
        try {
          await this.stock.receive({
            productId: src.productId,
            locationId: warehouse.id,
            quantity,
            reference: `Refund of ${(original as any).documentNumber}`,
          } as any);
        } catch (e: any) { this.logger.warn(`Stock restock failed: ${e?.message}`); }
      }
    }

    // 4) Pay the customer back via the original sale's tender method. Posts
    //    Dr Receivable, Cr Cash — settling the credit note's receivable credit.
    const refundMethod = await this.resolveOriginalTenderMethod(original.id);
    const payment = await this.payments.createCustomerRefund({
      partnerId: original.partnerId,
      paymentDate: new Date().toISOString(),
      paymentMethod: refundMethod,
      amount: refundAmount,
      reference: `Refund of ${(original as any).documentNumber}`,
      cashSessionId: input.cashSessionId,
    } as any);

    await this.audit.record({
      entity: 'Document',
      entityId: original.id,
      action: 'update' as any,
      newValues: {
        kind: 'pos_refund',
        creditNoteId: creditNote.id,
        amount: refundAmount,
        method: refundMethod,
        partial: !!input.lines?.length,
      },
    });

    return { creditNoteId: creditNote.id, paymentId: (payment as any)?.id ?? null, amount: refundAmount, method: refundMethod };
  }

  /**
   * Find the tender method used to settle the original sale so a refund is
   * returned the same way it was paid. Falls back to cash when the original
   * payment can't be resolved (e.g. an unpaid invoice being voided).
   */
  private async resolveOriginalTenderMethod(
    invoiceId: string,
  ): Promise<'cash' | 'bank' | 'card' | 'mobile_money'> {
    const allocations = await this.prisma.client.paymentAllocation.findMany({
      where: { documentId: invoiceId },
      include: { payment: { select: { paymentMethod: true } } },
    });
    const methods = allocations
      .map((a) => (a as any).payment?.paymentMethod)
      .filter((m): m is string => !!m);
    // Prefer cash when the sale was split across tenders — refunding cash keeps
    // the drawer reconcilable. Otherwise return the single method used.
    if (methods.includes('cash')) return 'cash';
    const m = methods[0];
    if (m === 'bank' || m === 'card' || m === 'mobile_money') return m;
    return 'cash';
  }

  /**
   * Void a sale = full refund. Distinct from refund() because the cashier
   * typically voids within minutes of the sale; we still want the override
   * gate above the discount threshold to apply (refund > 50% of shift
   * total triggers an override prompt on the UI).
   */
  async voidSale(input: { invoiceId: string; reason: string; overrideById: string }) {
    if (!input.reason?.trim()) throw new BadRequestException('Reason is required for a void');
    if (!input.overrideById) {
      throw new BadRequestException('Voiding a sale requires a manager override');
    }
    await this.overrides.assertCanOverride(input.overrideById, 'void');
    const result = await this.refund({
      invoiceId: input.invoiceId,
      reason: `VOID: ${input.reason}`,
      overrideById: input.overrideById,
    });
    await this.audit.record({
      entity: 'Document',
      entityId: input.invoiceId,
      action: 'cancel' as any,
      newValues: { kind: 'pos_void', reason: input.reason, overrideById: input.overrideById },
    });
    this.events.publish(EVENTS.PosVoidCompleted, {
      organizationId: this.tenant.organizationId,
      invoiceId: input.invoiceId,
      voidedById: input.overrideById,
      reason: input.reason,
    });
    return result;
  }

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

    return {
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      // Optimistic-lock token — the terminal echoes it back on save so a stale
      // full-replace from another device is rejected (H2) instead of clobbering.
      version: o.version ?? 0,
      subtotal: String(o.subtotal ?? 0),
      discountTotal: String(o.discountTotal ?? 0),
      taxAmount: String(o.taxAmount ?? 0),
      totalAmount: String(o.totalAmount ?? 0),
      guestCount: o.guestCount ?? null,
      partnerId: o.partnerId ?? null,
      lines: items.map((it: any) => {
        const qty = Number(it.quantity);
        const unit = Number(it.unitPrice);
        const disc = Number(it.discountPercent ?? 0);
        const total = qty * unit * (1 - disc / 100);
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
    lines: CheckoutLine[];
    partnerId?: string;
    guestCount?: number;
    sendToKitchen?: boolean;
    overrideById?: string;
    transactionDiscountPercent?: number;
  }) {
    if (!input.lines?.length) throw new BadRequestException('No items to add');
    // Line discounts on a tab still need manager authority above the threshold.
    await this.assertDiscountAuthority({
      lines: input.lines,
      transactionDiscountPercent: input.transactionDiscountPercent,
      overrideById: input.overrideById,
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
        transactionDiscountPercent: input.transactionDiscountPercent,
      } as any);
    } else {
      order = await this.orders.createOrder({
        orderType: 'dine_in',
        tableId: input.tableId,
        partnerId: input.partnerId,
        guestCount: input.guestCount,
        overrideById: input.overrideById,
        lines,
      } as CreateOrderDto);
      await this.linkTableOrder(input.tableId, order.id, input.guestCount);
      if (input.sendToKitchen) {
        await this.orders.fireKitchen(order.id).catch((e: any) => this.logger.warn(`fireKitchen failed: ${e?.message}`));
      }
    }
    return this.toTabView(order);
  }

  /**
   * Replace the table's open draft order with EXACTLY these lines (auto-save).
   * Source-of-truth write for the "one open order per table" model: the cart on
   * screen always equals the table's draft order. Creates the order on the first
   * save; when the line set becomes empty the draft is cancelled and the table is
   * freed. No GL / stock / cash / kitchen effect — that all happens at settle.
   */
  async saveTabItems(input: {
    tableId: string;
    lines: CheckoutLine[];
    partnerId?: string;
    guestCount?: number;
    /** H2 — the version the terminal last read; a mismatch means another device
     *  edited this tab first and this stale full-replace is rejected (409). */
    expectedVersion?: number;
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
    if (lines.length === 0) {
      if (existing) {
        await this.orders.cancelOrder(existing.id, 'Order emptied');
        await this.closeTableLink(input.tableId, existing.id);
      }
      return null;
    }

    let order: any;
    if (existing) {
      order = await this.orders.saveItems(existing.id, {
        lines,
        guestCount: input.guestCount,
        partnerId: input.partnerId,
        expectedVersion: input.expectedVersion,
      } as any);
    } else {
      order = await this.orders.createOrder({
        orderType: 'dine_in',
        tableId: input.tableId,
        partnerId: input.partnerId,
        guestCount: input.guestCount,
        lines,
      } as CreateOrderDto);
      await this.linkTableOrder(input.tableId, order.id, input.guestCount);
    }
    return this.toTabView(order);
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
   * compensation-guarded sale path as a counter checkout.
   */
  async settleTab(input: {
    tableId: string;
    tenders?: PaymentTender[];
    paymentMethod?: 'cash' | 'bank' | 'card' | 'mobile_money';
    amountTendered?: number;
    transactionDiscountPercent?: number;
    cashSessionId?: string;
  }) {
    const orgId = this.tenant.organizationId;

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
    const order = await this.orders.getOpenOrderForTable(input.tableId);
    if (!order) throw new BadRequestException('No open tab to settle on this table');
    if (!order.items?.length) throw new BadRequestException('The tab is empty');

    // A split in progress owns settlement of this tab — settling the whole tab
    // here would double-charge items already assigned to (and paid on) bills.
    const activeSplit = await this.prisma.client.splitBill.count({ where: { sourceOrderId: order.id, status: { not: 'void' } } });
    if (activeSplit > 0) {
      throw new BadRequestException('This table has a split in progress — settle each split bill instead.');
    }

    // Generate the Invoice (own GL + stock at bill time) then take payment
    // (writes the Receipt + ReceiptItems and closes the order).
    let invoice: any;
    try {
      invoice = await this.billing.generateInvoice(order.id, { transactionDiscountPercent: input.transactionDiscountPercent });
    } catch (e: any) {
      this.logger.error(`[settle] invoice generation failed for table ${input.tableId} / order ${order.id}: ${e?.message ?? e}`);
      await this.orders.cancelOrder(order.id, 'settle: invoice generation failed').catch(() => undefined);
      throw e;
    }
    let pay: any;
    try {
      pay = await this.billing.receivePayment(invoice.id, {
        tenders: input.tenders,
        paymentMethod: input.paymentMethod,
        amountTendered: input.amountTendered,
        cashSessionId: input.cashSessionId,
      });
    } catch (e: any) {
      this.logger.error(`[settle] payment failed for invoice ${invoice.invoiceNumber} (${invoice.id}): ${e?.message ?? e}`);
      await this.billing.refund(invoice.id, 'settle: payment failed').catch(() => undefined);
      throw e;
    }

    // Close the tab: retire the table↔order link so the table frees. The Order
    // itself is closed by billing.receivePayment (closeOrderForInvoice).
    let tableStatus: string | undefined;
    try {
      const closeResult = await this.tables.closeTableOrder({ tableId: input.tableId, orderId: order.id });
      tableStatus = (closeResult as any)?.tableStatus;
    } catch (e: any) { this.logger.warn(`Close table failed: ${e?.message}`); }

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
      paymentIds: (pay?.paymentIds as string[]) ?? [],
      total: Number(invoice.totalAmount),
      change: pay?.change ?? Math.max(0, tendered - Number(invoice.totalAmount)),
      tableStatus,
      receiptId: pay?.receiptId,
      receiptText,
      receiptHtml,
    };
  }

  async findBySku(sku: string) {
    const orgId = this.tenant.organizationId;
    return this.prisma.client.product.findMany({
      where: {
        organizationId: orgId,
        isActive: true,
        OR: [{ sku: { equals: sku, mode: 'insensitive' } }, { code: { equals: sku, mode: 'insensitive' } }],
      },
      include: { stockItems: true },
      take: 5,
    });
  }

  async listForCashSession(cashSessionId: string) {
    const orgId = this.tenant.organizationId;
    // M1 — scope the list to the session that was actually asked for. POS sales
    // are attributed to a session by their creation time falling inside the
    // session's open window (Payment carries no session column; only cash
    // movements do, which would miss card / mobile-money sales).
    const session = await this.prisma.client.cashSession.findFirst({
      where: { id: cashSessionId, organizationId: orgId },
    });
    if (!session) return [];
    return this.prisma.client.document.findMany({
      where: {
        organizationId: orgId,
        documentType: 'sales_invoice',
        sourceType: 'pos',
        createdAt: {
          gte: session.openedAt,
          ...(session.closedAt ? { lte: session.closedAt } : {}),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { partner: true },
    });
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  /**
   * Resolve cart lines into ledger-ready lines: map sku → productId, fold modifier
   * priceDeltas into unitPrice (so the receipt + GL stay authoritative), and
   * expand combos into component lines (first component carries the combo price).
   * Shared by checkout (counter sale) and the open-tab flow.
   */
  private async expandCheckoutLines(inputLines: CheckoutLine[]) {
    const skuMap = await this.resolveSkus(inputLines);
    const lines: Array<{
      productId: string | null;
      menuItemId: string | null;
      description: string;
      quantity: number;
      unitPrice: number;
      taxId: string | null;
      discountPercent: number;
      note: string | null;
      modifiers: CheckoutLineModifier[] | undefined;
      comboId: string | undefined;
      comboPrice: number | undefined;
      taxInclusive: boolean | undefined;
      variantName?: string;
      accompanimentNames?: string[];
    }> = [];

    for (const l of inputLines) {
      // SECURITY: re-resolve modifier prices from the DB (reject unknown ids)
      // instead of trusting the client priceDelta — same hole the counter path
      // closes in PosOrdersService.resolveLines.
      const resolvedMods = l.modifiers?.length
        ? await this.modifiers.resolveSelectedModifiers({
            menuItemId: l.menuItemId, productId: l.productId, modifierIds: l.modifiers.map((m) => m.modifierId),
          })
        : [];
      const modifierDelta = resolvedMods.reduce((s, m) => s + m.priceDelta, 0);

      // Resolve variant price (variant price REPLACES basePrice).
      let variantName: string | undefined;
      let variantPrice = 0;
      let hasVariant = false;
      if (l.variantId && l.menuItemId) {
        const v = await this.variants.validateVariant(l.menuItemId, l.variantId);
        variantName = v.name;
        variantPrice = v.price;
        hasVariant = true;
      }

      // Resolve accompaniment price impact (stacks on top). Resolution only —
      // min-select is not enforced here (owner rule: a sale must never be
      // blocked; tab saves already gate rules at entry with the override state,
      // and settle must not 400 on lines that were legitimately saved).
      let accompanimentImpact = 0;
      let accompanimentNames: string[] = [];
      if (l.menuItemId) {
        const result = await this.accompaniments.validateSelections(l.menuItemId, l.accompanimentOptionIds ?? [], true);
        accompanimentImpact = result.priceImpact;
        accompanimentNames = result.names;
      }

      // unitPrice = variantPrice (if variant) OR original unitPrice, + accompaniment impact + modifier deltas
      const baseUnitPrice = hasVariant ? variantPrice : l.unitPrice;
      const finalUnitPrice = baseUnitPrice + accompanimentImpact + modifierDelta;

      // Build note with accompaniments + modifiers appended.
      const noteParts: string[] = [];
      if (l.note) noteParts.push(l.note);
      if (accompanimentNames.length > 0) {
        noteParts.push(...accompanimentNames.map((n) => `+ ${n}`));
      }
      if (resolvedMods.length > 0) {
        noteParts.push(...resolvedMods.map((m) => `+ ${m.name}`));
      }

      lines.push({
        productId: l.productId ?? skuMap.get(l.sku?.toLowerCase() ?? '') ?? null,
        menuItemId: l.menuItemId ?? null,
        description: l.description,
        quantity: l.quantity,
        unitPrice: finalUnitPrice,
        taxId: l.taxId ?? null,
        discountPercent: l.discountPercent ?? 0,
        note: noteParts.length > 0 ? noteParts.join(' | ') : null,
        modifiers: resolvedMods,
        comboId: l.comboId,
        comboPrice: undefined,
        taxInclusive: l.taxInclusive,
        variantName,
        accompanimentNames: accompanimentNames.length > 0 ? accompanimentNames : undefined,
      });
    }

    const expanded: typeof lines = [];
    for (const ln of lines) {
      if (!ln.comboId) { expanded.push(ln); continue; }
      const comps = await this.modifiers.expandCombosForCheckout([{ comboId: ln.comboId, quantity: ln.quantity }]);
      comps.forEach((c, i) => {
        expanded.push({
          ...ln,
          productId: c.productId,
          comboId: undefined,
          comboPrice: c.comboPrice,
          unitPrice: i === 0 ? Number(c.comboPrice ?? ln.unitPrice) : 0,
        });
      });
    }
    return expanded;
  }

  /** True when the sale collects physical cash (cash or mobile money) and must
   *  therefore be attributed to an open drawer session for reconciliation. */
  private saleNeedsCashDrawer(input: { tenders?: PaymentTender[]; paymentMethod?: string }): boolean {
    const methods = input.tenders?.length
      ? input.tenders.map((t) => t.method)
      : [input.paymentMethod ?? 'cash']; // default tender is cash
    return methods.some((m) => m === 'cash' || m === 'mobile_money');
  }

  /**
   * H1 — resolve the cash session a sale posts against and enforce the drawer
   * gate. A cash/mobile-money sale REQUIRES an open session owned by the caller;
   * a card/bank-only sale may proceed without one. A supplied session id is
   * validated to exist, be open, and belong to the caller.
   */
  private async requireCashSession(input: {
    cashSessionId?: string;
    tenders?: PaymentTender[];
    paymentMethod?: string;
  }): Promise<string | undefined> {
    const orgId = this.tenant.organizationId;
    const userId = this.tenant.userId ?? undefined;

    if (input.cashSessionId) {
      const s = await this.prisma.client.cashSession.findFirst({
        where: { id: input.cashSessionId, organizationId: orgId },
      });
      if (!s) throw new BadRequestException('Cash session not found');
      if (s.status !== 'open') throw new BadRequestException('Cash session is not open — open a shift first');
      if (userId && s.userId !== userId) {
        throw new ForbiddenException('That cash session belongs to a different cashier');
      }
      return s.id;
    }

    // No session supplied: only cash/mobile-money sales must be gated.
    if (!this.saleNeedsCashDrawer(input)) return undefined;

    const open = userId
      ? await this.prisma.client.cashSession.findFirst({ where: { organizationId: orgId, userId, status: 'open' } })
      : null;
    if (!open) {
      throw new BadRequestException(
        'No open cash session — open a shift before taking a cash or mobile-money payment',
      );
    }
    return open.id;
  }

  /**
   * Compute the maximum discount percentage in the cart (line + transaction) and
   * require a manager override if it exceeds the configured threshold.
   */
  private async assertDiscountAuthority(input: CheckoutInput): Promise<number> {
    const lineMax = input.lines.reduce((m, l) => Math.max(m, l.discountPercent ?? 0), 0);
    const tx = input.transactionDiscountPercent ?? 0;
    const effective = Math.max(lineMax, tx);
    if (effective <= DEFAULT_MAX_DISCOUNT_WITHOUT_OVERRIDE) return effective;
    if (!input.overrideById) {
      throw new BadRequestException(
        `Discount ${effective}% exceeds ${DEFAULT_MAX_DISCOUNT_WITHOUT_OVERRIDE}% — manager override required`,
      );
    }
    await this.overrides.assertCanOverride(input.overrideById, 'discount');
    return effective;
  }

  /** Derive the invoice's payment mode from a multi-tender array. */
  private resolvePaymentMode(tenders: PaymentTender[]): 'cash' | 'card' | 'mobile_money' | 'mixed' | 'credit' {
    const methods = new Set(tenders.map((t) => t.method));
    if (methods.size === 1) {
      const m = methods.values().next().value;
      if (m === 'cash') return 'cash' as const;
      if (m === 'card') return 'card' as const;
      if (m === 'mobile_money') return 'mobile_money' as const;
      if (m === 'bank') return 'cash' as const;
      if (m === 'store_credit') return 'credit' as const;
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
}