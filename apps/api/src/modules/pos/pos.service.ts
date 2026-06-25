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
import { PosKdsService } from './pos-kds.service';
import { PosLoyaltyService } from './pos-loyalty.service';
import { dec } from '../../kernel/common/money';
import { EVENTS } from '@erp/shared';
import { NotificationsService } from '../../kernel/notifications/notifications.service';
import { PosTablesService } from './pos-tables.service';

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
    private readonly kds: PosKdsService,
    private readonly loyalty: PosLoyaltyService,
    private readonly tables: PosTablesService,
  ) {}

  async checkout(input: CheckoutInput) {
    if (!input.lines?.length) throw new BadRequestException('Cart is empty');
    // M-B: enforce required / min / max modifier rules server-side.
    await this.modifiers.validateSelections(input.lines);
    const orgId = this.tenant.organizationId;
    const partnerId = input.partnerId ?? (await this.ensureWalkInCustomer(orgId));
    const effectiveDiscount = await this.assertDiscountAuthority(input);

    // 1) Resolve lines (sku → id, modifier folding, combo expansion). Shared
    //    with the open-tab flow so a tab and a counter sale price identically.
    const expanded = await this.expandCheckoutLines(input.lines);

    // 2) Pick the main warehouse.
    const warehouse = await this.prisma.client.inventoryLocation.findFirst({
      where: { organizationId: orgId, type: 'warehouse', isActive: true },
    });

    // 3) Create + post the sales invoice. transactionDiscountPercent is
    //    stored on the invoice's notes / referenced via a single line-level
    //    discount by storing the percent in the document reference field.
    const doc = await this.builder.createDocument(
      this.prisma.client,
      'sales_invoice',
      {
        partnerId,
        branchId: input.branchId,
        reference: input.reference ?? (effectiveDiscount > 0 ? `Discount ${effectiveDiscount}%` : undefined),
        notes: input.notes,
        issueDate: new Date().toISOString(),
        sourceType: 'pos',
      } as any,
      expanded.map((l) => ({
        productId: l.productId ?? undefined,
        menuItemId: l.menuItemId ?? undefined,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxId: l.taxId ?? undefined,
        discountPercent: l.discountPercent ?? 0,
        // P10: per-line taxInclusive override (or undefined → builder reads product.taxInclusive).
        taxInclusive: l.taxInclusive,
      })),
    );
    // M-D: persist the selected modifiers per line for reporting (best-effort).
    await this.persistLineModifiers(this.prisma.client, (doc as any).lines ?? [], expanded);

    // 4) Validate tenders against the computed total BEFORE any GL effect, so a
    //    tender/total mismatch fails while the document is still an un-posted
    //    draft (no GL, no stock, no cash to unwind).
    let tenders: PaymentTender[];
    try {
      tenders = this.normalizeTenders(input, doc.totalAmount);
    } catch (e) {
      await this.invoices.cancel(doc.id).catch(() => undefined);
      throw e;
    }

    // 5) Post the invoice, issue stock, and take payment. The three core
    //    services each own their DB transaction, so this is not one atomic
    //    commit; executeSaleEffects compensates (void payments, restock, cancel
    //    invoice) if any step throws — a failed checkout never leaves a posted
    //    invoice, phantom stock, or orphan cash behind.
    const { lowStock, paymentIds } = await this.executeSaleEffects({
      doc,
      expanded,
      warehouse,
      tenders,
      partnerId,
      cashSessionId: input.cashSessionId,
      reference: input.reference,
    });

    const tendered = input.amountTendered ?? Number(doc.totalAmount);

    // 6) Audit + event.
    await this.audit.record({
      entity: 'Document',
      entityId: doc.id,
      action: 'post' as any,
      newValues: { kind: 'pos_sale', totalAmount: doc.totalAmount.toString(), discountPercent: effectiveDiscount, overrideById: input.overrideById ?? null },
    });
    this.events.publish(EVENTS.PosSaleCompleted, {
      organizationId: orgId,
      invoiceId: doc.id,
      invoiceNumber: (doc as any).documentNumber,
      cashSessionId: input.cashSessionId,
      total: doc.totalAmount.toString(),
    });

    // P7: auto-earn loyalty points for the partner (skip the walk-in).
    try {
      const WALKIN_CODE = 'WALKIN';
      if (partnerId) {
        const partner = await this.prisma.client.partner.findFirst({
          where: { id: partnerId, organizationId: orgId },
        });
        if (partner && partner.code !== WALKIN_CODE) {
          await this.loyalty.earnPoints({
            partnerId,
            documentId: doc.id,
            amount: Number(doc.totalAmount),
            reason: 'sale',
          });
        }
      }
    } catch {
      // Loyalty is a "nice to have" — don't fail the sale if it errors.
    }

    // P5: create KDS tickets (one per station) so the kitchen/bar/cafe
    // screens get a new ticket as soon as the sale settles. Items are
    // denormalised so the KDS renders without N+1 joins.
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
        });
      }
      if (kdsItems.length > 0) {
        await this.kds.createTicketsForSale({
          invoiceId: doc.id,
          label: (doc as any).documentNumber,
          items: kdsItems,
        });
      }
    } catch {
      // KDS is a "nice to have" — don't fail the sale if it errors.
    }

    // POS Tables (T1): if the cashier attached a tableId to the sale, link
    // the freshly-posted invoice to that table. For counter sales with a table,
    // the order is immediately paid so we close the table order and sync status.
    if (input.tableId) {
      try {
        await this.tables.attachSaleToTable({
          tableId: input.tableId,
          documentId: doc.id,
          guestCount: input.guestCount,
        });
        // Close the table order immediately since payment is complete
        await this.tables.closeTableOrder({
          tableId: input.tableId,
          documentId: doc.id,
        });
      } catch (e: any) {
        this.logger?.warn(`attachSaleToTable/closeTableOrder failed for ${input.tableId}: ${String(e?.message ?? e)}`);
      }
    }

    return {
      invoiceId: doc.id,
      invoiceNumber: (doc as any).documentNumber,
      paymentIds,
      total: Number(doc.totalAmount),
      change: Math.max(0, tendered - Number(doc.totalAmount)),
      lowStock, // P9: populated when any warn-policy line is below on-hand
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
    lowStock: Array<{ productId: string; productName: string; onHand: number; requested: number }>;
    paymentIds: string[];
  }> {
    const { doc, expanded, warehouse, tenders, partnerId, cashSessionId, reference } = args;
    const orgId = this.tenant.organizationId;
    const lowStock: Array<{ productId: string; productName: string; onHand: number; requested: number }> = [];
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

      // Stock-out for stockable lines — honors Product.stockPolicy (P9):
      //   block  — refuse the sale if any line exceeds on-hand stock.
      //   warn   — allow the sale, return `lowStock` in the response.
      //   silent — allow the sale, ignore shortage (back-compat default).
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

        const stockItem = await this.prisma.client.stockItem.findFirst({
          where: { organizationId: orgId, productId: ln.productId, locationId: warehouse.id },
        });
        const onHand = Number(stockItem?.quantity ?? 0);
        const requested = Number(ln.quantity);
        const shortage = requested - onHand;
        const policy = (product as any).stockPolicy ?? 'silent';

        if (shortage > 0 && policy === 'block') {
          throw new BadRequestException(
            `Insufficient stock for "${product.name}": have ${onHand}, need ${requested}. Either restock or reduce the quantity.`,
          );
        }
        if (shortage > 0 && policy === 'warn') {
          lowStock.push({ productId: ln.productId, productName: product.name, onHand, requested });
        }

        try {
          await this.stock.issue({
            productId: ln.productId,
            locationId: warehouse.id,
            quantity: requested,
            reference: `POS sale ${doc.documentNumber}`,
          } as any);
          issuedLines.push({ productId: ln.productId, locationId: warehouse.id, quantity: requested });
        } catch (e: any) {
          if (policy === 'block') throw e; // already handled above, just be defensive
          // silent (default) and warn: shortage is recorded in the inventory dashboard.
        }

        // After the issue, check the new on-hand against minQuantity. If it
        // crossed below the threshold, fire a low-stock alert (P9.C).
        if (product.minQuantity != null) {
          const after = await this.prisma.client.stockItem.findFirst({
            where: { organizationId: orgId, productId: ln.productId, locationId: warehouse.id },
          });
          const afterQty = Number(after?.quantity ?? 0);
          const min = Number(product.minQuantity);
          if (afterQty <= min) {
            await this.publishLowStockAlert({
              productId: ln.productId,
              productName: product.name,
              onHand: afterQty,
              minQuantity: min,
              invoiceId: doc.id,
            });
          }
        }
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

      return { lowStock, paymentIds };
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
    for (const pid of paymentIds) {
      try {
        await this.payments.void(pid);
      } catch (e: any) {
        this.logger.error(`compensateFailedCheckout: void payment ${pid} failed: ${String(e?.message ?? e)}`);
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
      }
    }
    try {
      await this.invoices.cancel(invoiceId);
    } catch (e: any) {
      this.logger.error(`compensateFailedCheckout: cancel invoice ${invoiceId} failed: ${String(e?.message ?? e)}`);
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
      } catch {
        // Ingredient shortage surfaces on the inventory dashboard; don't fail the sale.
      }
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
        } catch { /* stock count adjustment surfaces on dashboard */ }
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
          });
        }
        if (kdsItems.length > 0) {
          await this.kds.createTicketsForSale({
            invoiceId: (result as any)?.id,
            label: (result as any)?.documentNumber ?? 'Tab',
            items: kdsItems,
          });
        }
      } catch {
        // KDS is non-fatal.
      }
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
    if (input.lines?.length) await this.modifiers.validateSelections(input.lines); // M-B
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
        const totals = await this.builder.prepareLines(tx, lineInputs);
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
    const items: any[] = [];
    for (const ln of doc.lines as any[]) {
      if (!ln.productId) continue;
      const product = await this.prisma.client.product.findFirst({ where: { id: ln.productId } });
      items.push({
        productId: ln.productId,
        productName: ln.description,
        quantity: Number(ln.quantity),
        modifiers: [],
        notes: ln.note ?? null,
        station: (product as any)?.station ?? 'cafe',
      });
    }
    if (items.length === 0) throw new BadRequestException('Order has no kitchen items');
    const ticketIds = await this.kds.createTicketsForSale({
      invoiceId: doc.id,
      label: (doc as any).documentNumber,
      items,
    });
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
    cashSessionId?: string;
  }) {
    const orgId = this.tenant.organizationId;
    const order = await this.prisma.client.posTableOrder.findFirst({
      where: { tableId: input.tableId, closedAt: null },
      orderBy: { openedAt: 'desc' },
      include: { document: { include: { lines: { orderBy: { lineNumber: 'asc' } } } } },
    });
    if (!order?.document || order.document.status !== 'draft') {
      throw new BadRequestException('No open tab to settle on this table');
    }
    const doc = order.document;
    if (!doc.lines.length) throw new BadRequestException('The tab is empty');

    const expanded = doc.lines.map((l: any) => ({
      productId: l.productId ?? null,
      menuItemId: l.menuItemId ?? null,
      description: l.description,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unitPrice),
      modifiers: undefined as CheckoutLineModifier[] | undefined,
      note: l.note ?? null,
    }));

    const warehouse = await this.prisma.client.inventoryLocation.findFirst({
      where: { organizationId: orgId, type: 'warehouse', isActive: true },
    });

    // Validate tenders against the tab total before any GL effect.
    const tenders = this.normalizeTenders(
      { tenders: input.tenders, paymentMethod: input.paymentMethod, amountTendered: input.amountTendered } as CheckoutInput,
      doc.totalAmount,
    );

    const { lowStock, paymentIds } = await this.executeSaleEffects({
      doc,
      expanded,
      warehouse,
      tenders,
      partnerId: doc.partnerId!,
      cashSessionId: input.cashSessionId,
      reference: undefined,
    });

    // E2: make sure the kitchen sees this order even if it was never explicitly
    // "Sent to Kitchen" — fire tickets at settle, but only if none exist yet for
    // this document (so an already-fired tab isn't double-ticketed). Non-fatal.
    try {
      const already = await this.prisma.client.kitchenTicket.count({ where: { invoiceId: doc.id } });
      if (already === 0) {
        const kdsItems: any[] = [];
        for (const ln of doc.lines as any[]) {
          if (!ln.productId) continue;
          const product = await this.prisma.client.product.findFirst({ where: { id: ln.productId } });
          kdsItems.push({
            productId: ln.productId,
            productName: ln.description,
            quantity: Number(ln.quantity),
            modifiers: [],
            notes: ln.note ?? null,
            station: (product as any)?.station ?? 'cafe',
          });
        }
        if (kdsItems.length > 0) {
          await this.kds.createTicketsForSale({ invoiceId: doc.id, label: (doc as any).documentNumber, items: kdsItems });
        }
      }
    } catch {
      // KDS is non-fatal.
    }

    // Close the table order and sync status (available if no open orders)
    const closeResult = await this.tables.closeTableOrder({ tableId: input.tableId, documentId: doc.id });

    const tendered = input.amountTendered ?? Number(doc.totalAmount);
    await this.audit.record({
      entity: 'Document',
      entityId: doc.id,
      action: 'post' as any,
      newValues: { kind: 'tab_settled', tableId: input.tableId, total: doc.totalAmount.toString() },
    });
    this.events.publish(EVENTS.PosSaleCompleted, {
      organizationId: orgId,
      invoiceId: doc.id,
      invoiceNumber: (doc as any).documentNumber,
      cashSessionId: input.cashSessionId,
      total: doc.totalAmount.toString(),
    });

    // Loyalty (skip the walk-in).
    try {
      if (doc.partnerId) {
        const partner = await this.prisma.client.partner.findFirst({
          where: { id: doc.partnerId, organizationId: orgId },
        });
        if (partner && partner.code !== 'WALKIN') {
          await this.loyalty.earnPoints({
            partnerId: doc.partnerId,
            documentId: doc.id,
            amount: Number(doc.totalAmount),
            reason: 'sale',
          });
        }
      }
    } catch {
      // Loyalty is non-fatal.
    }

    return {
      invoiceId: doc.id,
      invoiceNumber: (doc as any).documentNumber,
      paymentIds,
      total: Number(doc.totalAmount),
      change: Math.max(0, tendered - Number(doc.totalAmount)),
      lowStock,
      tableStatus: closeResult.tableStatus,
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
    const lines = inputLines.map((l) => {
      const modifierDelta = (l.modifiers ?? []).reduce((s, m) => s + Number(m.priceDelta), 0);
      return {
        productId: l.productId ?? skuMap.get(l.sku?.toLowerCase() ?? '') ?? null,
        menuItemId: l.menuItemId ?? null,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice + modifierDelta,
        taxId: l.taxId ?? null,
        discountPercent: l.discountPercent ?? 0,
        note: [
          l.note,
          ...(l.modifiers ?? []).map((m) => `+ ${m.name}`),
        ].filter(Boolean).join(' | ') || null,
        modifiers: l.modifiers,
        comboId: l.comboId,
        comboPrice: undefined as number | undefined,
        taxInclusive: l.taxInclusive,
      };
    });

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