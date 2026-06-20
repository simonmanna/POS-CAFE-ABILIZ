import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PaginationQuery } from '@erp/shared';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { PostingService } from '../../accounting/posting/posting.service';
import type { PostingLineInput } from '../../accounting/posting/posting.types';
import { DocumentBuilderService } from '../document/document-builder.service';
import { CreateVendorBillDto } from './dto/vendor-bill.dto';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Vendor bills / expenses (Accounts Payable). Posting:
 *   Dr Expense (net per account) + Dr Input Tax  /  Cr Accounts Payable (total).
 */
@Injectable()
export class VendorBillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly events: EventBus,
    private readonly posting: PostingService,
    private readonly builder: DocumentBuilderService,
  ) {}

  async list(query: PaginationQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 25));
    const where: any = { documentType: 'vendor_bill' };
    if (query.search) {
      where.OR = [
        { documentNumber: { contains: query.search, mode: 'insensitive' } },
        { reference: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.client.document.findMany({
        where,
        include: { partner: true, _count: { select: { lines: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.document.count({ where }),
    ]);
    return { data, meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
  }

  findOne(id: string) {
    return this.prisma.client.document.findFirst({
      where: { id, documentType: 'vendor_bill' },
      include: { lines: { orderBy: { lineNumber: 'asc' } }, partner: true, allocations: true },
    });
  }

  async create(dto: CreateVendorBillDto) {
    return this.builder.createDocument(this.prisma.client, 'vendor_bill', dto, dto.lines);
  }

  async update(id: string, dto: CreateVendorBillDto) {
    return this.prisma.client.$transaction(async (tx: any) => {
      const doc = await tx.document.findFirst({ where: { id, documentType: 'vendor_bill' } });
      if (!doc) throw new NotFoundException('Vendor bill not found');
      if (doc.status !== 'draft') throw new BadRequestException('Only draft bills can be edited');

      await tx.documentLine.deleteMany({ where: { documentId: id } });
      const totals = await this.builder.prepareLines(tx, dto.lines);
      const organizationId = this.tenant.organizationId;

      await tx.document.updateMany({
        where: { id },
        data: {
          partnerId: dto.partnerId,
          issueDate: new Date(dto.issueDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          currencyId: dto.currencyId ?? null,
          reference: dto.reference ?? null,
          notes: dto.notes ?? null,
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          taxAmount: totals.taxAmount,
          totalAmount: totals.total,
          amountResidual: totals.total,
        },
      });
      for (const p of totals.prepared) {
        await tx.documentLine.create({
          data: {
            organizationId,
            documentId: id,
            productId: p.productId,
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
          },
        });
      }
      return tx.document.findFirst({ where: { id }, include: { lines: true, partner: true } });
    });
  }

  async post(id: string) {
    return this.prisma.client.$transaction(async (tx: any) => {
      const doc = await tx.document.findFirst({
        where: { id, documentType: 'vendor_bill' },
        include: { lines: true },
      });
      if (!doc) throw new NotFoundException('Vendor bill not found');
      if (doc.status === 'posted' || doc.status === 'paid') {
        throw new BadRequestException('Bill is already posted');
      }
      if (doc.status === 'cancelled') throw new BadRequestException('Bill is cancelled');

      const { counterAccount, itemByAccount, taxByAccount } = await this.builder.groupForPosting(
        tx,
        doc,
        'purchase',
      );

      const lines: PostingLineInput[] = [];
      for (const [accountId, amount] of itemByAccount) {
        lines.push({ accountId, debit: amount.toString(), partnerId: doc.partnerId, description: 'Expense' });
      }
      for (const [accountId, amount] of taxByAccount) {
        lines.push({ accountId, debit: amount.toString(), description: 'Input tax' });
      }
      lines.push({
        accountId: counterAccount,
        credit: doc.totalAmount.toString(),
        partnerId: doc.partnerId,
        description: `Bill ${doc.documentNumber}`,
      });

      const entry = await this.posting.post(
        {
          journalCode: 'PURCH',
          date: doc.issueDate,
          description: `Bill ${doc.documentNumber}`,
          currencyId: doc.currencyId ?? undefined,
          exchangeRate: Number(doc.exchangeRate),
          sourceType: 'vendor_bill',
          sourceId: doc.id,
          lines,
        },
        tx,
      );

      await tx.document.updateMany({
        where: { id: doc.id },
        data: {
          status: 'posted',
          postedAt: new Date(),
          postedBy: this.tenant.userId ?? null,
          journalEntryId: entry.id,
          amountResidual: doc.totalAmount,
          paymentStatus: 'not_paid',
        },
      });

      this.events.publish('bill.posted', {
        organizationId: this.tenant.organizationId,
        documentId: doc.id,
        documentNumber: doc.documentNumber,
      });
      return tx.document.findFirst({ where: { id: doc.id }, include: { lines: true, partner: true } });
    });
  }

  /** Void: reverse the posting (corrections via reversal, never edits). */
  async cancel(id: string) {
    return this.prisma.client.$transaction(async (tx: any) => {
      const doc = await tx.document.findFirst({ where: { id, documentType: 'vendor_bill' } });
      if (!doc) throw new NotFoundException('Vendor bill not found');
      if (doc.status === 'cancelled') return doc;
      if (doc.status === 'posted' || doc.status === 'paid') {
        if (!(doc.amountPaid as any).isZero?.() && Number(doc.amountPaid) > 0) {
          throw new BadRequestException('Cannot void a bill with payments; void the payment first');
        }
        if (doc.journalEntryId) {
          await this.posting.reverse(doc.journalEntryId, { description: `Void of ${doc.documentNumber}` }, tx);
        }
      }
      await tx.document.updateMany({
        where: { id },
        data: { status: 'cancelled', amountResidual: 0, paymentStatus: 'not_paid' },
      });
      this.events.publish('bill.cancelled', {
        organizationId: this.tenant.organizationId,
        documentId: doc.id,
        documentNumber: doc.documentNumber,
      });
      return tx.document.findFirst({ where: { id } });
    });
  }
}
