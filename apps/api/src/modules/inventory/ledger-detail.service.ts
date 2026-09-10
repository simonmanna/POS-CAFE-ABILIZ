import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';

/**
 * Where a ledger line came from, in a shape the web app can turn into a route.
 * `kind` is a closed set — the web keeps the route table, we keep the lookup.
 */
export interface LedgerSourceRef {
  /** Raw InventoryLedger.referenceType. */
  referenceType: string;
  /** Raw InventoryLedger.referenceId (may be a record id OR a document code). */
  referenceId: string;
  /** Closed set the web maps to a route; `none` = no first-class detail page. */
  kind:
    | 'pos_invoice'
    | 'invoice'
    | 'credit_note'
    | 'goods_receipt'
    | 'purchase_order'
    | 'debit_note'
    | 'production_order'
    | 'rental_agreement'
    | 'repair_order'
    | 'stock_out'
    | 'waste'
    | 'stock_adjustment'
    | 'stock_transfer'
    | 'none';
  /** Record id to route to (resolved even when referenceId held a code). */
  targetId: string | null;
  /** Human document number/code. */
  code: string | null;
  /** Document status, when the source model has one. */
  status: string | null;
  /** Document date, when the source model has one. */
  date: Date | null;
  /** Counterparty name, when the source model has one. */
  partnerName: string | null;
  /** Short label for the button/heading, e.g. "POS Sale INV-00123". */
  label: string;
}

/** Reference types that never resolve to a document row of their own. */
const CODE_ONLY_TYPES = new Set(['direct_stock_in', 'direct_stock_out', 'stock_adjust', 'manual', 'min_stock']);

function titleCase(value: string): string {
  return value.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const LEDGER_INCLUDE = {
  product: { select: { id: true, code: true, name: true, uom: { select: { code: true } } } },
  variant: { select: { id: true, name: true } },
  location: { select: { id: true, code: true, name: true } },
  batch: { select: { id: true, batchNumber: true, expiryDate: true } },
} as const;

/**
 * Resolves one stock-ledger line into "whose transaction was this" — the source
 * document plus every sibling ledger line posted by the same transaction.
 */
@Injectable()
export class LedgerDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async getEntry(id: string) {
    const organizationId = this.tenant.organizationId;

    const entry = await this.prisma.client.inventoryLedger.findFirst({
      where: { id, organizationId },
      include: LEDGER_INCLUDE,
    });
    if (!entry) throw new NotFoundException('Ledger entry not found');

    // Sibling lines: everything posted under the same reference. A transaction
    // with no reference is its own single-line "document".
    const lines = entry.referenceType && entry.referenceId
      ? await this.prisma.client.inventoryLedger.findMany({
          where: {
            organizationId,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
          },
          include: LEDGER_INCLUDE,
          orderBy: { createdAt: 'asc' },
        })
      : [entry];

    let quantityIn = 0;
    let quantityOut = 0;
    let totalValue = 0;
    for (const line of lines) {
      const change = Number(line.quantityChange);
      if (change >= 0) quantityIn += change;
      else quantityOut += Math.abs(change);
      totalValue += Number(line.totalValue);
    }

    const source = await this.resolveSource(entry.referenceType, entry.referenceId);

    return {
      entry,
      lines,
      totals: { lines: lines.length, quantityIn, quantityOut, totalValue },
      source,
    };
  }

  // ===========================================================================
  // Source resolution
  // ===========================================================================

  private async resolveSource(
    referenceType: string | null,
    referenceId: string | null,
  ): Promise<LedgerSourceRef | null> {
    if (!referenceType || !referenceId) return null;

    const base = {
      referenceType,
      referenceId,
      kind: 'none' as LedgerSourceRef['kind'],
      targetId: null as string | null,
      code: null as string | null,
      status: null as string | null,
      date: null as Date | null,
      partnerName: null as string | null,
      label: titleCase(referenceType),
    };

    if (CODE_ONLY_TYPES.has(referenceType)) {
      return { ...base, code: referenceId, label: `${titleCase(referenceType)} ${referenceId}` };
    }

    try {
      switch (referenceType) {
        case 'pos_invoice':
        case 'pos_invoice_extra':
        case 'pos_invoice_writeoff':
        case 'menu_recipe':
        case 'pos_refund':
        case 'pos':
        case 'sales_invoice':
        case 'invoice':
        case 'document':
          return (await this.resolveSale(base, referenceId)) ?? base;
        case 'credit_note':
          return (await this.resolveCreditNote(base, referenceId)) ?? base;
        case 'goods_receipt':
          return (await this.resolveGoodsReceipt(base, referenceId)) ?? base;
        case 'purchase_order':
          return (await this.resolvePurchaseOrder(base, referenceId)) ?? base;
        case 'debit_note':
          return (await this.resolveDebitNote(base, referenceId)) ?? base;
        case 'production_order':
        case 'production_qc':
        case 'production_reversal':
        case 'production_order_cancel':
          return (await this.resolveProductionOrder(base, referenceId)) ?? base;
        case 'work_order':
          return (await this.resolveWorkOrder(base, referenceId)) ?? base;
        case 'agreement':
        case 'rental_checkout':
        case 'rental_return':
        case 'rental_inspect':
          return (await this.resolveRentalAgreement(base, referenceId)) ?? base;
        case 'repair_part_issue':
          return (await this.resolveRepairOrder(base, referenceId)) ?? base;
        case 'stock_out':
          return (await this.resolveStockDoc(base, 'stock_out', referenceId)) ?? base;
        case 'waste':
        case 'expiry_write_off':
          return (await this.resolveStockDoc(base, 'waste', referenceId)) ?? base;
        case 'stock_transfer':
          return (await this.resolveStockDoc(base, 'stock_transfer', referenceId)) ?? base;
        case 'adjustment':
          return (await this.resolveStockDoc(base, 'stock_adjustment', referenceId)) ?? base;
        default:
          return base;
      }
    } catch {
      // A source document we can no longer read must never break the ledger view.
      return base;
    }
  }

  /** Partner display name for a scalar partnerId (these models carry no relation). */
  private async partnerName(partnerId: string | null | undefined): Promise<string | null> {
    if (!partnerId) return null;
    const partner = await this.prisma.client.partner.findFirst({
      where: { id: partnerId },
      select: { name: true },
    });
    return partner?.name ?? null;
  }

  /**
   * POS sale, credit sale and refund all point at a row that may live in either
   * `Invoice` (POS/receipt) or `Document` (back-office invoice) — try both.
   */
  private async resolveSale(base: LedgerSourceRef, id: string): Promise<LedgerSourceRef | null> {
    const invoice = await this.prisma.client.invoice.findFirst({
      where: { id },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        issueDate: true,
        partnerId: true,
      },
    });
    if (invoice) {
      return {
        ...base,
        kind: 'pos_invoice',
        targetId: invoice.id,
        code: invoice.invoiceNumber,
        status: String(invoice.status ?? ''),
        date: invoice.issueDate,
        partnerName: await this.partnerName(invoice.partnerId),
        label: `Sale ${invoice.invoiceNumber}`,
      };
    }

    const doc = await this.prisma.client.document.findFirst({
      where: { id },
      select: {
        id: true,
        documentNumber: true,
        status: true,
        issueDate: true,
        partnerId: true,
      },
    });
    if (doc) {
      return {
        ...base,
        kind: 'invoice',
        targetId: doc.id,
        code: doc.documentNumber,
        status: String(doc.status ?? ''),
        date: doc.issueDate,
        partnerName: await this.partnerName(doc.partnerId),
        label: `Invoice ${doc.documentNumber}`,
      };
    }
    return null;
  }

  private async resolveCreditNote(base: LedgerSourceRef, id: string): Promise<LedgerSourceRef | null> {
    const doc = await this.prisma.client.document.findFirst({
      where: { id },
      select: {
        id: true,
        documentNumber: true,
        status: true,
        issueDate: true,
        partnerId: true,
      },
    });
    if (!doc) return null;
    return {
      ...base,
      kind: 'credit_note',
      targetId: doc.id,
      code: doc.documentNumber,
      status: String(doc.status ?? ''),
      date: doc.issueDate,
      partnerName: await this.partnerName(doc.partnerId),
      label: `Credit Note ${doc.documentNumber}`,
    };
  }

  private async resolveGoodsReceipt(base: LedgerSourceRef, ref: string): Promise<LedgerSourceRef | null> {
    const grn = await this.prisma.client.goodsReceiptNote.findFirst({
      where: { OR: [{ id: ref }, { receiptNumber: ref }] },
      select: {
        id: true,
        receiptNumber: true,
        status: true,
        receivedAt: true,
        partnerId: true,
      },
    });
    if (!grn) return null;
    return {
      ...base,
      kind: 'goods_receipt',
      targetId: grn.id,
      code: grn.receiptNumber,
      status: String(grn.status ?? ''),
      date: grn.receivedAt,
      partnerName: await this.partnerName(grn.partnerId),
      label: `Goods Receipt ${grn.receiptNumber}`,
    };
  }

  private async resolvePurchaseOrder(base: LedgerSourceRef, ref: string): Promise<LedgerSourceRef | null> {
    const po = await this.prisma.client.purchaseOrder.findFirst({
      where: { OR: [{ id: ref }, { orderNumber: ref }] },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        orderDate: true,
        partnerId: true,
      },
    });
    if (!po) return null;
    return {
      ...base,
      kind: 'purchase_order',
      targetId: po.id,
      code: po.orderNumber,
      status: String(po.status ?? ''),
      date: po.orderDate,
      partnerName: await this.partnerName(po.partnerId),
      label: `Purchase Order ${po.orderNumber}`,
    };
  }

  private async resolveDebitNote(base: LedgerSourceRef, ref: string): Promise<LedgerSourceRef | null> {
    const note = await this.prisma.client.debitNote.findFirst({
      where: { OR: [{ id: ref }, { noteNumber: ref }] },
      select: {
        id: true,
        noteNumber: true,
        status: true,
        issueDate: true,
        partnerId: true,
      },
    });
    if (!note) return null;
    return {
      ...base,
      kind: 'debit_note',
      targetId: note.id,
      code: note.noteNumber,
      status: note.status ?? null,
      date: note.issueDate,
      partnerName: await this.partnerName(note.partnerId),
      label: `Debit Note ${note.noteNumber}`,
    };
  }

  private async resolveProductionOrder(base: LedgerSourceRef, ref: string): Promise<LedgerSourceRef | null> {
    const order = await this.prisma.client.productionOrder.findFirst({
      where: { OR: [{ id: ref }, { orderCode: ref }] },
      select: { id: true, orderCode: true, status: true, createdAt: true },
    });
    if (!order) return null;
    return {
      ...base,
      kind: 'production_order',
      targetId: order.id,
      code: order.orderCode,
      status: String(order.status ?? ''),
      date: order.createdAt,
      label: `${titleCase(base.referenceType)} ${order.orderCode}`,
    };
  }

  private async resolveWorkOrder(base: LedgerSourceRef, ref: string): Promise<LedgerSourceRef | null> {
    const wo = await this.prisma.client.workOrder.findFirst({
      where: { id: ref },
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        productionOrderId: true,
      },
    });
    if (!wo) return null;
    const parent = await this.prisma.client.productionOrder.findFirst({
      where: { id: wo.productionOrderId },
      select: { id: true, orderCode: true },
    });
    return {
      ...base,
      // Work orders have no page of their own — land on the parent production order.
      kind: 'production_order',
      targetId: parent?.id ?? null,
      code: parent?.orderCode ?? wo.name,
      status: String(wo.status ?? ''),
      date: wo.createdAt,
      label: `Work Order ${wo.name}`,
    };
  }

  private async resolveRentalAgreement(base: LedgerSourceRef, ref: string): Promise<LedgerSourceRef | null> {
    const agreement = await this.prisma.client.rentalAgreement.findFirst({
      where: { OR: [{ id: ref }, { agreementNumber: ref }] },
      select: {
        id: true,
        agreementNumber: true,
        status: true,
        startAt: true,
        partnerId: true,
      },
    });
    if (!agreement) return null;
    return {
      ...base,
      kind: 'rental_agreement',
      targetId: agreement.id,
      code: agreement.agreementNumber,
      status: String(agreement.status ?? ''),
      date: agreement.startAt,
      partnerName: await this.partnerName(agreement.partnerId),
      label: `Rental ${agreement.agreementNumber}`,
    };
  }

  private async resolveRepairOrder(base: LedgerSourceRef, ref: string): Promise<LedgerSourceRef | null> {
    const order = await this.prisma.client.repairOrder.findFirst({
      where: { OR: [{ id: ref }, { repairNumber: ref }] },
      select: {
        id: true,
        repairNumber: true,
        status: true,
        createdAt: true,
        partnerId: true,
      },
    });
    if (!order) return null;
    return {
      ...base,
      kind: 'repair_order',
      targetId: order.id,
      code: order.repairNumber,
      status: String(order.status ?? ''),
      date: order.createdAt,
      partnerName: await this.partnerName(order.partnerId),
      label: `Repair ${order.repairNumber}`,
    };
  }

  /**
   * Stock-out / waste / adjustment / transfer wrappers post their *code* as the
   * reference, so look up by code first and fall back to id.
   */
  private async resolveStockDoc(
    base: LedgerSourceRef,
    kind: 'stock_out' | 'waste' | 'stock_adjustment' | 'stock_transfer',
    ref: string,
  ): Promise<LedgerSourceRef | null> {
    const finders = {
      stock_out: async () => {
        const d = await this.prisma.client.stockOut.findFirst({
          where: { OR: [{ id: ref }, { outCode: ref }] },
          select: { id: true, outCode: true, status: true, createdAt: true },
        });
        return d && { id: d.id, code: d.outCode, status: String(d.status), date: d.createdAt, label: `Stock Out ${d.outCode}` };
      },
      waste: async () => {
        const d = await this.prisma.client.wasteRecord.findFirst({
          where: { OR: [{ id: ref }, { wasteCode: ref }] },
          select: { id: true, wasteCode: true, status: true, createdAt: true },
        });
        return d && { id: d.id, code: d.wasteCode, status: String(d.status), date: d.createdAt, label: `Waste ${d.wasteCode}` };
      },
      stock_adjustment: async () => {
        const d = await this.prisma.client.stockAdjustment.findFirst({
          where: { OR: [{ id: ref }, { adjCode: ref }] },
          select: { id: true, adjCode: true, status: true, createdAt: true },
        });
        return d && { id: d.id, code: d.adjCode, status: String(d.status), date: d.createdAt, label: `Adjustment ${d.adjCode}` };
      },
      stock_transfer: async () => {
        const d = await this.prisma.client.stockTransfer.findFirst({
          where: { OR: [{ id: ref }, { transferCode: ref }] },
          select: { id: true, transferCode: true, status: true, createdAt: true },
        });
        return d && { id: d.id, code: d.transferCode, status: String(d.status), date: d.createdAt, label: `Transfer ${d.transferCode}` };
      },
    };

    const found = await finders[kind]();
    if (!found) return null;
    return {
      ...base,
      kind,
      targetId: found.id,
      code: found.code,
      status: found.status,
      date: found.date,
      label: found.label,
    };
  }
}
