/**
 * POS Phase B — Receipts (Sprint P3).
 *
 *   - PdfBackend     → generates a PDF receipt via pdfkit (already used in the
 *                      school vertical for report cards). Always available;
 *                      no external service needed.
 *   - EmailBackend   → sends the PDF to the customer's email via the existing
 *                      NotificationService.
 *   - EscPosBackend  → prints to a thermal ESC/POS printer over the network
 *                      (default 9100). Configured per org via Setting rows.
 *                      Stubs to a console-log fallback if `node-thermal-printer`
 *                      is not installed — the cashier still sees a "printed"
 *                      event so the receipt flow is never blocked on hardware.
 *
 * Endpoints exposed by PosReceiptsController:
 *   GET  /pos/receipts/:invoiceId/pdf       → PDF stream (pdfkit)
 *   GET  /pos/receipts/:invoiceId/text      → plain-text receipt (for ESC/POS)
 *   POST /pos/receipts/:invoiceId/print     → ESC/POS print (or fallback)
 *   POST /pos/receipts/:invoiceId/email     → email PDF to the invoice's partner
 *   POST /pos/receipts/:invoiceId/reprint   → alias of /print + audit row
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Header, NotFoundException,
  Param, Post, Query, Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import PDFDocument = require('pdfkit');
import { Injectable, Module } from '@nestjs/common';

class ReprintDto {
  @IsString()
  reason!: string;  // REQUIRED: Admin/Manager must provide a reason for reprint
}
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { NotificationsService } from '../../kernel/notifications/notifications.service';
import { SettingsService } from '../../kernel/settings/settings.service';
import { PosPrintLifecycleService } from './pos-print-lifecycle.service';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { dec, round, ZERO } from '../../kernel/common/money';

const fmt = (n: number | string | Prisma.Decimal | null | undefined) =>
  `UGX ${Number(n || 0).toLocaleString()}`;

/* ============================== SERVICE ============================== */

@Injectable()
export class PosReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly printLifecycle: PosPrintLifecycleService,
  ) {}

  /** Resolve the invoice + lines + partner for a receipt, scoped to the tenant. */
  async resolveInvoice(invoiceId: string) {
    const orgId = this.tenant.organizationId;
    const invoice = await this.prisma.client.document.findFirst({
      where: { id: invoiceId, organizationId: orgId, documentType: 'sales_invoice' },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    const [partner, lines, productMap] = await Promise.all([
      this.prisma.client.partner.findFirst({ where: { id: invoice.partnerId } }),
      this.prisma.client.documentLine.findMany({
        where: { documentId: invoiceId },
        orderBy: { lineNumber: 'asc' },
      }),
      // Resolve products for receipt display.
      this.resolveProductsForLines(invoiceId),
    ]);
    const linesWithProducts = lines.map((ln: any) => ({
      ...ln,
      product: ln.productId ? productMap.get(ln.productId) : null,
    }));
    return { ...invoice, partner, lines: linesWithProducts };
  }

  private async resolveProductsForLines(invoiceId: string): Promise<Map<string, any>> {
    const orgId = this.tenant.organizationId;
    const lines = await this.prisma.client.documentLine.findMany({
      where: { documentId: invoiceId },
      select: { productId: true },
    });
    const productIds = Array.from(new Set(lines.map((l: any) => l.productId).filter(Boolean))) as string[];
    if (productIds.length === 0) return new Map();
    const products = await this.prisma.client.product.findMany({
      where: { id: { in: productIds }, organizationId: orgId },
    });
    return new Map((products as any[]).map((p) => [p.id, p]));
  }

  /** Resolve the org name + address for the receipt header. */
  async resolveOrg() {
    const orgId = this.tenant.organizationId;
    const org = await this.prisma.raw.organization.findUnique({ where: { id: orgId } });
    return org;
  }

  /** Plain-text receipt — used for ESC/POS printers and a "download .txt" option. */
  async buildTextReceipt(invoiceId: string, isReprint = false): Promise<string> {
    const inv = await this.resolveInvoice(invoiceId);
    const org = await this.resolveOrg();
    const lines: string[] = [];
    if (isReprint) lines.push('*** REPRINT COPY ***');
    lines.push((org?.name ?? 'Cafe').toUpperCase());
    lines.push(org?.code ?? '');
    lines.push('--------------------------------');
    lines.push(`Receipt: ${(inv as any).documentNumber}`);
    lines.push(`Date:    ${new Date(inv.issueDate).toLocaleString()}`);
    lines.push(`Cashier: ${(inv as any).createdBy ?? '—'}`);
    if ((inv as any).partner?.name) lines.push(`Customer: ${(inv as any).partner.name}`);
    lines.push('--------------------------------');
    for (const ln of inv.lines) {
      const qty = Number(ln.quantity);
      const price = Number(ln.unitPrice);
      const disc = Number(ln.discountPercent ?? 0);
      const lineTotal = qty * price * (1 - disc / 100);
      const label = `${qty} × ${fmt(price)}`;
      const inclTag = (ln as any).taxInclusive ? ' (incl)' : '';
      lines.push(`${(ln.description + inclTag).padEnd(20).slice(0, 20)} ${fmt(lineTotal).padStart(10)}`);
      if (disc > 0) lines.push(`  (discount ${disc}%)`);
      if (ln.note) lines.push(`  ! ${ln.note}`);
    }
    lines.push('--------------------------------');
    lines.push(`Subtotal: ${fmt(inv.subtotal)}`);
    if (Number(inv.discountTotal) > 0) lines.push(`Discount: -${fmt(inv.discountTotal)}`);
    lines.push(`Tax:      ${fmt(inv.taxAmount)}`);
    lines.push(`TOTAL:    ${fmt(inv.totalAmount)}`);
    lines.push(`Paid:     ${fmt(inv.amountPaid)}`);
    if (Number(inv.amountResidual) > 0) lines.push(`Due:      ${fmt(inv.amountResidual)}`);
    lines.push('--------------------------------');
    lines.push('Thank you!');
    return lines.join('\n');
  }

  /** PDF receipt — pdfkit stream. */
  async buildPdfReceipt(invoiceId: string, isReprint = false): Promise<Buffer> {
    const inv = await this.resolveInvoice(invoiceId);
    const org = await this.resolveOrg();
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: [226, 600], margin: 8 }); // 80mm thermal
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      if (isReprint) doc.font('Helvetica-Bold').fontSize(10).text('*** REPRINT COPY ***', { align: 'center' });
      doc.font('Helvetica-Bold').fontSize(14).text(org?.name ?? 'Cafe', { align: 'center' });
      doc.font('Helvetica').fontSize(8).text(org?.code ?? '', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(9).text('--------------------------------');
      doc.text(`Receipt: ${(inv as any).documentNumber}`);
      doc.text(`Date:    ${new Date(inv.issueDate).toLocaleString()}`);
      doc.text(`Cashier: ${(inv as any).createdBy ?? '—'}`);
      if (inv.partner?.name) doc.text(`Customer: ${inv.partner.name}`);
      doc.text('--------------------------------');
      doc.moveDown(0.3);

      for (const ln of inv.lines) {
        const qty = Number(ln.quantity);
        const price = Number(ln.unitPrice);
        const disc = Number(ln.discountPercent ?? 0);
        const lineTotal = qty * price * (1 - disc / 100);
        // P10: tag tax-inclusive lines so the customer can see why the
        // sub-total already includes VAT.
        const inclTag = (ln as any).taxInclusive ? '  (incl. tax)' : '';
        doc.font('Helvetica').text(`${ln.description}${inclTag}`);
        doc.font('Helvetica').fontSize(8).text(`  ${qty} × ${fmt(price)}${disc > 0 ? ` (-${disc}%)` : ''}`, { continued: true });
        doc.text(fmt(lineTotal), { align: 'right' });
        if ((ln as any).note) doc.font('Helvetica-Oblique').fontSize(7).text(`  ! ${(ln as any).note}`);
      }

      doc.font('Helvetica').fontSize(9).text('--------------------------------');
      doc.text(`Subtotal:  ${fmt(inv.subtotal)}`, { align: 'right' });
      if (Number(inv.discountTotal) > 0) doc.text(`Discount: -${fmt(inv.discountTotal)}`, { align: 'right' });
      doc.text(`Tax:       ${fmt(inv.taxAmount)}`, { align: 'right' });
      doc.font('Helvetica-Bold').fontSize(12).text(`TOTAL:     ${fmt(inv.totalAmount)}`, { align: 'right' });
      doc.font('Helvetica').fontSize(9).text(`Paid:      ${fmt(inv.amountPaid)}`, { align: 'right' });
      if (Number(inv.amountResidual) > 0) doc.text(`Due:       ${fmt(inv.amountResidual)}`, { align: 'right' });
      doc.moveDown(0.5);
      doc.text('--------------------------------');
      doc.fontSize(10).text('Thank you!', { align: 'center' });
      doc.end();
    });
  }

  /**
   * Send the receipt to the customer's email via the existing NotificationService.
   * Returns { ok: true, sentTo } on success.
   */
  async emailReceipt(invoiceId: string): Promise<{ ok: boolean; sentTo?: string; message?: string }> {
    const inv = await this.resolveInvoice(invoiceId);
    const customerEmail = (inv as any).partner?.email;
    if (!customerEmail) {
      return { ok: false, message: 'Customer has no email on file. Add one in Partners.' };
    }
    const orgId = this.tenant.organizationId;
    const pdf = await this.buildPdfReceipt(invoiceId);
    const text = await this.buildTextReceipt(invoiceId);
    await this.notifications.send({
      organizationId: orgId,
      channel: 'email',
      category: 'transactional',
      title: `Receipt ${(inv as any).documentNumber}`,
      body: text,
      payload: {
        kind: 'pos_receipt',
        invoiceId,
        invoiceNumber: (inv as any).documentNumber,
        attachment: {
          filename: `receipt-${(inv as any).documentNumber}.pdf`,
          contentType: 'application/pdf',
          data: pdf.toString('base64'),
        },
      },
    });
    await this.printLifecycle.markReceiptPrinted(this.prisma.client, invoiceId, this.tenant.userId ?? undefined);
    await this.printLifecycle.recordPrintLog(this.prisma.client, {
      organizationId: orgId,
      documentId: invoiceId,
      type: 'RECEIPT',
      action: 'PRINT',
      printedById: this.tenant.userId ?? undefined,
    });
    await this.audit.record({
      entity: 'Document',
      entityId: invoiceId,
      action: 'update',
      newValues: { receiptEmailedTo: customerEmail },
    });
    return { ok: true, sentTo: customerEmail };
  }

  /**
   * Pre-payment bill preview (text). Same format as a receipt but labelled BILL.
   * Used for dine-in tables before settling.
   */
  async buildTextBill(invoiceId: string, isReprint = false): Promise<string> {
    const inv = await this.resolveInvoice(invoiceId);
    const org = await this.resolveOrg();
    const lines: string[] = [];
    if (isReprint) lines.push('*** REPRINT COPY ***');
    lines.push((org?.name ?? 'Cafe').toUpperCase());
    lines.push('=============== BILL ===============');
    lines.push(`Table bill: ${(inv as any).documentNumber}`);
    lines.push(`Date:       ${new Date(inv.issueDate).toLocaleString()}`);
    lines.push('--------------------------------');
    for (const ln of inv.lines) {
      const qty = Number(ln.quantity);
      const price = Number(ln.unitPrice);
      const disc = Number(ln.discountPercent ?? 0);
      const lineTotal = qty * price * (1 - disc / 100);
      const label = `${qty} × ${fmt(price)}`;
      lines.push(`${(ln.description).padEnd(20).slice(0, 20)} ${fmt(lineTotal).padStart(10)}`);
      if (disc > 0) lines.push(`  (discount ${disc}%)`);
      if (ln.note) lines.push(`  ! ${ln.note}`);
    }
    lines.push('--------------------------------');
    lines.push(`Subtotal: ${fmt(inv.subtotal)}`);
    if (Number(inv.discountTotal) > 0) lines.push(`Discount: -${fmt(inv.discountTotal)}`);
    lines.push(`TOTAL:    ${fmt(inv.totalAmount)}`);
    lines.push('--------------------------------');
    lines.push('Thank you for your patience!');
    return lines.join('\n');
  }

  /**
   * Assert the current user has an Admin or Manager role — required for
   * reprinting bills and receipts. Cashiers and other roles are forbidden.
   * Throws ForbiddenException if the check fails.
   */
  private async assertCanReprint(userId: string | undefined): Promise<void> {
    if (!userId) throw new ForbiddenException('Authentication required for reprint');
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId, organizationId: this.tenant.organizationId },
      include: { roles: true },
    });
    if (!user) throw new ForbiddenException('User not found');
    const roleNames = user.roles.map((r: any) => (r.name ?? '').toLowerCase());
    const isAdminOrManager = roleNames.some(
      (n: string) => n.includes('admin') || n.includes('manager'),
    );
    if (!isAdminOrManager) {
      throw new ForbiddenException(
        'Only Admin/Manager can reprint bills and receipts. Record a reason in the audit log.',
      );
    }
  }

  /**
   * Print a pre-payment bill (ESC/POS). Updates bill lifecycle counters.
   * First print is free; reprints require Admin/Manager via the reprint-bill endpoint.
   */
  async printBill(invoiceId: string, userId?: string, isReprint = false): Promise<{ ok: boolean; backend: string; message?: string }> {
    if (!isReprint) {
      const doc = await this.prisma.client.document.findFirst({
        where: { id: invoiceId, organizationId: this.tenant.organizationId },
        select: { billPrintCount: true },
      });
      if (doc && (doc.billPrintCount ?? 0) > 0) {
        throw new ForbiddenException(
          'Bill already printed. Use the reprint endpoint (Admin/Manager only, with a reason).',
        );
      }
    }

    const text = await this.buildTextBill(invoiceId, isReprint);
    const orgId = this.tenant.organizationId;

    await this.printLifecycle.markBillPrinted(this.prisma.client, invoiceId, userId);

    // Mark every current line as included on this bill so additional-bill
    // logic can later identify which items are genuinely new.
    await this.printLifecycle.markLinesBilled(this.prisma.client, invoiceId, userId);

    const hostSetting = await this.settings.get('pos.printerHost');
    const portSetting = await this.settings.get('pos.printerPort');
    const host = hostSetting?.value;
    const port = portSetting?.value ? Number(portSetting.value) : 9100;

    if (!host) {
      console.log('[POS] No printer configured; bill text:\n' + text);
      await this.printLifecycle.recordPrintLog(this.prisma.client, {
        organizationId: orgId,
        documentId: invoiceId,
        type: 'BILL',
        printedById: userId,
      });
      return { ok: true, backend: 'console', message: 'No printer configured; bill logged to server console.' };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const net = require('net');
      await new Promise<void>((resolve, reject) => {
        const client = net.connect({ host, port, timeout: 5000 }, () => {
          client.write(text + '\n\n\n\n\n');
          client.end();
        });
        client.on('end', resolve);
        client.on('error', reject);
        client.on('timeout', () => { client.destroy(); reject(new Error('printer timeout')); });
      });
      await this.printLifecycle.recordPrintLog(this.prisma.client, {
        organizationId: orgId,
        documentId: invoiceId,
        type: 'BILL',
        printedById: userId,
      });
      return { ok: true, backend: 'escpos' };
    } catch (e: any) {
      console.log('[POS] Printer unreachable; falling back to console. Bill:\n' + text);
      return { ok: false, backend: 'escpos', message: e?.message ?? 'printer error; bill logged to console' };
    }
  }

  /** Fetch only the lines that have NOT yet appeared on a printed bill. */
  private async getUnbilledLines(invoiceId: string): Promise<any[]> {
    const orgId = this.tenant.organizationId;
    return this.prisma.client.documentLine.findMany({
      where: { documentId: invoiceId, organizationId: orgId, billPrintedAt: null },
      orderBy: { lineNumber: 'asc' },
    });
  }

  /**
   * Build text for a kitchen order ticket (KOT) — delta only.
   *
   * @param invoiceId   The document to print for.
   * @param kotNumber   Sequential KOT copy number (1 = initial, 2+ = additional).
   * @param addLines    Items to add (new or increased qty).
   * @param removeLines Items to cancel (decreased qty).
   */
  async buildTextKot(
    invoiceId: string,
    kotNumber: number,
    addLines: Array<{ line: any; delta: number }>,
    removeLines: Array<{ line: any; delta: number }>,
  ): Promise<string> {
    const inv = await this.resolveInvoice(invoiceId);
    const org = await this.resolveOrg();
    const lines: string[] = [];
    const isInitial = kotNumber <= 1 && removeLines.length === 0;
    if (isInitial) {
      lines.push((org?.name ?? 'Cafe').toUpperCase());
      lines.push(`******** KOT #${String(kotNumber).padStart(3, '0')} ********`);
    } else {
      lines.push((org?.name ?? 'Cafe').toUpperCase());
      lines.push('******** ADDITIONAL KOT ********');
      lines.push(`KOT #${String(kotNumber).padStart(3, '0')}`);
    }
    lines.push(`Order: ${(inv as any).documentNumber}`);
    lines.push(`Date:  ${new Date(inv.issueDate).toLocaleString()}`);
    lines.push('--------------------------------');

    for (const { line, delta } of addLines) {
      const qty = Number(line.quantity);
      const price = Number(line.unitPrice);
      const name = (line.description ?? '').padEnd(20).slice(0, 20);
      if (delta >= qty) {
        lines.push(`${name} x${qty}`);
      } else {
        lines.push(`${name} +${delta}`);
      }
      if (line.note) lines.push(`  ! ${line.note}`);
    }

    for (const { line, delta } of removeLines) {
      const name = (line.description ?? '').padEnd(20).slice(0, 20);
      lines.push(`CANCEL ${name} -${delta}`);
    }

    if (addLines.length === 0 && removeLines.length === 0) {
      lines.push('  (no changes)');
    }

    lines.push('--------------------------------');
    lines.push('Prepare and serve with care');
    return lines.join('\n');
  }

  /**
   * Build text for a kitchen cancellation ticket (void / reduce).
   */
  async buildTextCancelKot(
    invoiceId: string,
    kotNumber: number,
    removeLines: Array<{ line: any; delta: number }>,
  ): Promise<string> {
    const inv = await this.resolveInvoice(invoiceId);
    const org = await this.resolveOrg();
    const lines: string[] = [];
    lines.push((org?.name ?? 'Cafe').toUpperCase());
    lines.push(`******** CANCEL KOT #${String(kotNumber).padStart(3, '0')} ********`);
    lines.push(`Order: ${(inv as any).documentNumber}`);
    lines.push(`Date:  ${new Date(inv.issueDate).toLocaleString()}`);
    lines.push('--------------------------------');

    for (const { line, delta } of removeLines) {
      const name = (line.description ?? '').padEnd(20).slice(0, 20);
      lines.push(`CANCEL ${name} -${delta}`);
    }

    lines.push('--------------------------------');
    lines.push('VOID / REDUCE');
    return lines.join('\n');
  }

  /**
   * Build text for an additional bill — only items that have never appeared
   * on a previously-printed bill. Designed for the "Print Additional Bill"
   * flow: customer adds more items after the initial bill was already printed.
   *
   * Output includes:
   *   - Only the newly-added (unbilled) items
   *   - Additional subtotal
   *   - Previous subtotal (from already-billed lines)
   *   - Grand Total Due (full document total with tax/discounts applied)
   */
  async buildTextAdditionalBill(invoiceId: string, copyNumber = 1): Promise<{ text: string; grandTotal: number; additionalSubtotal: number; previousSubtotal: number }> {
    const inv = await this.resolveInvoice(invoiceId);
    const org = await this.resolveOrg();
    const unbilled = await this.getUnbilledLines(invoiceId);

    const lines: string[] = [];
    lines.push((org?.name ?? 'Cafe').toUpperCase());
    lines.push('========= ADDITIONAL BILL =========');
    lines.push(`Table bill: ${(inv as any).documentNumber}`);
    if (copyNumber > 1) lines.push(`Copy #:    ${copyNumber}`);
    lines.push(`Date:       ${new Date(inv.issueDate).toLocaleString()}`);
    lines.push('--------------------------------');

    let additionalSubtotal = 0;
    for (const ln of unbilled) {
      const qty = Number(ln.quantity);
      const price = Number(ln.unitPrice);
      const disc = Number(ln.discountPercent ?? 0);
      const lineTotal = qty * price * (1 - disc / 100);
      additionalSubtotal += lineTotal;
      lines.push(`${(ln.description).padEnd(20).slice(0, 20)} ${fmt(lineTotal).padStart(10)}`);
      if (disc > 0) lines.push(`  (discount ${disc}%)`);
      if (ln.note) lines.push(`  ! ${ln.note}`);
    }

    if (unbilled.length === 0) {
      lines.push('  (no additional items)');
    }

    const previousSubtotal = Math.max(0, Number(inv.subtotal) - additionalSubtotal);
    const grandTotal = Number(inv.totalAmount);

    lines.push('================================');
    lines.push(`Additional Total:   ${fmt(additionalSubtotal)}`);
    lines.push(`Previous Total:     ${fmt(previousSubtotal)}`);
    lines.push('================================');
    lines.push(`Grand Total Due:    ${fmt(grandTotal)}`);
    lines.push('--------------------------------');
    lines.push('Thank you for your patience!');
    return { text: lines.join('\n'), grandTotal, additionalSubtotal, previousSubtotal };
  }

  /**
   * Print an Additional Bill — only items not yet included on any previous
   * bill print. Marks those items as billed so subsequent additional-bill
   * calls only surface genuinely new additions.
   */
  async printAdditionalBill(invoiceId: string, userId?: string): Promise<{ ok: boolean; backend: string; message?: string; copyNumber: number; grandTotal: number; additionalSubtotal: number; previousSubtotal: number }> {
    const orgId = this.tenant.organizationId;

    // Determine next copy number before anything else.
    const doc = await this.prisma.client.document.findFirst({
      where: { id: invoiceId, organizationId: orgId },
      select: { billPrintCount: true },
    });
    const copyNumber = (doc?.billPrintCount ?? 0) + 1;

    const unbilled = await this.getUnbilledLines(invoiceId);
    if (unbilled.length === 0) {
      throw new BadRequestException('No additional items to bill. All items have already appeared on a previous bill.');
    }

    const { text: additionalBillText, grandTotal, additionalSubtotal, previousSubtotal } = await this.buildTextAdditionalBill(invoiceId, copyNumber);

    // Increment the document-level bill counter and timestamp.
    await this.printLifecycle.markBillPrinted(this.prisma.client, invoiceId, userId);
    // Mark only the newly-billed lines so they are excluded next time.
    await this.printLifecycle.markLinesBilled(this.prisma.client, invoiceId, userId);

    const hostSetting = await this.settings.get('pos.printerHost');
    const portSetting = await this.settings.get('pos.printerPort');
    const host = hostSetting?.value;
    const port = portSetting?.value ? Number(portSetting.value) : 9100;

    if (!host) {
      console.log('[POS] No printer configured; additional bill text:\n' + additionalBillText);
      await this.printLifecycle.recordPrintLog(this.prisma.client, {
        organizationId: orgId,
        documentId: invoiceId,
        type: 'BILL',
        action: 'PRINT',
        copies: 1,
        printedById: userId,
      });
      return { ok: true, backend: 'console', message: 'No printer configured; additional bill logged to server console.', copyNumber, grandTotal, additionalSubtotal, previousSubtotal };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const net = require('net');
      await new Promise<void>((resolve, reject) => {
        const client = net.connect({ host, port, timeout: 5000 }, () => {
          client.write(additionalBillText + '\n\n\n\n\n');
          client.end();
        });
        client.on('end', resolve);
        client.on('error', reject);
        client.on('timeout', () => { client.destroy(); reject(new Error('printer timeout')); });
      });
      await this.printLifecycle.recordPrintLog(this.prisma.client, {
        organizationId: orgId,
        documentId: invoiceId,
        type: 'BILL',
        action: 'PRINT',
        copies: 1,
        printedById: userId,
      });
      return { ok: true, backend: 'escpos', copyNumber, grandTotal, additionalSubtotal, previousSubtotal };
    } catch (e: any) {
      console.log('[POS] Printer unreachable; falling back to console. Additional bill:\n' + additionalBillText);
      return { ok: false, backend: 'escpos', message: e?.message ?? 'printer error; additional bill logged to console', copyNumber, grandTotal, additionalSubtotal, previousSubtotal };
    }
  }

  /**
   * Print the receipt to a thermal ESC/POS printer.
   *
   * Looks up printer IP from settings (`pos.printerHost`, `pos.printerPort`).
   * Falls back to logging the text receipt if no printer is configured or
   * if the `node-thermal-printer` package isn't installed.
   */
  async printReceipt(invoiceId: string, userId?: string, isReprint = false): Promise<{ ok: boolean; backend: string; message?: string }> {
    const inv = await this.resolveInvoice(invoiceId);
    const text = await this.buildTextReceipt(invoiceId, isReprint);

    // Record lifecycle before print attempt.
    await this.printLifecycle.markReceiptPrinted(this.prisma.client, invoiceId, userId);

    // Read printer settings.
    const orgId = this.tenant.organizationId;
    const hostSetting = await this.settings.get('pos.printerHost');
    const portSetting = await this.settings.get('pos.printerPort');
    const host = hostSetting?.value;
    const port = portSetting?.value ? Number(portSetting.value) : 9100;

    if (!host) {
      console.log('[POS] No printer configured; receipt text:\n' + text);
      await this.printLifecycle.recordPrintLog(this.prisma.client, {
        organizationId: orgId,
        documentId: invoiceId,
        type: 'RECEIPT',
        printedById: userId,
      });
      return { ok: true, backend: 'console', message: 'No printer configured; receipt logged to server console.' };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const net = require('net');
      const settings = await this.settings.get('pos.kickDrawerOnPrint');
      const shouldKick = settings?.value !== 'false';
      await new Promise<void>((resolve, reject) => {
        const client = net.connect({ host, port, timeout: 5000 }, () => {
          client.write(text + '\n\n\n\n\n');
          if (shouldKick) {
            client.write(Buffer.from([0x1B, 0x70, 0x00, 0x19, 0xFA]));
          }
          client.end();
        });
        client.on('end', resolve);
        client.on('error', reject);
        client.on('timeout', () => { client.destroy(); reject(new Error('printer timeout')); });
      });
      await this.printLifecycle.recordPrintLog(this.prisma.client, {
        organizationId: orgId,
        documentId: invoiceId,
        type: 'RECEIPT',
        printedById: userId,
      });
      return { ok: true, backend: 'escpos' };
    } catch (e: any) {
      console.log('[POS] Printer unreachable; falling back to console. Receipt:\n' + text);
      return { ok: false, backend: 'escpos', message: e?.message ?? 'printer error; receipt logged to console' };
    }
  }
}

/* ============================== CONTROLLER ============================== */

@ApiTags('pos/receipts')
@ApiBearerAuth()
@Controller('pos/receipts')
export class PosReceiptsController {
  constructor(private readonly svc: PosReceiptsService) {}

  @Get(':invoiceId/pdf')
  @RequirePermissions('pos:read')
  async pdf(@Param('invoiceId') id: string, @Res() res: Response) {
    const buf = await this.svc.buildPdfReceipt(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receipt-${id}.pdf"`);
    res.send(buf);
  }

  @Get(':invoiceId/text')
  @RequirePermissions('pos:read')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async text(@Param('invoiceId') id: string) {
    return this.svc.buildTextReceipt(id);
  }

  @Post(':invoiceId/print')
  @RequirePermissions('pos:checkout')
  async print(@Param('invoiceId') id: string) {
    return this.svc.printReceipt(id, this.svc['tenant'].userId ?? undefined, false);
  }

  @Post(':invoiceId/email')
  @RequirePermissions('pos:checkout')
  async email(@Param('invoiceId') id: string, @Query('to') to?: string) {
    const r = await this.svc.emailReceipt(id);
    if (!r.ok) throw new BadRequestException(r.message ?? 'email failed');
    return r;
  }

  @Post(':invoiceId/reprint')
  @RequirePermissions('pos:reports')
  async reprint(@Param('invoiceId') id: string, @Body() dto: ReprintDto) {
    const userId = this.svc['tenant'].userId ?? undefined;
    await this.svc['assertCanReprint'](userId);
    const r = await this.svc.printReceipt(id, userId, true);
    await this.svc['printLifecycle'].recordPrintLog(this.svc['prisma'].client, {
      organizationId: this.svc['tenant'].organizationId,
      documentId: id,
      type: 'RECEIPT',
      action: 'REPRINT',
      printedById: userId,
      reason: dto.reason,
    });
    await this.svc['audit'].record({
      entity: 'Document',
      entityId: id,
      action: 'reprint' as any,
      newValues: { kind: 'RECEIPT', reason: dto.reason, printedById: userId ?? null },
    });
    return r;
  }

  @Post(':invoiceId/print-bill')
  @RequirePermissions('pos:checkout')
  async printBill(@Param('invoiceId') id: string) {
    return this.svc.printBill(id, this.svc['tenant'].userId ?? undefined, false);
  }

  /** Print only the items not yet included on any previous bill. */
  @Post(':invoiceId/print-additional-bill')
  @RequirePermissions('pos:checkout')
  async printAdditionalBill(@Param('invoiceId') id: string) {
    return this.svc.printAdditionalBill(id, this.svc['tenant'].userId ?? undefined);
  }

  /** Admin/Manager reprint of a bill (not cashier). Reason is mandatory. */
  @Post(':invoiceId/reprint-bill')
  @RequirePermissions('pos:reports')
  async reprintBill(@Param('invoiceId') id: string, @Body() dto: ReprintDto) {
    const userId = this.svc['tenant'].userId ?? undefined;
    await this.svc['assertCanReprint'](userId);
    const r = await this.svc.printBill(id, userId, true);
    await this.svc['printLifecycle'].recordPrintLog(this.svc['prisma'].client, {
      organizationId: this.svc['tenant'].organizationId,
      documentId: id,
      type: 'BILL',
      action: 'REPRINT',
      printedById: userId,
      reason: dto.reason,
    });
    await this.svc['audit'].record({
      entity: 'Document',
      entityId: id,
      action: 'reprint',
      newValues: { kind: 'BILL', reason: dto.reason, printedById: userId ?? null },
    });
    return r;
  }

  @Post(':invoiceId/print-kot')
  @RequirePermissions('pos:checkout')
  async printKot(@Param('invoiceId') id: string) {
    const userId = this.svc['tenant'].userId ?? undefined;
    const orgId = this.svc['tenant'].organizationId;
    const kotNumber = await this.svc['printLifecycle'].getKotCopyNumber(this.svc['prisma'].client, id);

    const deltas = await this.svc['printLifecycle'].getKitchenDeltas(this.svc['prisma'].client, id);
    const hasChanges = deltas.addLines.length > 0 || deltas.removeLines.length > 0;
    if (!hasChanges) {
      return { ok: true, backend: 'none', message: 'No changes since last KOT', kotNumber } as any;
    }

    const addLines = deltas.addLines.filter((a: any) => a.line.productId);
    const removeLines = deltas.removeLines.filter((r: any) => r.line.productId);

    const text = addLines.length > 0
      ? await this.svc.buildTextKot(id, kotNumber, addLines, removeLines)
      : await this.svc.buildTextCancelKot(id, kotNumber, removeLines);

    const logType = removeLines.length > 0 && addLines.length === 0 ? 'CANCEL' : 'KOT';

    await this.svc['printLifecycle'].markKotPrinted(this.svc['prisma'].client, id, userId);
    if (addLines.length > 0) {
      const lineIds = addLines.map((a: any) => a.line.id);
      const qtyMap = new Map(addLines.map((a: any) => [a.line.id, a.delta]));
      await this.svc['printLifecycle'].markKitchenPrinted(this.svc['prisma'].client, lineIds, qtyMap, userId);
    }
    if (removeLines.length > 0) {
      const lineIds = removeLines.map((r: any) => r.line.id);
      await this.svc['printLifecycle'].markCancelPrinted(this.svc['prisma'].client, lineIds, userId);
    }

    const hostSetting = await this.svc['settings'].get('pos.printerHost');
    const portSetting = await this.svc['settings'].get('pos.printerPort');
    const host = hostSetting?.value;
    const port = portSetting?.value ? Number(portSetting.value) : 9100;

    if (!host) {
      console.log(`[POS] No printer configured; KOT #${kotNumber} text:\n` + text);
      await this.svc['printLifecycle'].recordPrintLog(this.svc['prisma'].client, {
        organizationId: orgId, documentId: id, type: logType, printedById: userId,
      });
      return { ok: true, backend: 'console', message: 'No printer; KOT logged to server console.', kotNumber, text } as any;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const net = require('net');
      await new Promise<void>((resolve, reject) => {
        const client = net.connect({ host, port, timeout: 5000 }, () => {
          client.write(text + '\n\n\n\n\n');
          client.end();
        });
        client.on('end', resolve);
        client.on('error', reject);
        client.on('timeout', () => { client.destroy(); reject(new Error('printer timeout')); });
      });
      await this.svc['printLifecycle'].recordPrintLog(this.svc['prisma'].client, {
        organizationId: orgId, documentId: id, type: logType, printedById: userId,
      });
      return { ok: true, backend: 'escpos', kotNumber, text } as any;
    } catch (e: any) {
      console.log(`[POS] Printer unreachable; KOT #${kotNumber} fallback:\n` + text);
      return { ok: false, backend: 'escpos', message: e?.message ?? 'printer error; KOT logged to console', kotNumber, text } as any;
    }
  }
}

/* ============================== MODULE ============================== */

@Module({
  controllers: [PosReceiptsController],
  providers: [PosReceiptsService],
  exports: [PosReceiptsService],
})
export class PosReceiptsModule {}