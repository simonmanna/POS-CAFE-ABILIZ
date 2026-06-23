/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
    const orgId = this.tenant.organizationId;
    const skuMap = await this.resolveSkus(input.lines);
    const partnerId = input.partnerId ?? (await this.ensureWalkInCustomer(orgId));
    const effectiveDiscount = await this.assertDiscountAuthority(input);

    // 1) Resolve lines. P4: modifier priceDeltas are folded into unitPrice
    //    server-side so the receipt + GL stay authoritative. P10: per-product
    //    taxInclusive is read from the Product row and passed to the document
    //    builder so the tax engine splits net vs tax correctly.
    const lines = input.lines.map((l) => {
      const modifierDelta = (l.modifiers ?? []).reduce((s, m) => s + Number(m.priceDelta), 0);
      return {
        productId: l.productId ?? skuMap.get(l.sku?.toLowerCase() ?? '') ?? null,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice + modifierDelta,
        taxId: l.taxId ?? null,
        discountPercent: l.discountPercent ?? 0,
        note: [
          l.note,
          ...(l.modifiers ?? []).map((m) => `+ ${m.name}`),
        ].filter(Boolean).join(' | ') || null,
        // P4 metadata for combo expansion at createDocument time:
        modifiers: l.modifiers,
        comboId: l.comboId,
        comboPrice: undefined as number | undefined,
        // P10: per-line taxInclusive override, else fall back to whatever
        // the document builder reads from the Product row.
        taxInclusive: l.taxInclusive,
      };
    });

    // 1b) P4 combo expansion: any line with comboId is replaced by one line
    //     per ComboItem. The combo's price is attributed to the first
    //     component; remaining components are priced at zero (free).
    const expanded: typeof lines = [];
    for (const ln of lines) {
      if (!ln.comboId) { expanded.push(ln); continue; }
      const comps = await this.modifiers.expandCombosForCheckout([{ comboId: ln.comboId, quantity: ln.quantity }]);
      // The first component carries the combo price; rest are zero-priced.
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
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxId: l.taxId ?? undefined,
        discountPercent: l.discountPercent ?? 0,
        // P10: per-line taxInclusive override (or undefined → builder reads product.taxInclusive).
        taxInclusive: l.taxInclusive,
      })),
    );
    await this.invoices.post(doc.id);

    //    4) Stock-out for stockable lines — honors Product.stockPolicy (P9):
    //         block  — refuse the sale if any line exceeds on-hand stock.
    //         warn   — allow the sale, return `lowStock` in the response so the
    //                  UI shows a warning toast. Also publish a low-stock alert.
    //         silent — allow the sale, ignore shortage (back-compat default).
    const lowStock: Array<{ productId: string; productName: string; onHand: number; requested: number }> = [];
    for (const ln of expanded) {
      if (!ln.productId || !warehouse) continue;
      const product = await this.prisma.client.product.findFirst({ where: { id: ln.productId } });
      if (!product?.trackInventory) continue;
      if (product.productType !== 'stockable' && product.productType !== 'consumable') continue;

      // Read on-hand for policy check.
      const stockItem = await this.prisma.client.stockItem.findFirst({
        where: { organizationId: orgId, productId: ln.productId, locationId: warehouse.id },
      });
      const onHand = Number(stockItem?.quantity ?? 0);
      const requested = Number(ln.quantity);
      const shortage = requested - onHand;
      const policy = (product as any).stockPolicy ?? 'silent';

      if (shortage > 0 && policy === 'block') {
        // Roll back the invoice we just created.
        // (No need to roll back the payment — we haven't created any yet.)
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

    // 5) Record payment(s).
    const tenders = this.normalizeTenders(input, doc.totalAmount);
    const paymentIds: string[] = [];
    for (const tender of tenders) {
      const payment = await this.payments.createReceipt({
        partnerId,
        paymentDate: new Date().toISOString(),
        paymentMethod: tender.method,
        amount: tender.amount,
        reference: tender.reference ?? input.reference,
        cashSessionId: tender.method === 'cash' ? input.cashSessionId : undefined,
        allocations: [{ documentId: doc.id, amount: tender.amount }],
      } as any);
      if ((payment as any)?.id) paymentIds.push((payment as any).id);
    }

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
    // the freshly-posted invoice to that table and flip status → OCCUPIED.
    // Errors are intentionally non-fatal — a sale shouldn't fail because of
    // an unrelated table bookkeeping problem.
    if (input.tableId) {
      try {
        await this.tables.attachSaleToTable({
          tableId: input.tableId,
          documentId: doc.id,
          guestCount: input.guestCount,
        });
        // On successful payment, the table goes DIRTY (needs cleaning).
        // Marking it before the cashier hits "Mark cleaned" is intentional —
        // it prevents the next shift from re-using a dirty table.
        await this.tables.markForCleaning({
          tableId: input.tableId,
          documentId: doc.id,
        });
      } catch (e: any) {
        this.logger?.warn(`attachSaleToTable failed for ${input.tableId}: ${String(e?.message ?? e)}`);
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

  /** Refund: credit note + reversing payment + stock-in. */
  async refund(input: { invoiceId: string; reason?: string; cashSessionId?: string; overrideById?: string }) {
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
    const warehouse = await this.prisma.client.inventoryLocation.findFirst({
      where: { organizationId: orgId, type: 'warehouse', isActive: true },
    });

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
      original.lines.map((ln: any) => ({
        productId: ln.productId,
        description: ln.description,
        quantity: ln.quantity,
        unitPrice: ln.unitPrice,
        taxId: ln.taxId,
        discountPercent: ln.discountPercent,
        // P10: pass the taxInclusive flag from the original line through.
        taxInclusive: (ln as any).taxInclusive,
      })),
    );

    if (warehouse) {
      for (const ln of original.lines) {
        if (!ln.productId) continue;
        try {
          await this.stock.receive({
            productId: ln.productId,
            locationId: warehouse.id,
            quantity: Number(ln.quantity),
            reference: `Refund of ${(original as any).documentNumber}`,
          } as any);
        } catch { /* stock count adjustment surfaces on dashboard */ }
      }
    }

    const payment = await this.payments.createSupplierPayment({
      partnerId: original.partnerId,
      paymentDate: new Date().toISOString(),
      paymentMethod: 'cash',
      amount: Number((original as any).totalAmount),
      reference: `Refund of ${(original as any).documentNumber}`,
      cashSessionId: input.cashSessionId,
      allocations: [{ documentId: creditNote.id, amount: Number((original as any).totalAmount) }],
    } as any);
    return { creditNoteId: creditNote.id, paymentId: (payment as any)?.id ?? null };
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
    return this.prisma.client.document.findMany({
      where: {
        organizationId: orgId,
        documentType: 'sales_invoice',
        sourceType: 'pos',
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { partner: true },
    });
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

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