/**
 * POS Phase B — Receipts (Sprint P3).
 *
 *   - PdfBackend     → generates a PDF receipt via pdfkit.
 *   - EmailBackend   → sends the PDF to the customer's email via NotificationService.
 *   - EscPosBackend  → prints to a thermal ESC/POS printer over the network.
 *
 * Endpoints exposed by PosReceiptsController:
 *   GET  /pos/receipts/:invoiceId/pdf                         → PDF stream (pdfkit)
 *   GET  /pos/receipts/:invoiceId/text                        → plain-text receipt
 *   POST /pos/receipts/:invoiceId/print                       → ESC/POS print
 *   POST /pos/receipts/:invoiceId/email                       → email PDF
 *   POST /pos/receipts/:invoiceId/reprint                     → alias of /print + audit
 *   POST /pos/receipts/:invoiceId/print-bill                  → print bill
 *   POST /pos/receipts/:invoiceId/print-additional-bill       → print additional bill
 *   POST /pos/receipts/:invoiceId/reprint-bill                → reprint bill
 *   POST /pos/receipts/:invoiceId/print-kot                   → print kitchen ticket
 *   PATCH /pos/receipts/:invoiceId/settings/receipt          → save receipt settings
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Header, NotFoundException,
  Param, Patch, Post, Query, Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import type { Response } from 'express';
import PDFDocument = require('pdfkit');
import { Injectable, Logger, Module } from '@nestjs/common';

import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { NotificationsService } from '../../kernel/notifications/notifications.service';
import { SettingsService } from '../../kernel/settings/settings.service';
import { PosPrintLifecycleService } from './pos-print-lifecycle.service';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { ReceiptSettingsDto } from './receipt-settings.dto';
import { Prisma } from '@prisma/client';

const fmt = (n: number | string | Prisma.Decimal | null | undefined) =>
  `UGX ${Number(n || 0).toLocaleString()}`;

class ReprintDto {
  @IsString()
  reason!: string;
}

/* ============================== SERVICE ============================== */

@Injectable()
export class PosReceiptsService {
  private readonly logger = new Logger(PosReceiptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly printLifecycle: PosPrintLifecycleService,
  ) {}

  /**
   * Resolve the invoice + lines + partner for a receipt, scoped to the tenant.
   * Queries the `Invoice` table first (new POS flow); falls back to `Document`
   * (legacy ERP flow) for backward compatibility. Lines are normalised to a
   * compat shape so downstream methods work without change.
   */
  async resolveInvoice(invoiceId: string) {
    const orgId = this.tenant.organizationId;

    // Try the POS Invoice table first.
    const inv = await this.prisma.client.invoice.findFirst({
      where: { id: invoiceId, organizationId: orgId },
      include: { items: { orderBy: { lineNumber: 'asc' } } },
    });
    if (inv) {
      const [partner, productMap] = await Promise.all([
        this.prisma.client.partner.findFirst({ where: { id: inv.partnerId } }),
        this.resolveProductsForLines(inv.items.map((i: any) => i.productId).filter(Boolean)),
      ]);
      const linesWithProducts = inv.items.map((ln: any) => ({
        ...ln,
        product: ln.productId ? productMap.get(ln.productId) : null,
      }));
      return { ...inv, documentNumber: inv.invoiceNumber, partner, lines: linesWithProducts };
    }

    // Fallback to generic Document (legacy tab flow).
    const doc = await this.prisma.client.document.findFirst({
      where: { id: invoiceId, organizationId: orgId, documentType: 'sales_invoice' },
    });
    if (!doc) throw new NotFoundException('Invoice not found');
    const [partner, lines, productMap] = await Promise.all([
      this.prisma.client.partner.findFirst({ where: { id: doc.partnerId } }),
      this.prisma.client.documentLine.findMany({
        where: { documentId: invoiceId },
        orderBy: { lineNumber: 'asc' },
      }),
      this.resolveProductsForLines(
        (await this.prisma.client.documentLine.findMany({ where: { documentId: invoiceId }, select: { productId: true } }))
          .map((l: any) => l.productId).filter(Boolean),
      ),
    ]);
    const linesWithProducts = lines.map((ln: any) => ({
      ...ln,
      product: ln.productId ? productMap.get(ln.productId) : null,
    }));
    return { ...doc, partner, lines: linesWithProducts };
  }

  private async resolveProductsForLines(productIds: string[]): Promise<Map<string, any>> {
    const orgId = this.tenant.organizationId;
    const ids = Array.from(new Set(productIds)) as string[];
    if (!ids.length) return new Map();
    const products = await this.prisma.client.product.findMany({
      where: { id: { in: ids }, organizationId: orgId },
    });
    return new Map((products as any[]).map((p) => [p.id, p]));
  }

  /** Resolve the org + per-organization receipt customization settings for the receipt header. */
  async resolveOrg() {
    const orgId = this.tenant.organizationId;
    const org = await this.prisma.raw.organization.findUnique({ where: { id: orgId } });
    const [headerSetting, footerSetting] = await Promise.all([
      this.settings.get('receipt.header'),
      this.settings.get('receipt.footer'),
    ]);
    const header = (headerSetting as any)?.value as Record<string, string> | undefined;
    const footer = (footerSetting as any)?.value as Record<string, string> | undefined;
    return {
      ...org,
      receiptHeader: header ?? null,
      receiptFooter: footer ?? null,
    };
  }

  /** Save per-organization receipt customization settings. */
  async saveReceiptSettings(dto: {
    businessName?: string;
    addressLine1?: string;
    addressLine2?: string;
    phone?: string;
    taxId?: string;
    footerMessage?: string;
  }) {
    const headerValue: Record<string, string> = {
      businessName: dto.businessName ?? '',
      addressLine1: dto.addressLine1 ?? '',
      addressLine2: dto.addressLine2 ?? '',
      phone: dto.phone ?? '',
      taxId: dto.taxId ?? '',
    };
    const footerValue: Record<string, string> = { message: dto.footerMessage ?? '' };
    await Promise.all([
      this.settings.set('receipt.header', headerValue),
      this.settings.set('receipt.footer', footerValue),
    ]);
    return { ok: true };
  }

  /** Plain-text receipt — used for ESC/POS printers and a "download .txt" option. */
  async buildTextReceipt(invoiceId: string, isReprint = false): Promise<string> {
    const inv = await this.resolveInvoice(invoiceId);
    const org = await this.resolveOrg();
    const lines: string[] = [];
    const header = (org as any).receiptHeader as Record<string, string> | null;
    const footer = (org as any).receiptFooter as Record<string, string> | null;
    if (isReprint) lines.push('*** REPRINT COPY ***');
    lines.push((header?.businessName ?? org?.name ?? 'Cafe POS').toUpperCase());
    if (header?.addressLine1) lines.push(header.addressLine1);
    if (header?.addressLine2) lines.push(header.addressLine2);
    if (header?.phone) lines.push(`Tel: ${header.phone}`);
    if (header?.taxId) lines.push(`TIN: ${header.taxId}`);
    lines.push('--------------------------------');
    lines.push(`Receipt: ${(inv as any).documentNumber}`);
    lines.push(`Date:    ${new Date(inv.issueDate).toLocaleString()}`);
    lines.push(`Cashier: ${(inv as any).createdBy ?? '-'}`);
    if ((inv as any).partner?.name) lines.push(`Customer: ${(inv as any).partner.name}`);
    lines.push('--------------------------------');
    for (const ln of inv.lines) {
      const qty = Number(ln.quantity);
      const price = Number(ln.unitPrice);
      const disc = Number(ln.discountPercent ?? 0);
      const lineTotal = qty * price * (1 - disc / 100);
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
    lines.push(footer?.message ?? 'Thank you!');
    return lines.join('\n');
  }

  /** HTML receipt — opens browser print dialog when loaded. */
  async buildHtmlReceipt(invoiceId: string, isReprint = false): Promise<string> {
    const text = await this.buildTextReceipt(invoiceId, isReprint);
    const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const escaped = escape(text);
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Receipt</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',Courier,monospace; font-size:13px; white-space:pre; padding:20px; width:300px; margin:0 auto; }
  @media print { body { padding:0; } }
</style></head><body>${escaped.replace(/\n/g, '<br>')}
<script>window.onload=function(){window.print();};</script></body></html>`;
  }

  /** PDF receipt — pdfkit stream. */
  async buildPdfReceipt(invoiceId: string, isReprint = false): Promise<Buffer> {
    const inv = await this.resolveInvoice(invoiceId);
    const org = await this.resolveOrg();
    const header = (org as any).receiptHeader as Record<string, string> | null;
    const footer = (org as any).receiptFooter as Record<string, string> | null;
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: [226, 600], margin: 8 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      if (isReprint) doc.font('Helvetica-Bold').fontSize(10).text('*** REPRINT COPY ***', { align: 'center' });
      doc.font('Helvetica-Bold').fontSize(14).text(header?.businessName ?? org?.name ?? 'Cafe POS', { align: 'center' });
      if (header?.addressLine1) doc.font('Helvetica').fontSize(8).text(header.addressLine1, { align: 'center' });
      if (header?.addressLine2) doc.font('Helvetica').fontSize(8).text(header.addressLine2, { align: 'center' });
      if (header?.phone) doc.font('Helvetica').fontSize(8).text(`Tel: ${header.phone}`, { align: 'center' });
      if (header?.taxId) doc.font('Helvetica').fontSize(8).text(`TIN: ${header.taxId}`, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(9).text('--------------------------------');
      doc.text(`Receipt: ${(inv as any).documentNumber}`);
      doc.text(`Date:    ${new Date(inv.issueDate).toLocaleString()}`);
      doc.text(`Cashier: ${(inv as any).createdBy ?? '-'}`);
      if (inv.partner?.name) doc.text(`Customer: ${inv.partner.name}`);
      doc.text('--------------------------------');
      doc.moveDown(0.3);

      for (const ln of inv.lines) {
        const qty = Number(ln.quantity);
        const price = Number(ln.unitPrice);
        const disc = Number(ln.discountPercent ?? 0);
        const lineTotal = qty * price * (1 - disc / 100);
        const inclTag = (ln as any).taxInclusive ? '  (incl. tax)' : '';
        doc.font('Helvetica').text(`${ln.description}${inclTag}`);
        doc.font('Helvetica').fontSize(8).text(`  ${qty} x ${fmt(price)}${disc > 0 ? ` (-${disc}%)` : ''}`, { continued: true });
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
      doc.fontSize(10).text(footer?.message ?? 'Thank you!', { align: 'center' });
      doc.end();
    });
  }

  /** Send the receipt to the customer's email. Returns { ok: true, sentTo } on success. */
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

  /** Pre-payment bill preview (text). */
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

  /** Assert the current user has an Admin or Manager role. */
  private async assertCanReprint(userId: string | undefined): Promise<void> {
    if (!userId) throw new ForbiddenException('Authentication required for reprint');
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId, organizationId: this.tenant.organizationId },
      include: { roles: true },
    });
    if (!user) throw new ForbiddenException('User not found');
    const roleNames = user.roles.map((r: any) => (r.name ?? '').toLowerCase());
    const isAdminOrManager = roleNames.some((n: string) => n.includes('admin') || n.includes('manager'));
    if (!isAdminOrManager) {
      throw new ForbiddenException(
        'Only Admin/Manager can reprint bills and receipts. Record a reason in the audit log.',
      );
    }
  }

  /** Print a pre-payment bill (ESC/POS). */
  async printBill(invoiceId: string, userId?: string, isReprint = false): Promise<{ ok: boolean; backend: string; message?: string }> {
    if (!isReprint) {
      // Check both Invoice and Document tables for prior bill prints.
      const inv = await this.prisma.client.invoice.findFirst({
        where: { id: invoiceId, organizationId: this.tenant.organizationId },
        select: { billPrintCount: true },
      });
      const prior = inv?.billPrintCount ?? (
        await this.prisma.client.document.findFirst({
          where: { id: invoiceId, organizationId: this.tenant.organizationId },
          select: { billPrintCount: true },
        })
      )?.billPrintCount ?? 0;
      if (prior > 0) {
        throw new ForbiddenException('Bill already printed. Use the reprint endpoint (Admin/Manager only, with a reason).');
      }
    }

    const text = await this.buildTextBill(invoiceId, isReprint);
    const orgId = this.tenant.organizationId;
    await this.printLifecycle.markBillPrinted(this.prisma.client, invoiceId, userId);
    await this.printLifecycle.markLinesBilled(this.prisma.client, invoiceId, userId);

    const hostSetting = await this.settings.get('pos.printerHost');
    const portSetting = await this.settings.get('pos.printerPort');
    const host = hostSetting?.value;
    const port = portSetting?.value ? Number(portSetting.value) : 9100;

    if (!host) {
      this.logger.warn(`[POS] No printer configured; bill:\n${text}`);
      await this.printLifecycle.recordPrintLog(this.prisma.client, {
        organizationId: orgId, documentId: invoiceId, type: 'BILL', printedById: userId,
      });
      return { ok: true, backend: 'console', message: 'No printer configured; bill logged to server console.' };
    }

    try {
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
        organizationId: orgId, documentId: invoiceId, type: 'BILL', printedById: userId,
      });
      return { ok: true, backend: 'escpos' };
    } catch (e: any) {
      this.logger.warn(`[POS] Printer unreachable; bill fallback: ${e?.message}`);
      return { ok: false, backend: 'escpos', message: e?.message ?? 'printer error; bill fallback' };
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
   * Build text for an additional bill — only items that have not yet appeared
   * on a previously-printed bill.
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

  /** Print an Additional Bill — only items not yet included on any previous bill print. */
  async printAdditionalBill(invoiceId: string, userId?: string): Promise<{ ok: boolean; backend: string; message?: string; copyNumber: number; grandTotal: number; additionalSubtotal: number; previousSubtotal: number }> {
    const orgId = this.tenant.organizationId;

    // Get print count from Invoice or Document.
    const invPrint = await this.prisma.client.invoice.findFirst({
      where: { id: invoiceId, organizationId: orgId },
      select: { billPrintCount: true },
    });
    const docPrint = invPrint ? null : await this.prisma.client.document.findFirst({
      where: { id: invoiceId, organizationId: orgId },
      select: { billPrintCount: true },
    });
    const billPrintCount = invPrint?.billPrintCount ?? docPrint?.billPrintCount ?? 0;
    const copyNumber = billPrintCount + 1;

    const unbilled = await this.getUnbilledLines(invoiceId);
    if (unbilled.length === 0) {
      throw new BadRequestException('No additional items to bill. All items have already appeared on a previous bill.');
    }

    const { text: additionalBillText, grandTotal, additionalSubtotal, previousSubtotal } =
      await this.buildTextAdditionalBill(invoiceId, copyNumber);

    await this.printLifecycle.markBillPrinted(this.prisma.client, invoiceId, userId);
    await this.printLifecycle.markLinesBilled(this.prisma.client, invoiceId, userId);

    const hostSetting = await this.settings.get('pos.printerHost');
    const portSetting = await this.settings.get('pos.printerPort');
    const host = hostSetting?.value;
    const port = portSetting?.value ? Number(portSetting.value) : 9100;

    if (!host) {
      this.logger.warn(`[POS] No printer configured; additional bill:\n${additionalBillText}`);
      await this.printLifecycle.recordPrintLog(this.prisma.client, {
        organizationId: orgId, documentId: invoiceId, type: 'BILL', action: 'PRINT', copies: 1, printedById: userId,
      });
      return { ok: true, backend: 'console', message: 'No printer configured; additional bill logged to server console.', copyNumber, grandTotal, additionalSubtotal, previousSubtotal };
    }

    try {
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
        organizationId: orgId, documentId: invoiceId, type: 'BILL', action: 'PRINT', copies: 1, printedById: userId,
      });
      return { ok: true, backend: 'escpos', copyNumber, grandTotal, additionalSubtotal, previousSubtotal };
    } catch (e: any) {
      this.logger.warn(`[POS] Printer unreachable; additional bill fallback: ${e?.message}`);
      return { ok: false, backend: 'escpos', message: e?.message ?? 'printer error', copyNumber, grandTotal, additionalSubtotal, previousSubtotal };
    }
  }

  /**
   * Print the receipt to a thermal ESC/POS printer.
   * Looks up printer IP from settings (pos.printerHost, pos.printerPort).
   */
  async printReceipt(invoiceId: string, userId?: string, isReprint = false): Promise<{ ok: boolean; backend: string; message?: string }> {
    const inv = await this.resolveInvoice(invoiceId);
    const text = await this.buildTextReceipt(invoiceId, isReprint);

    await this.printLifecycle.markReceiptPrinted(this.prisma.client, invoiceId, userId);

    const orgId = this.tenant.organizationId;
    const hostSetting = await this.settings.get('pos.printerHost');
    const portSetting = await this.settings.get('pos.printerPort');
    const host = hostSetting?.value;
    const port = portSetting?.value ? Number(portSetting.value) : 9100;

    if (!host) {
      this.logger.warn(`[POS] No printer configured; receipt:\n${text}`);
      await this.printLifecycle.recordPrintLog(this.prisma.client, {
        organizationId: orgId, documentId: invoiceId, type: 'RECEIPT', printedById: userId,
      });
      return { ok: true, backend: 'console', message: 'No printer configured; receipt logged to server console.' };
    }

    try {
      const net = require('net');
      const kickSetting = await this.settings.get('pos.kickDrawerOnPrint');
      const shouldKick = kickSetting?.value !== 'false';
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
        organizationId: orgId, documentId: invoiceId, type: 'RECEIPT', printedById: userId,
      });
      return { ok: true, backend: 'escpos' };
    } catch (e: any) {
      this.logger.warn(`[POS] Printer unreachable; receipt fallback: ${e?.message}`);
      return { ok: false, backend: 'escpos', message: e?.message ?? 'printer error' };
    }
  }

  // -- Receipt lifecycle helpers exposed for the controller (same file, so accessor bypasses TS privacy) --

  public lifecycle() { return this.printLifecycle; }
  public prismaSvc() { return this.prisma; }
  public tenantSvc() { return this.tenant; }
}

/* ============================== CONTROLLER ============================== */

@ApiTags('pos/receipts')
@ApiBearerAuth()
@Controller('pos/receipts')
export class PosReceiptsController {
  private readonly logger = new Logger(PosReceiptsController.name);

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
    return this.svc.printReceipt(id, this.svc.tenantSvc().userId ?? undefined, false);
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
    const userId = this.svc.tenantSvc().userId ?? undefined;
    await this.svc['assertCanReprint'](userId);
    const r = await this.svc.printReceipt(id, userId, true);
    await this.svc.lifecycle().recordPrintLog(this.svc.prismaSvc().client, {
      organizationId: this.svc.tenantSvc().organizationId,
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
    return this.svc.printBill(id, this.svc.tenantSvc().userId ?? undefined, false);
  }

  @Post(':invoiceId/print-additional-bill')
  @RequirePermissions('pos:checkout')
  async printAdditionalBill(@Param('invoiceId') id: string) {
    return this.svc.printAdditionalBill(id, this.svc.tenantSvc().userId ?? undefined);
  }

  @Post(':invoiceId/reprint-bill')
  @RequirePermissions('pos:reports')
  async reprintBill(@Param('invoiceId') id: string, @Body() dto: ReprintDto) {
    const userId = this.svc.tenantSvc().userId ?? undefined;
    await this.svc['assertCanReprint'](userId);
    const r = await this.svc.printBill(id, userId, true);
    await this.svc.lifecycle().recordPrintLog(this.svc.prismaSvc().client, {
      organizationId: this.svc.tenantSvc().organizationId,
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
    const userId = this.svc.tenantSvc().userId ?? undefined;
    const orgId = this.svc.tenantSvc().organizationId;
    const kotNumber = await this.svc.lifecycle().getKotCopyNumber(this.svc.prismaSvc().client, id);

    const deltas = await this.svc.lifecycle().getKitchenDeltas(this.svc.prismaSvc().client, id);
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

    await this.svc.lifecycle().markKotPrinted(this.svc.prismaSvc().client, id, userId);
    if (addLines.length > 0) {
      const lineIds = addLines.map((a: any) => a.line.id);
      const qtyMap = new Map(addLines.map((a: any) => [a.line.id, a.delta]));
      await this.svc.lifecycle().markKitchenPrinted(this.svc.prismaSvc().client, lineIds, qtyMap, userId);
    }
    if (removeLines.length > 0) {
      const lineIds = removeLines.map((r: any) => r.line.id);
      await this.svc.lifecycle().markCancelPrinted(this.svc.prismaSvc().client, lineIds, userId);
    }

    const hostSetting = await this.svc['settings'].get('pos.printerHost');
    const portSetting = await this.svc['settings'].get('pos.printerPort');
    const host = hostSetting?.value;
    const port = portSetting?.value ? Number(portSetting.value) : 9100;

    if (!host) {
      this.logger.warn(`[POS] No printer configured; KOT #${kotNumber}:\n${text}`);
      await this.svc.lifecycle().recordPrintLog(this.svc.prismaSvc().client, {
        organizationId: orgId, documentId: id, type: logType, printedById: userId,
      });
      return { ok: true, backend: 'console', message: 'No printer; KOT logged to server console.', kotNumber, text } as any;
    }

    try {
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
      await this.svc.lifecycle().recordPrintLog(this.svc.prismaSvc().client, {
        organizationId: orgId, documentId: id, type: logType, printedById: userId,
      });
      return { ok: true, backend: 'escpos', kotNumber, text } as any;
    } catch (e: any) {
      this.logger.warn(`[POS] Printer unreachable; KOT #${kotNumber} fallback: ${e?.message}`);
      return { ok: false, backend: 'escpos', message: e?.message ?? 'printer error', kotNumber, text } as any;
    }
  }

  @Patch(':invoiceId/settings/receipt')
  @RequirePermissions('pos:reports')
  async updateReceiptSettings(@Param('invoiceId') _id: string, @Body() dto: ReceiptSettingsDto) {
    return this.svc.saveReceiptSettings(dto);
  }
}

/* ============================== MODULE ============================== */

@Module({
  controllers: [PosReceiptsController],
  providers: [PosReceiptsService],
  exports: [PosReceiptsService],
})
export class PosReceiptsModule {}
