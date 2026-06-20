import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { SequenceService } from '../../../kernel/sequence/sequence.service';
import { dec } from '../../../kernel/common/money';
import { FiscalPeriodService } from './fiscal-period.service';
import { isBalanced, normalizeLines, totals, validateLines } from './posting.math';
import type { PostingRequest } from './posting.types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The ONE writer of JournalEntry/JournalLine (ADR-009). Validates double-entry
 * rules, enforces period control, numbers atomically, and is transaction-
 * composable: pass `tx` so a document's state change + its posting are atomic.
 */
@Injectable()
export class PostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly events: EventBus,
    private readonly sequence: SequenceService,
    private readonly fiscalPeriod: FiscalPeriodService,
  ) {}

  async post(request: PostingRequest, tx?: any): Promise<any> {
    return tx ? this.doPost(request, tx) : this.prisma.client.$transaction((c: any) => this.doPost(request, c));
  }

  async reverse(
    journalEntryId: string,
    options: { date?: Date | string; description?: string } = {},
    tx?: any,
  ): Promise<any> {
    return tx
      ? this.doReverse(journalEntryId, options, tx)
      : this.prisma.client.$transaction((c: any) => this.doReverse(journalEntryId, options, c));
  }

  private async doPost(request: PostingRequest, client: any): Promise<any> {
    if (!request.lines || request.lines.length < 2) {
      throw new BadRequestException('A journal entry requires at least two lines');
    }

    const journal = await client.journal.findFirst({ where: { code: request.journalCode } });
    if (!journal) throw new BadRequestException(`Journal '${request.journalCode}' not found`);

    const date = new Date(request.date);
    await this.fiscalPeriod.assertOpen(date, client);

    const rate = dec(request.exchangeRate ?? 1);
    const lines = normalizeLines(request.lines, rate);

    const lineErrors = validateLines(lines);
    if (lineErrors.length > 0) throw new BadRequestException(lineErrors[0].message);

    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await client.account.findMany({ where: { id: { in: accountIds } } });
    if (accounts.length !== accountIds.length) {
      throw new BadRequestException('One or more accounts do not exist in this organization');
    }
    const notPostable = accounts.find((a: any) => a.isGroup || !a.isActive);
    if (notPostable) {
      throw new BadRequestException(`Account ${notPostable.code} is a group/inactive account and cannot be posted to`);
    }

    if (!isBalanced(lines)) {
      const t = totals(lines);
      throw new BadRequestException(
        `Unbalanced entry: total debit ${t.debit.toString()} != total credit ${t.credit.toString()}`,
      );
    }

    const organizationId = this.tenant.organizationId;
    const year = date.getUTCFullYear();
    const entryNumber = await this.sequence.next(
      `journal:${journal.code}:${year}`,
      { prefix: `${journal.code}/${year}/`, padding: 5 },
      client,
    );

    const entry = await client.journalEntry.create({
      data: {
        organizationId,
        journalId: journal.id,
        entryNumber,
        postingDate: date,
        description: request.description ?? null,
        status: 'posted',
        currencyId: request.currencyId ?? null,
        sourceType: request.sourceType ?? null,
        sourceId: request.sourceId ?? null,
        postedAt: new Date(),
        postedBy: this.tenant.userId ?? null,
        lines: {
          create: lines.map((l, i) => ({
            organizationId,
            accountId: l.accountId,
            partnerId: l.partnerId ?? null,
            description: l.description ?? null,
            debit: l.debit,
            credit: l.credit,
            currencyId: request.currencyId ?? null,
            exchangeRate: rate,
            baseDebit: l.baseDebit,
            baseCredit: l.baseCredit,
            lineNumber: i + 1,
          })),
        },
      },
      include: { lines: true },
    });

    this.events.publish('journal.posted', {
      organizationId,
      journalEntryId: entry.id,
      entryNumber,
      sourceType: request.sourceType,
      sourceId: request.sourceId,
    });
    return entry;
  }

  private async doReverse(
    journalEntryId: string,
    options: { date?: Date | string; description?: string },
    client: any,
  ): Promise<any> {
    const original = await client.journalEntry.findFirst({
      where: { id: journalEntryId },
      include: { lines: true, journal: true },
    });
    if (!original) throw new NotFoundException('Journal entry not found');
    if (original.status !== 'posted') {
      throw new BadRequestException('Only posted entries can be reversed');
    }

    const date = options.date ? new Date(options.date) : new Date();
    await this.fiscalPeriod.assertOpen(date, client);

    const organizationId = this.tenant.organizationId;
    const year = date.getUTCFullYear();
    const entryNumber = await this.sequence.next(
      `journal:${original.journal.code}:${year}`,
      { prefix: `${original.journal.code}/${year}/`, padding: 5 },
      client,
    );

    const reversal = await client.journalEntry.create({
      data: {
        organizationId,
        journalId: original.journalId,
        entryNumber,
        postingDate: date,
        description: options.description ?? `Reversal of ${original.entryNumber}`,
        status: 'posted',
        currencyId: original.currencyId,
        sourceType: 'reversal',
        sourceId: original.id,
        reversalOfId: original.id,
        postedAt: new Date(),
        postedBy: this.tenant.userId ?? null,
        lines: {
          create: original.lines.map((l: any, i: number) => ({
            organizationId,
            accountId: l.accountId,
            partnerId: l.partnerId,
            description: `Reversal: ${l.description ?? ''}`,
            debit: l.credit,
            credit: l.debit,
            currencyId: l.currencyId,
            exchangeRate: l.exchangeRate,
            baseDebit: l.baseCredit,
            baseCredit: l.baseDebit,
            lineNumber: i + 1,
          })),
        },
      },
      include: { lines: true },
    });

    await client.journalEntry.updateMany({
      where: { id: original.id },
      data: { status: 'reversed', reversedEntryId: reversal.id },
    });

    this.events.publish('journal.reversed', {
      organizationId,
      journalEntryId: original.id,
      reversalEntryId: reversal.id,
    });
    return reversal;
  }
}
