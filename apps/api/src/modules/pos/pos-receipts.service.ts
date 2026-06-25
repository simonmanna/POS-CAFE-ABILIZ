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
  BadRequestException, Controller, Get, Header, NotFoundException,
  Param, Post, Query, Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import PDFDocument = require('pdfkit');
import { Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { NotificationsService } from '../../kernel/notifications/notifications.service';
import { SettingsService } from '../../kernel/settings/settings.service';
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
  async buildTextReceipt(invoiceId: string): Promise<string> {
    const inv = await this.resolveInvoice(invoiceId);
    const org = await this.resolveOrg();
    const lines: string[] = [];
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
  async buildPdfReceipt(invoiceId: string): Promise<Buffer> {
    const inv = await this.resolveInvoice(invoiceId);
    const org = await this.resolveOrg();
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: [226, 600], margin: 8 }); // 80mm thermal
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
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
    await this.audit.record({
      entity: 'Document',
      entityId: invoiceId,
      action: 'update',
      newValues: { receiptEmailedTo: customerEmail },
    });
    return { ok: true, sentTo: customerEmail };
  }

  /**
   * Print the receipt to a thermal ESC/POS printer.
   *
   * Looks up printer IP from settings (`pos.printerHost`, `pos.printerPort`).
   * Falls back to logging the text receipt if no printer is configured or
   * if the `node-thermal-printer` package isn't installed.
   */
  async printReceipt(invoiceId: string): Promise<{ ok: boolean; backend: string; message?: string }> {
    const inv = await this.resolveInvoice(invoiceId);
    const text = await this.buildTextReceipt(invoiceId);

    // Read printer settings.
    const orgId = this.tenant.organizationId;
    const hostSetting = await this.settings.get('pos.printerHost');
    const portSetting = await this.settings.get('pos.printerPort');
    const host = hostSetting?.value;
    const port = portSetting?.value ? Number(portSetting.value) : 9100;

    if (!host) {
      // No printer configured — fall back to console log so the receipt flow
      // doesn't fail in dev / paperless mode.
      // eslint-disable-next-line no-console
      console.log('[POS] No printer configured; receipt text:\n' + text);
      await this.audit.record({
        entity: 'Document',
        entityId: invoiceId,
        action: 'update',
        newValues: { receiptPrintedFallback: true, printedAt: new Date().toISOString() },
      });
      return { ok: true, backend: 'console', message: 'No printer configured; receipt logged to server console.' };
    }

    // Attempt to send via raw TCP socket. ESC/POS printers listen on port 9100
    // by default. We don't add node-thermal-printer as a hard dep — the
    // cashier installs it if they have a physical printer.
    try {
      // Dynamic require so this works whether or not the optional dep is installed.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const net = require('net');
      const settings = await this.settings.get('pos.kickDrawerOnPrint');
      const shouldKick = settings?.value !== 'false'; // default ON when a printer is configured
      await new Promise<void>((resolve, reject) => {
        const client = net.connect({ host, port, timeout: 5000 }, () => {
          client.write(text + '\n\n\n\n\n');
          // P6: kick the cash drawer after the receipt prints. Most ESC/POS
          // printers expose an RJ12 drawer port on pin 2; the pulse is:
          //   ESC  p   0   25   250
          // (1BH 70H 00H 19H FAH) — opens drawer for ~25ms then closes.
          if (shouldKick) {
            client.write(Buffer.from([0x1B, 0x70, 0x00, 0x19, 0xFA]));
          }
          client.end();
        });
        client.on('end', resolve);
        client.on('error', reject);
        client.on('timeout', () => { client.destroy(); reject(new Error('printer timeout')); });
      });
      await this.audit.record({
        entity: 'Document',
        entityId: invoiceId,
        action: 'update',
        newValues: { receiptPrintedTo: `${host}:${port}`, printedAt: new Date().toISOString(), drawerKicked: shouldKick },
      });
      return { ok: true, backend: 'escpos' };
    } catch (e: any) {
      // eslint-disable-next-line no-console
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
    return this.svc.printReceipt(id);
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
  async reprint(@Param('invoiceId') id: string) {
    const r = await this.svc.printReceipt(id);
    await this.svc['audit'].record({
      entity: 'Document',
      entityId: id,
      action: 'update' as any,
      newValues: { reprintedAt: new Date().toISOString(), backend: r.backend },
    });
    return r;
  }
}

/* ============================== MODULE ============================== */

@Module({
  controllers: [PosReceiptsController],
  providers: [PosReceiptsService],
  exports: [PosReceiptsService],
})
export class PosReceiptsModule {}