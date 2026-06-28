/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

    // Manager-override guard for high discounts (validates line + tx discount).
    const effectiveDiscount = await this.assertDiscountAuthority(input);

    // 1) Operational Order from the cart. resolveLines folds variants /
    //    accompaniments / modifiers and expands combos, and validates rules.
    const order = await this.orders.createOrder({
      orderType: input.tableId ? 'dine_in' : 'takeaway',
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
   * Post the invoice, issue stock for each stockable line, and record the
   * tender payments — with compensation. If any step throws, payments already
   * taken are voided, issued stock is returned, and the invoice is cancelled
   * (which reverses its GL), so a failed checkout is a no-op on the books.
   *
   * NOTE: true single-transaction atomicity would require the invoice / stock /
   * payment core services to accept an external `tx`; they each own their own
   * transaction today, so consistency is guaranteed via compensation instead.
   */
  private async executeSaleEffects(args: {
    doc: any;
    expanded: any[];
    warehouse: any;
    tenders: PaymentTender[];
    partnerId: string;
    cashSessionId?: string;
    reference?: string;
  }): Promise<{
    paymentIds: string[];
  }> {
    const { doc, expanded, warehouse, tenders, partnerId, cashSessionId, reference } = args;
    const orgId = this.tenant.organizationId;
    const issuedLines: Array<{ productId: string; locationId: string; quantity: number }> = [];
    const paymentIds: string[] = [];
    // Track store credit drawn down so a failed sale can re-issue it (saga unwind).
    let redeemedCredit = 0;

    try {
      // Store-credit pre-flight: validate the balance + resolve the liability
      // account BEFORE any GL effect so an insufficient balance fails cleanly.
      const creditTotal = tenders
        .filter((t) => t.method === 'store_credit')
        .reduce((s, t) => s + Number(t.amount), 0);
      let storeCreditAccount: string | undefined;
      if (creditTotal > 0) {
        const { balance } = await this.loyalty.getCredit(partnerId);
        if (balance < creditTotal - 0.01) {
          throw new BadRequestException(`Insufficient store credit: balance ${balance}, needed ${creditTotal}`);
        }
        storeCreditAccount = await this.storeCreditAccountId();
      }

      await this.invoices.post(doc.id);

      // Stock-out for every stockable line — unconditional reduction (allows negative stock).
      for (const ln of expanded) {
        if (!warehouse) continue;
        // MENU: a menu-item line decrements its recipe ingredients, not a product.
        if (ln.menuItemId) {
          await this.issueMenuItemRecipe(ln.menuItemId, Number(ln.quantity), warehouse.id, `POS sale ${doc.documentNumber}`, issuedLines);
          continue;
        }
        if (!ln.productId) continue;
        const product = await this.prisma.client.product.findFirst({ where: { id: ln.productId } });
        if (!product?.trackInventory) continue;
        if (product.productType !== 'stockable' && product.productType !== 'consumable') continue;

        await this.stock.issue({
          productId: ln.productId,
          locationId: warehouse.id,
          quantity: Number(ln.quantity),
          reference: `POS sale ${doc.documentNumber}`,
        } as any);
        issuedLines.push({ productId: ln.productId, locationId: warehouse.id, quantity: Number(ln.quantity) });
      }

      // Record payment(s). Tenders were validated against the total by the caller.
      for (const tender of tenders) {
        let accountId: string | undefined;
        if (tender.method === 'store_credit') {
          // Draw down the customer's store-credit sub-ledger, then post the
          // receipt against the store-credit liability account (Dr liability /
          // Cr receivable) instead of cash — no money actually changed hands.
          await this.loyalty.redeemCredit({ partnerId, amount: Number(tender.amount), documentId: doc.id });
          redeemedCredit += Number(tender.amount);
          accountId = storeCreditAccount;
        }
        const payment = await this.payments.createReceipt({
          partnerId,
          paymentDate: new Date().toISOString(),
          paymentMethod: tender.method,
          amount: tender.amount,
          reference: tender.reference ?? reference,
          cashSessionId: tender.method === 'cash' ? cashSessionId : undefined,
          accountId,
          allocations: [{ documentId: doc.id, amount: tender.amount }],
        } as any);
        if ((payment as any)?.id) paymentIds.push((payment as any).id);
      }

      return { paymentIds };
    } catch (err: any) {
      await this.compensateFailedCheckout(doc.id, issuedLines, paymentIds);
      // Re-issue any store credit we drew down before the failure.
      if (redeemedCredit > 0) {
        try {
          await this.loyalty.issueCredit({
            partnerId,
            amount: redeemedCredit,
            source: 'sale_reversal',
            notes: `Reversal of failed sale ${doc.documentNumber}`,
          });
        } catch (e: any) {
          this.logger.error(`store-credit reversal failed: ${String(e?.message ?? e)}`);
          this.events.publish(EVENTS.StoreCreditReversalFailed, {
            organizationId: this.tenant.organizationId,
            invoiceId: doc.id,
            amount: redeemedCredit,
          });
        }
      }
      throw err;
    }
  }

  /**
   * Resolve the GL account a store-credit redemption posts against (the
   * store-credit liability). Mirrors AccountDeterminationService.mapped: a clear
   * error if the org hasn't configured it, so credit tenders never silently
   * book phantom cash.
   */
  private async storeCreditAccountId(): Promise<string> {
    const mapping = await this.prisma.client.accountMapping.findFirst({ where: { key: 'store_credit' } });
    if (!mapping) {
      throw new BadRequestException(
        "Store-credit payments need the 'store_credit' account mapping. Configure it under Accounting > Account Mapping.",
      );
    }
    return mapping.accountId;
  }

  /**
   * Best-effort compensation for a checkout that failed after its invoice was
   * posted. Never throws — each step is logged so a partial unwind surfaces in
   * the logs rather than masking the original error. Order matters: void
   * payments (release allocations) → restock → cancel invoice (reverse GL).
   */
  private async compensateFailedCheckout(
    invoiceId: string,
    issuedLines: Array<{ productId: string; locationId: string; quantity: number }>,
    paymentIds: string[],
  ): Promise<void> {
    let hasErrors = false;
    for (const pid of paymentIds) {
      try {
        await this.payments.void(pid);
      } catch (e: any) {
        this.logger.error(`compensateFailedCheckout: void payment ${pid} failed: ${String(e?.message ?? e)}`);
        hasErrors = true;
      }
    }
    for (const ln of issuedLines) {
      try {
        await this.stock.receive({
          productId: ln.productId,
          locationId: ln.locationId,
          quantity: ln.quantity,
          reference: `Reversal of failed sale ${invoiceId}`,
        } as any);
      } catch (e: any) {
        this.logger.error(`compensateFailedCheckout: restock ${ln.productId} failed: ${String(e?.message ?? e)}`);
        hasErrors = true;
      }
    }
    try {
      await this.invoices.cancel(invoiceId);
    } catch (e: any) {
      this.logger.error(`compensateFailedCheckout: cancel invoice ${invoiceId} failed: ${String(e?.message ?? e)}`);
      hasErrors = true;
    }
    if (hasErrors) {
      this.events.publish(EVENTS.CheckoutCompensationFailed, {
        organizationId: this.tenant.organizationId,
        invoiceId,
        paymentIds,
      });
    }
  }

  /**
   * MENU — issue a menu item's recipe ingredients (MenuProduct) from stock. A
   * sold "Cappuccino" depletes beans + milk + sugar (or, with the 1:1 bridge
   * recipe, its single backing product). Best-effort per ingredient.
   */
  private async issueMenuItemRecipe(
    menuItemId: string,
    lineQty: number,
    warehouseId: string,
    reference: string,
    issuedLines: Array<{ productId: string; locationId: string; quantity: number }>,
  ): Promise<void> {
    const orgId = this.tenant.organizationId;
    const recipe = await this.prisma.client.menuProduct.findMany({ where: { menuItemId, organizationId: orgId } });
    for (const ing of recipe as any[]) {
      const qty = Number(ing.quantity) * lineQty;
      if (!(qty > 0)) continue;
      try {
        await this.stock.issue({ productId: ing.productId, locationId: warehouseId, quantity: qty, reference } as any);
        issuedLines.push({ productId: ing.productId, locationId: warehouseId, quantity: qty });
      } catch (e: any) { this.logger.warn(`Ingredient stock shortage: ${e?.message}`); }
    }
  }

  /**
   * M-D — persist each line's selected modifiers as queryable rows. `docLines`
   * and `sourceLines` share order (lineNumber). Best-effort: never fails the sale,
   * and is a no-op until the DocumentLineModifier migration has been applied.
   */
  private async persistLineModifiers(
    client: any,
    docLines: Array<{ id: string; lineNumber: number }>,
    sourceLines: Array<{ modifiers?: CheckoutLineModifier[] }>,
  ): Promise<void> {
    try {
      const orgId = this.tenant.organizationId;
      const ordered = [...docLines].sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0));
      const rows: any[] = [];
      for (let i = 0; i < ordered.length; i++) {
        const mods = sourceLines[i]?.modifiers;
        if (!mods?.length) continue;
        for (const m of mods) {
          rows.push({
            organizationId: orgId,
            documentLineId: ordered[i].id,
            modifierId: m.modifierId,
            name: m.name,
            priceDelta: m.priceDelta,
          });
        }
      }
      if (rows.length > 0) await client.documentLineModifier.createMany({ data: rows });
    } catch (e: any) {
      this.logger.warn(`persistLineModifiers skipped: ${String(e?.message ?? e)}`);
    }
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

  /** Return the open (unposted) tab for a table — the running bill — or null. */
  async getTab(tableId: string) {
    const orgId = this.tenant.organizationId;
    const order = await this.prisma.client.posTableOrder.findFirst({
      where: { tableId, closedAt: null },
      orderBy: { openedAt: 'desc' },
      include: {
        document: { include: { lines: { orderBy: { lineNumber: 'asc' } }, partner: true } },
      },
    });
    if (!order?.document || order.document.status !== 'draft') return null;
    return order.document;
  }

  /**
   * Add a round of items to a table's tab. Creates the draft Document on the
   * first round and appends to it thereafter (rebuilding totals through the tax
   * engine), flips the table OCCUPIED, and optionally fires the new items to the
   * kitchen. No GL / stock / cash effect happens until the tab is settled.
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
    // Validate variants per line.
    for (const ln of input.lines) {
      if (ln.variantId && ln.menuItemId) {
        await this.variants.validateVariant(ln.menuItemId, ln.variantId);
      }
    }
    await this.modifiers.validateSelections(input.lines); // M-B
    const orgId = this.tenant.organizationId;
    const partnerId = input.partnerId ?? (await this.ensureWalkInCustomer(orgId));
    // Line discounts on a tab still need manager authority above the threshold.
    await this.assertDiscountAuthority({
      lines: input.lines,
      transactionDiscountPercent: input.transactionDiscountPercent,
      overrideById: input.overrideById,
    } as CheckoutInput);
    const expanded = await this.expandCheckoutLines(input.lines);
    const newLineInputs = expanded.map((l) => ({
      productId: l.productId ?? undefined,
      menuItemId: l.menuItemId ?? undefined,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxId: l.taxId ?? undefined,
      discountPercent: l.discountPercent,
      taxInclusive: l.taxInclusive,
    }));

    const result = await this.prisma.client.$transaction(async (tx: any) => {
      // Lock the table so two waiters can't race on the same tab.
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        input.tableId,
        orgId,
      );
      const table = await tx.posTable.findFirst({ where: { id: input.tableId, organizationId: orgId } });
      if (!table) throw new NotFoundException('Table not found');
      if (table.status === 'out_of_service') throw new ConflictException('Table is out of service');

      const open = await tx.posTableOrder.findFirst({
        where: { tableId: input.tableId, closedAt: null },
        include: { document: { include: { lines: true } } },
      });

      let documentId: string;
      if (open?.document && open.document.status === 'draft') {
        // Append: combine existing + new lines and rebuild totals via the builder.
        documentId = open.documentId;
        const existing = open.document.lines.map((s: any) => ({
          productId: s.productId ?? undefined,
          menuItemId: s.menuItemId ?? undefined,
          description: s.description,
          quantity: Number(s.quantity),
          unitPrice: Number(s.unitPrice),
          taxId: s.taxId ?? undefined,
          discountPercent: Number(s.discountPercent),
          taxInclusive: s.taxInclusive,
        }));
        const totals = await this.builder.prepareLines(tx, [...existing, ...newLineInputs]);
        await tx.documentLine.deleteMany({ where: { documentId } });
        for (const p of totals.prepared) {
          await tx.documentLine.create({
            data: {
              organizationId: orgId,
              documentId,
              productId: p.productId,
              menuItemId: p.menuItemId,
              accountId: p.accountId,
              description: p.description,
              quantity: p.quantity,
              unitPrice: p.unitPrice,
              discountPercent: p.discountPercent,
              taxId: p.taxId,
              subtotal: p.subtotal,
              taxAmount: p.taxAmount,
              total: p.total,
              lineNumber: p.lineNumber,
              taxInclusive: p.taxInclusive,
            },
          });
        }
        await tx.document.updateMany({
          where: { id: documentId },
          data: {
            subtotal: totals.subtotal,
            discountTotal: totals.discountTotal,
            taxAmount: totals.taxAmount,
            totalAmount: totals.total,
            amountResidual: totals.total,
          },
        });
        if (input.guestCount != null) {
          await tx.posTableOrder.updateMany({ where: { id: open.id }, data: { guestCount: input.guestCount } });
        }
      } else {
        // New tab — fresh draft document + table order.
        const doc = await this.builder.createDocument(
          tx,
          'sales_invoice',
          {
            partnerId,
            issueDate: new Date().toISOString(),
            sourceType: 'pos',
            branchId: table.branchId ?? undefined,
          } as any,
          newLineInputs,
        );
        documentId = doc.id;
        await tx.document.update({ where: { id: doc.id }, data: { tableId: input.tableId } });
        await tx.posTableOrder.create({
          data: { tableId: input.tableId, documentId: doc.id, guestCount: input.guestCount ?? null },
        });
      }

      if (table.status !== 'occupied' && table.status !== 'reserved') {
        await tx.posTable.update({ where: { id: input.tableId }, data: { status: 'occupied' } });
      }

      return tx.document.findFirst({
        where: { id: documentId },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });
    });

    // Fire the new round to the kitchen (outside the tx; never fails the round).
    if (input.sendToKitchen) {
      try {
        const kdsItems: any[] = [];
        for (const ln of expanded) {
          if (!ln.productId) continue;
          const product = await this.prisma.client.product.findFirst({ where: { id: ln.productId } });
          if (!product) continue;
          kdsItems.push({
            productId: ln.productId,
            productName: ln.description,
            quantity: Number(ln.quantity),
            modifiers: ln.modifiers ?? [],
            notes: ln.note,
            station: (product as any).station ?? 'cafe',
            variantName: ln.variantName,
            accompanimentNames: ln.accompanimentNames,
          });
        }
        if (kdsItems.length > 0) {
          const docId = (result as any)?.id;
          await this.kds.createTicketsForSale({
            invoiceId: docId,
            label: (result as any)?.documentNumber ?? 'Tab',
            items: kdsItems,
          });
          const lineIds = expanded.filter((ln: any) => ln.productId).map((ln: any) => ln.id);
          const qtyMap = new Map<string, number>(expanded.filter((ln: any) => ln.productId).map((ln: any) => [ln.id as string, Number(ln.quantity)]));
          await this.printLifecycle.markKitchenPrinted(this.prisma.client, lineIds, qtyMap, this.tenant.userId ?? undefined);
          await this.printLifecycle.recordPrintLog(this.prisma.client, {
            organizationId: orgId,
            documentId: docId,
            type: 'KOT',
            printedById: this.tenant.userId ?? undefined,
          });
        }
      } catch (e: any) { this.logger.warn(`KDS push failed: ${e?.message}`); }
    }

    await this.audit.record({
      entity: 'Document',
      entityId: (result as any)?.id,
      action: 'update' as any,
      newValues: { kind: 'tab_round', tableId: input.tableId, lineCount: expanded.length },
    });
    return result;
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
  }) {
    const orgId = this.tenant.organizationId;
    if (input.lines?.length) {
      // Validate variants per line.
      for (const ln of input.lines) {
        if (ln.variantId && ln.menuItemId) {
          await this.variants.validateVariant(ln.menuItemId, ln.variantId);
        }
      }
      await this.modifiers.validateSelections(input.lines); // M-B
    }
    const expanded = input.lines?.length ? await this.expandCheckoutLines(input.lines) : [];
    const lineInputs = expanded.map((l) => ({
      productId: l.productId ?? undefined,
      menuItemId: l.menuItemId ?? undefined,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxId: l.taxId ?? undefined,
      discountPercent: l.discountPercent,
      taxInclusive: l.taxInclusive,
    }));

    return this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        input.tableId,
        orgId,
      );
      const table = await tx.posTable.findFirst({ where: { id: input.tableId, organizationId: orgId } });
      if (!table) throw new NotFoundException('Table not found');

      const open = await tx.posTableOrder.findFirst({
        where: { tableId: input.tableId, closedAt: null },
        include: { document: true },
      });
      const draftId = open?.document && open.document.status === 'draft' ? open.documentId : null;

      // Empty order → cancel the draft and free the table.
      if (lineInputs.length === 0) {
        if (draftId && open) {
          await tx.documentLine.deleteMany({ where: { documentId: draftId } });
          await tx.document.update({
            where: { id: draftId },
            data: { status: 'cancelled', subtotal: 0, discountTotal: 0, taxAmount: 0, totalAmount: 0, amountResidual: 0, notes: 'Order emptied' },
          });
          await tx.posTableOrder.updateMany({ where: { id: open.id }, data: { closedAt: new Date() } });
        }
        if (table.status !== 'out_of_service' && table.status !== 'reserved') {
          await tx.posTable.update({ where: { id: input.tableId }, data: { status: 'available' } });
        }
        return null;
      }

      const partnerId = input.partnerId ?? (await this.ensureWalkInCustomer(orgId));
      let documentId: string;
      if (draftId && open) {
        documentId = draftId;
        const oldLines: any[] = await tx.documentLine.findMany({
          where: { documentId },
          select: {
            id: true,
            productId: true,
            kitchenPrintCount: true,
            kitchenLastPrintedAt: true,
            kitchenPrintedQty: true,
            cancelPrintCount: true,
            cancelLastPrintedAt: true,
            lastKitchenPrintedById: true,
            billPrintedAt: true,
          },
        });
        const lifecycleByPid = new Map(oldLines.filter((l: any) => l.productId).map((l: any) => [l.productId, l]));
        const totals = await this.builder.prepareLines(tx, lineInputs);
        await tx.documentLine.deleteMany({ where: { documentId } });
        for (const p of totals.prepared) {
          const lc: any = p.productId ? lifecycleByPid.get(p.productId) : null;
          await tx.documentLine.create({
            data: {
              organizationId: orgId,
              documentId,
              productId: p.productId,
              menuItemId: p.menuItemId,
              accountId: p.accountId,
              description: p.description,
              quantity: p.quantity,
              unitPrice: p.unitPrice,
              discountPercent: p.discountPercent,
              taxId: p.taxId,
              subtotal: p.subtotal,
              taxAmount: p.taxAmount,
              total: p.total,
              lineNumber: p.lineNumber,
              taxInclusive: p.taxInclusive,
              kitchenPrintCount: lc?.kitchenPrintCount ?? 0,
              kitchenLastPrintedAt: lc?.kitchenLastPrintedAt ?? null,
              kitchenPrintedQty: lc?.kitchenPrintedQty ?? null,
              cancelPrintCount: lc?.cancelPrintCount ?? 0,
              cancelLastPrintedAt: lc?.cancelLastPrintedAt ?? null,
              lastKitchenPrintedById: lc?.lastKitchenPrintedById ?? null,
              billPrintedAt: lc?.billPrintedAt ?? null,
            },
          });
        }
        await tx.document.updateMany({
          where: { id: documentId },
          data: {
            subtotal: totals.subtotal,
            discountTotal: totals.discountTotal,
            taxAmount: totals.taxAmount,
            totalAmount: totals.total,
            amountResidual: totals.total,
          },
        });
        if (input.guestCount != null) {
          await tx.posTableOrder.updateMany({ where: { id: open.id }, data: { guestCount: input.guestCount } });
        }
      } else {
        const doc = await this.builder.createDocument(
          tx,
          'sales_invoice',
          { partnerId, issueDate: new Date().toISOString(), sourceType: 'pos', branchId: table.branchId ?? undefined } as any,
          lineInputs,
        );
        documentId = doc.id;
        await tx.document.update({ where: { id: doc.id }, data: { tableId: input.tableId } });
        await tx.posTableOrder.create({
          data: { tableId: input.tableId, documentId: doc.id, guestCount: input.guestCount ?? null },
        });
      }

      if (table.status !== 'occupied' && table.status !== 'reserved') {
        await tx.posTable.update({ where: { id: input.tableId }, data: { status: 'occupied' } });
      }
      const fresh = await tx.document.findFirst({
        where: { id: documentId },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });
      // M-D: re-persist structured modifiers for the saved lines (the old rows
      // cascade-deleted with the replaced lines). Best-effort.
      await this.persistLineModifiers(tx, (fresh as any)?.lines ?? [], expanded);
      return fresh;
    });
  }

  /**
   * Fire the table's current draft order to the kitchen display (KDS): one ticket
   * per station from the saved order lines. Does not modify the order.
   */
  async fireTabToKitchen(tableId: string) {
    const orgId = this.tenant.organizationId;
    const order = await this.prisma.client.posTableOrder.findFirst({
      where: { tableId, closedAt: null },
      orderBy: { openedAt: 'desc' },
      include: { document: { include: { lines: { orderBy: { lineNumber: 'asc' } } } } },
    });
    if (!order?.document || order.document.status !== 'draft') {
      throw new BadRequestException('No open order to send to the kitchen');
    }
    const doc = order.document;
    const userId = this.tenant.userId ?? undefined;

    // Compute deltas vs. last printed state.
    const deltas = await this.printLifecycle.getKitchenDeltas(this.prisma.client, doc.id);

    // Phase T5: no changes since last print — return early without duplicate KOT.
    if (deltas.addLines.length === 0 && deltas.removeLines.length === 0) {
      return { ticketIds: [], count: 0, message: 'No changes since last kitchen fire' };
    }

    // Send only new / increased qty to KDS.
    let ticketIds: string[] = [];
    if (deltas.addLines.length > 0) {
      const kdsItems = [];
      for (const { line, delta } of deltas.addLines) {
        if (!line.productId) continue;
        const product = await this.prisma.client.product.findFirst({ where: { id: line.productId } });
        kdsItems.push({
          productId: line.productId,
          productName: line.description,
          quantity: delta,
          modifiers: line.modifiers ?? [],
          notes: line.note ?? null,
          station: (product as any)?.station ?? 'cafe',
        });
      }
      if (kdsItems.length > 0) {
        ticketIds = await this.kds.createTicketsForSale({
          invoiceId: doc.id,
          label: (doc as any).documentNumber,
          items: kdsItems,
        });
      }
    }

    // Handle decreases as cancellation tickets.
    if (deltas.removeLines.length > 0) {
      const cancelItems = [];
      for (const { line, delta } of deltas.removeLines) {
        if (!line.productId) continue;
        const product = await this.prisma.client.product.findFirst({ where: { id: line.productId } });
        cancelItems.push({
          productId: line.productId,
          productName: `[CANCEL] ${line.description}`,
          quantity: delta,
          modifiers: [],
          notes: line.note ?? null,
          station: (product as any)?.station ?? 'cafe',
        });
      }
      if (cancelItems.length > 0) {
        const cancelIds = await this.kds.createTicketsForSale({
          invoiceId: doc.id,
          label: `[CANCEL] ${(doc as any).documentNumber}`,
          items: cancelItems,
        });
        ticketIds = [...ticketIds, ...cancelIds];
      }
    }

    // Update lifecycle counters.
    const addedLineIds = deltas.addLines.filter((l: any) => l.line.productId).map((l: any) => l.line.id);
    const addedQtyMap = new Map(deltas.addLines.filter((l: any) => l.line.productId).map((l: any) => [l.line.id, Number(l.line.quantity)]));
    const removedLineIds = deltas.removeLines.filter((l: any) => l.line.productId).map((l: any) => l.line.id);

    if (addedLineIds.length > 0) {
      await this.printLifecycle.markKitchenPrinted(this.prisma.client, addedLineIds, addedQtyMap, userId);
      await this.printLifecycle.recordPrintLog(this.prisma.client, {
        organizationId: orgId,
        documentId: doc.id,
        type: 'KOT',
        printedById: userId,
      });
    }
    if (removedLineIds.length > 0) {
      await this.printLifecycle.markCancelPrinted(this.prisma.client, removedLineIds, userId);
      await this.printLifecycle.recordPrintLog(this.prisma.client, {
        organizationId: orgId,
        documentId: doc.id,
        type: 'CANCEL',
        printedById: userId,
      });
    }

    return { ticketIds, count: ticketIds.length };
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
    // T-LOCK: lock the table row so two cashiers cannot settle the same tab concurrently.
    const [tabOrder] = await this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM "PosTable" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        input.tableId,
        orgId,
      );
      return tx.posTableOrder.findMany({
        where: { tableId: input.tableId, closedAt: null },
        orderBy: { openedAt: 'desc' },
        take: 1,
        include: { document: { include: { lines: { orderBy: { lineNumber: 'asc' } } } } },
      });
    });
    if (!tabOrder?.document || tabOrder.document.status !== 'draft') {
      throw new BadRequestException('No open tab to settle on this table');
    }
    const doc = tabOrder.document;
    if (!doc.lines.length) throw new BadRequestException('The tab is empty');

    // Bridge the legacy draft tab into the Order→Invoice→Receipt pipeline. The
    // draft lines are already priced (modifiers folded into unitPrice), so the
    // order is created from resolved lines (no re-validation / re-folding).
    const order = await this.orders.createOrderFromResolved({
      orderType: 'dine_in',
      tableId: input.tableId,
      partnerId: doc.partnerId ?? undefined,
      cashSessionId: input.cashSessionId,
      branchId: doc.branchId ?? undefined,
      lines: doc.lines.map((l: any) => ({
        productId: l.productId ?? null,
        menuItemId: l.menuItemId ?? null,
        description: l.description,
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
        taxId: l.taxId ?? null,
        discountPercent: Number(l.discountPercent ?? 0),
        taxInclusive: (l as any).taxInclusive,
        note: l.note ?? null,
      })),
    });

    // Generate the Invoice (own GL + stock at bill time) then take payment
    // (writes the Receipt + ReceiptItems and closes the order).
    let invoice: any;
    try {
      invoice = await this.billing.generateInvoice(order.id, { transactionDiscountPercent: input.transactionDiscountPercent });
    } catch (e) {
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
    } catch (e) {
      await this.billing.refund(invoice.id, 'settle: payment failed').catch(() => undefined);
      throw e;
    }

    // Retire the legacy draft tab: cancel the draft Document + close its
    // PosTableOrder so the table frees and the old draft isn't left dangling.
    try {
      await this.prisma.client.document.update({
        where: { id: doc.id },
        data: { status: 'cancelled', notes: `Migrated to invoice ${invoice.invoiceNumber}` },
      });
    } catch (e: any) { this.logger.warn(`Legacy doc cancel failed: ${e?.message}`); }
    let tableStatus: string | undefined;
    try {
      const closeResult = await this.tables.closeTableOrder({ tableId: input.tableId, documentId: doc.id });
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
      const modifierDelta = (l.modifiers ?? []).reduce((s, m) => s + Number(m.priceDelta), 0);

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

      // Resolve accompaniment price impact (stacks on top).
      let accompanimentImpact = 0;
      let accompanimentNames: string[] = [];
      if (l.accompanimentOptionIds && l.accompanimentOptionIds.length > 0 && l.menuItemId) {
        const result = await this.accompaniments.validateSelections(l.menuItemId, l.accompanimentOptionIds);
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
      if (l.modifiers && l.modifiers.length > 0) {
        noteParts.push(...l.modifiers.map((m) => `+ ${m.name}`));
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
        modifiers: l.modifiers,
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

  private normalizeTenders(input: CheckoutInput, totalAmount: any): PaymentTender[] {
    const total = Number(totalAmount);
    if (input.tenders?.length) {
      const sum = input.tenders.reduce((s, t) => s + Number(t.amount), 0);
      // Allow a 0.01 rounding tolerance for cash.
      if (Math.abs(sum - total) > 0.01) {
        throw new BadRequestException(`Tenders sum ${sum} does not match total ${total}`);
      }
      return input.tenders;
    }
    return [{ method: input.paymentMethod ?? 'cash', amount: total }];
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