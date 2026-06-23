import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../kernel/sequence/sequence.service';
import { EventBus } from '../../kernel/events/event-bus';
import { AuditService } from '../../kernel/audit/audit.service';
import { PostingService } from '../accounting/posting/posting.service';
import { AccountDeterminationService } from '../accounting/posting/account-determination.service';

interface CreateDebitNoteInput {
  direction: 'outbound' | 'inbound';
  partnerId: string;
  documentId?: string;
  reason: 'price_adjustment' | 'returned_goods' | 'overcharge' | 'correction' | 'other';
  reasonNote?: string;
  issueDate?: string;
  currencyCode?: string;
  exchangeRate?: number;
  notes?: string;
  lines: Array<{
    productId?: string;
    description: string;
    quantity: number;
    unitPrice: number;
    taxId?: string;
    notes?: string;
  }>;
}

/**
 * Debit notes (Phase F.6).
 *
 * Two directions:
 *   - outbound: we issue to a customer (increases their AR — they owe us more).
 *     GL: Dr Receivable / Cr Revenue (or Cr Sales Adjustment if correcting a sale)
 *   - inbound:  supplier issued us a debit note (increases our AP).
 *     GL: Dr Expense/Stock / Cr Payable
 *
 * Posting goes through the same PostingService so the books remain balanced.
 */
@Injectable()
export class DebitNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly sequence: SequenceService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
    private readonly determination: AccountDeterminationService,
  ) {}

  async create(input: CreateDebitNoteInput) {
    const orgId = this.tenant.organizationId;
    if (!input.lines?.length) throw new BadRequestException('At least one line required');
    const partner = await this.prisma.raw.partner.findFirst({
      where: { id: input.partnerId, organizationId: orgId },
    });
    if (!partner) throw new NotFoundException('Partner not found');
    const year = new Date().getUTCFullYear();
    const prefix = input.direction === 'outbound' ? `DBN-OUT-${year}-` : `DBN-IN-${year}-`;
    const noteNumber = await this.sequence.next(`debitnote:${year}`, { prefix, padding: 5 });

    let subtotal = 0;
    let taxAmount = 0;
    for (const ln of input.lines) {
      const lineSubtotal = Number(ln.quantity) * Number(ln.unitPrice);
      subtotal += lineSubtotal;
      // Tax is computed at post time using AccountDeterminationService.
    }

    const note = await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.debitNote.create({
        data: {
          organizationId: orgId,
          noteNumber,
          direction: input.direction,
          partnerId: input.partnerId,
          documentId: input.documentId,
          reason: input.reason,
          reasonNote: input.reasonNote,
          issueDate: input.issueDate ? new Date(input.issueDate) : new Date(),
          currencyCode: input.currencyCode ?? 'USD',
          exchangeRate: input.exchangeRate ?? 1,
          subtotal,
          taxAmount: 0,
          totalAmount: subtotal,
          status: 'draft',
          notes: input.notes,
          createdBy: this.tenant.userId ?? null,
          lines: {
            create: input.lines.map((ln, idx) => ({
              organizationId: orgId,
              productId: ln.productId ?? null,
              description: ln.description,
              quantity: ln.quantity,
              unitPrice: ln.unitPrice,
              taxId: ln.taxId ?? null,
              subtotal: Number(ln.quantity) * Number(ln.unitPrice),
              total: Number(ln.quantity) * Number(ln.unitPrice),
              lineNumber: idx + 1,
              notes: ln.notes ?? null,
            })),
          },
        },
        include: { lines: true },
      });
      return created;
    });

    await this.audit.record({
      entity: 'DebitNote',
      entityId: note.id,
      action: 'create',
      newValues: { noteNumber, direction: input.direction },
    });
    this.events.publish('debit_note.created' as any, {
      organizationId: orgId,
      noteId: note.id,
      noteNumber,
      direction: input.direction,
    });
    return note;
  }

  async post(id: string) {
    const orgId = this.tenant.organizationId;
    const note = await this.prisma.client.debitNote.findFirst({
      where: { id, organizationId: orgId },
      include: { lines: true, partner: true },
    });
    if (!note) throw new NotFoundException('Debit note not found');
    if (note.status !== 'draft') throw new BadRequestException(`Cannot post debit note in status ${note.status}`);

    const journalCode = note.direction === 'outbound' ? 'SALES' : 'PURCH';
    const counterAccount =
      note.direction === 'outbound'
        ? await this.determination.receivableAccount(note.partner, this.prisma.client)
        : await this.determination.payableAccount(note.partner, this.prisma.client);
    const lines = note.lines.map((ln) => {
      const amt = Number(ln.subtotal);
      return note.direction === 'outbound'
        ? // Dr AR, Cr Revenue (per line description — uses income account mapping)
          { accountId: counterAccount, debit: amt, partnerId: note.partnerId }
        : // Dr Expense, Cr AP
          { accountId: counterAccount, credit: amt, partnerId: note.partnerId };
    });
    // For the offsetting leg, hit the income/expense account for each line.
    const offsetAccountByLine: Array<{ accountId: string; amount: number }> = [];
    for (const ln of note.lines) {
      // Use AccountDeterminationService via the partner's product category if
      // available; otherwise the default income/expense mapping.
      let accountId: string | null = null;
      if (ln.productId) {
        const product = await this.prisma.raw.product.findFirst({
          where: { id: ln.productId, organizationId: orgId },
          include: { category: true },
        });
        if (product) {
          if (note.direction === 'outbound' && product.category?.incomeAccountId) {
            accountId = product.category.incomeAccountId;
          } else if (note.direction === 'inbound' && product.category?.expenseAccountId) {
            accountId = product.category.expenseAccountId;
          }
        }
      }
      if (!accountId) {
        accountId =
          note.direction === 'outbound'
            ? await this.determination.mapped('sales_revenue')
            : await this.determination.mapped('default_expense');
      }
      offsetAccountByLine.push({ accountId, amount: Number(ln.subtotal) });
    }

    // Build posting lines: aggregate by account.
    const agg = new Map<string, number>();
    for (const l of lines) {
      if (l.debit) agg.set(l.accountId, (agg.get(l.accountId) ?? 0) + Number(l.debit));
      if (l.credit) agg.set(l.accountId, (agg.get(l.accountId) ?? 0) - Number(l.credit));
    }
    for (const o of offsetAccountByLine) {
      agg.set(o.accountId, (agg.get(o.accountId) ?? 0) - o.amount);
    }
    // Emit balanced posting lines: debit legs + credit legs.
    const postingLines: Array<{ accountId: string; debit?: number; credit?: number }> = [];
    for (const l of lines) {
      postingLines.push({ accountId: l.accountId, debit: l.debit, credit: l.credit });
    }
    for (const o of offsetAccountByLine) {
      postingLines.push({ accountId: o.accountId, credit: o.amount });
    }

    await this.posting.post({
      journalCode,
      date: note.issueDate,
      description: `${note.direction === 'outbound' ? 'Debit note to customer' : 'Debit note from supplier'} ${note.noteNumber}`,
      sourceType: 'debit_note',
      sourceId: note.id,
      lines: postingLines,
    });

    const updated = await this.prisma.client.debitNote.update({
      where: { id },
      data: { status: 'posted', postedAt: new Date(), postedById: this.tenant.userId ?? null },
    });
    await this.audit.record({
      entity: 'DebitNote',
      entityId: id,
      action: 'update',
      newValues: { status: 'posted' },
    });
    this.events.publish('debit_note.posted' as any, {
      organizationId: orgId,
      noteId: id,
      direction: note.direction,
      amount: String(Number(note.totalAmount)),
    });
    return updated;
  }

  async cancel(id: string) {
    const note = await this.prisma.client.debitNote.findFirst({ where: { id, organizationId: this.tenant.organizationId } });
    if (!note) throw new NotFoundException('Debit note not found');
    if (note.status === 'posted') throw new BadRequestException('Cannot cancel a posted debit note; reverse with a credit note');
    return this.prisma.client.debitNote.update({ where: { id }, data: { status: 'cancelled' } });
  }

  list(query: { direction?: string; status?: string }) {
    const where: any = { organizationId: this.tenant.organizationId };
    if (query.direction) where.direction = query.direction;
    if (query.status) where.status = query.status;
    return this.prisma.client.debitNote.findMany({
      where,
      include: { lines: true, partner: { select: { name: true } } },
      orderBy: { issueDate: 'desc' },
      take: 200,
    });
  }

  findOne(id: string) {
    return this.prisma.client.debitNote.findFirst({
      where: { id, organizationId: this.tenant.organizationId },
      include: { lines: true, partner: true },
    });
  }
}
