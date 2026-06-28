/**
 * POS T5 — Print Lifecycle Service.
 *
 * Single source of truth for all document-print events:
 *   KOT  → kitchen tickets (KDS) + optional ESC/POS KOT printer
 *   BILL → customer preview (ESC/POS)
 *   RECEIPT → legal payment proof (ESC/POS)
 *   CANCEL → kitchen cancellation tickets
 *
 * Every print is recorded in DocumentPrintLog for audit. Idempotency keys
 * prevent duplicate prints on network retry.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { SettingsService } from '../../kernel/settings/settings.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';

export interface PrintLogInput {
  organizationId: string;
  documentId: string;
  documentLineId?: string;
  type: 'KOT' | 'BILL' | 'RECEIPT' | 'CANCEL';
  action?: 'PRINT' | 'REPRINT';
  copies?: number;
  printedById?: string;
  reason?: string;
  printer?: string;
  idempotencyKey?: string;
}

export interface KitchenDelta {
  addLines: Array<{ line: any; delta: number }>;
  removeLines: Array<{ line: any; delta: number }>;
  unchangedLines: Array<{ line: any }>;
}

@Injectable()
export class PosPrintLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly tenant: TenantContextService,
  ) {}

  /* ─────────── KOT helpers ─────────── */

  async markKitchenPrinted(
    tx: any,
    lineIds: string[],
    qtyMap: Map<string, number>,
    userId?: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (!lineIds.length) return;
    const now = new Date();
    await tx.documentLine.updateMany({
      where: { id: { in: lineIds } },
      data: {
        kitchenPrintCount: { increment: 1 },
        kitchenLastPrintedAt: now,
        lastKitchenPrintedById: userId ?? null,
      },
    });
    for (const lid of lineIds) {
      const qty = qtyMap.get(lid);
      if (qty != null) {
        await tx.documentLine.update({
          where: { id: lid },
          data: { kitchenPrintedQty: qty },
        });
      }
    }
  }

  async markCancelPrinted(
    tx: any,
    lineIds: string[],
    userId?: string,
  ): Promise<void> {
    if (!lineIds.length) return;
    await tx.documentLine.updateMany({
      where: { id: { in: lineIds } },
      data: {
        cancelPrintCount: { increment: 1 },
        cancelLastPrintedAt: new Date(),
        lastKitchenPrintedById: userId ?? null,
      },
    });
  }

  async getUnprintedLines(
    tx: any,
    documentId: string,
  ): Promise<any[]> {
    return tx.documentLine.findMany({
      where: {
        documentId,
        kitchenLastPrintedAt: null,
      },
      orderBy: { lineNumber: 'asc' },
    });
  }

  /**
   * Compute kitchen deltas between current line quantities and the last
   * printed quantities stored in `kitchenPrintedQty`.
   */
  async getKitchenDeltas(
    tx: any,
    documentId: string,
  ): Promise<KitchenDelta> {
    const lines = await tx.documentLine.findMany({
      where: { documentId },
      orderBy: { lineNumber: 'asc' },
    });

    const addLines: KitchenDelta['addLines'] = [];
    const removeLines: KitchenDelta['removeLines'] = [];
    const unchangedLines: KitchenDelta['unchangedLines'] = [];

    for (const ln of lines) {
      const currentQty = Number(ln.quantity);
      const printedQty = ln.kitchenPrintedQty != null ? Number(ln.kitchenPrintedQty) : 0;

      if (ln.kitchenLastPrintedAt == null) {
        // Never printed — full qty is new
        addLines.push({ line: ln, delta: currentQty });
      } else if (currentQty > printedQty) {
        addLines.push({ line: ln, delta: currentQty - printedQty });
      } else if (currentQty < printedQty) {
        removeLines.push({ line: ln, delta: printedQty - currentQty });
      } else {
        unchangedLines.push({ line: ln });
      }
    }

    return { addLines, removeLines, unchangedLines };
  }

  /* ──── Target detection ──── */

  /**
   * Return the table name ('invoice' | 'document') for a given record,
   * so print-lifecycle methods can target the correct model.
   */
  private async resolvePrintTarget(
    tx: any,
    recordId: string,
  ): Promise<'invoice' | 'document'> {
    const inv = await tx.invoice.findFirst({ where: { id: recordId }, select: { id: true } });
    if (inv) return 'invoice';
    return 'document';
  }

  /* ─────────── Bill helpers ─────────── */

  async markBillPrinted(
    tx: any,
    recordId: string,
    userId?: string,
  ): Promise<void> {
    const target = await this.resolvePrintTarget(tx, recordId);
    if (target === 'invoice') {
      await tx.invoice.update({
        where: { id: recordId },
        data: {
          billPrintCount: { increment: 1 },
          billLastPrintedAt: new Date(),
          lastPrintedById: userId ?? null,
        },
      });
    } else {
      await tx.document.update({
        where: { id: recordId },
        data: {
          billPrintCount: { increment: 1 },
          billLastPrintedAt: new Date(),
          lastPrintedById: userId ?? null,
        },
      });
    }
  }

  async markLinesBilled(
    tx: any,
    recordId: string,
    userId?: string,
  ): Promise<void> {
    const target = await this.resolvePrintTarget(tx, recordId);
    if (target === 'invoice') {
      // Invoice items have no bill-printed-at field; skip for Invoice model.
      return;
    }
    await tx.documentLine.updateMany({
      where: { documentId: recordId, billPrintedAt: null },
      data: { billPrintedAt: new Date() },
    });
  }

  async getBillCopyNumber(
    tx: any,
    recordId: string,
  ): Promise<number> {
    const target = await this.resolvePrintTarget(tx, recordId);
    if (target === 'invoice') {
      const inv = await tx.invoice.findUnique({ where: { id: recordId }, select: { billPrintCount: true } });
      return (inv?.billPrintCount ?? 0) + 1;
    }
    const doc = await tx.document.findUnique({
      where: { id: recordId },
      select: { billPrintCount: true },
    });
    return (doc?.billPrintCount ?? 0) + 1;
  }

  /* ─────────── Receipt helpers ─────────── */

  async markReceiptPrinted(
    tx: any,
    recordId: string,
    userId?: string,
    idempotencyKey?: string,
  ): Promise<void> {
    const target = await this.resolvePrintTarget(tx, recordId);
    if (target === 'invoice') {
      await tx.invoice.update({
        where: { id: recordId },
        data: {
          receiptPrintCount: { increment: 1 },
          receiptLastPrintedAt: new Date(),
          lastPrintedById: userId ?? null,
        },
      });
    } else {
      await tx.document.update({
        where: { id: recordId },
        data: {
          receiptPrintCount: { increment: 1 },
          receiptLastPrintedAt: new Date(),
          lastPrintedById: userId ?? null,
        },
      });
    }
  }

  async getReceiptCopyNumber(
    tx: any,
    recordId: string,
  ): Promise<number> {
    const target = await this.resolvePrintTarget(tx, recordId);
    if (target === 'invoice') {
      const inv = await tx.invoice.findUnique({ where: { id: recordId }, select: { receiptPrintCount: true } });
      return (inv?.receiptPrintCount ?? 0) + 1;
    }
    const doc = await tx.document.findUnique({
      where: { id: recordId },
      select: { receiptPrintCount: true },
    });
    return (doc?.receiptPrintCount ?? 0) + 1;
  }

  async getKotCopyNumber(
    tx: any,
    recordId: string,
  ): Promise<number> {
    const target = await this.resolvePrintTarget(tx, recordId);
    if (target === 'invoice') {
      const inv = await tx.invoice.findUnique({ where: { id: recordId }, select: { kotPrintCount: true } });
      return (inv?.kotPrintCount ?? 0) + 1;
    }
    const doc = await tx.document.findUnique({
      where: { id: recordId },
      select: { kotPrintCount: true },
    });
    return (doc?.kotPrintCount ?? 0) + 1;
  }

  async markKotPrinted(
    tx: any,
    recordId: string,
    userId?: string,
  ): Promise<void> {
    const target = await this.resolvePrintTarget(tx, recordId);
    if (target === 'invoice') {
      await tx.invoice.update({
        where: { id: recordId },
        data: {
          kotPrintCount: { increment: 1 },
          lastPrintedById: userId ?? null,
        },
      });
    } else {
      await tx.document.update({
        where: { id: recordId },
        data: {
          kotPrintCount: { increment: 1 },
          lastPrintedById: userId ?? null,
        },
      });
    }
  }

  /* ─────────── Print log ─────────── */

  async recordPrintLog(tx: any, input: PrintLogInput): Promise<void> {
    // R2: the print log's documentId FK is required-by-history but POS prints
    // reference the separate Invoice. Route the id to the right column so the
    // log row is written without violating the Document FK.
    const target = await this.resolvePrintTarget(tx, input.documentId);
    await tx.documentPrintLog.create({
      data: {
        organizationId: input.organizationId,
        documentId: target === 'document' ? input.documentId : null,
        invoiceId: target === 'invoice' ? input.documentId : null,
        documentLineId: input.documentLineId ?? null,
        type: input.type,
        action: input.action ?? 'PRINT',
        copies: input.copies ?? 1,
        printedById: input.printedById ?? null,
        reason: input.reason ?? null,
        printer: input.printer ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });
  }

  /* ─────────── Printer settings ─────────── */

  async getPrinterSettings(type: 'kot' | 'bill' | 'receipt'): Promise<{ host: string; port: number } | null> {
    const key = `pos.printerHost`;
    const host = await this.settings.get(key);
    if (!host || typeof host !== 'string') return null;
    const port = Number(await this.settings.get(`pos.printerPort`) ?? 9100);
    return { host, port };
  }
}
