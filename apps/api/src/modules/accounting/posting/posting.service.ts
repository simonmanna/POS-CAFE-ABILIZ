import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { SequenceService } from '../../../kernel/sequence/sequence.service';
import { dec, ZERO } from '../../../kernel/common/money';
import { FiscalPeriodService } from './fiscal-period.service';
import { normalizeLines, totals, validateLines, type NormalizedLine } from './posting.math';
import type { PostingRequest } from './posting.types';
import { CurrencyService } from '../currency/currency.service';

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
    private readonly currency: CurrencyService,
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

    // Phase C: resolve FX rate from the posted currency → org base at the
    // posting date. If no rate is configured, fall back to 1:1 (single-currency
    // orgs / dev installs).
    const org = await client.organization.findUnique({ where: { id: this.tenant.organizationId } });
    const baseCode = org?.currencyCode ?? 'USD';
    let rate = dec(request.exchangeRate ?? 1);
    if (request.currencyId && request.currencyId !== baseCode) {
      try {
        rate = await this.currency.getRate(request.currencyId, baseCode, date);
      } catch {
        // No rate configured — keep the caller-supplied rate (or 1).
      }
    }
    let lines = normalizeLines(request.lines, rate);

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

    // D2-3: rounding tolerance. If the entry is unbalanced by less than
    // ROUNDING_EPSILON (default 0.01 — the smallest meaningful unit for an
    // organization with 2-decimal currency), post the delta to the rounding
    // account so the ledger balances EXACTLY. Larger imbalances still throw.
    // We NEVER persist an unbalanced entry (audit C2): a rounding account is
    // resolved or auto-created so the delta always has a home.
    await this.applyRounding(lines, client);

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
        branchId: request.branchId ?? null,
        costCenterId: request.costCenterId ?? null,
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
            branchId: l.branchId ?? request.branchId ?? null,
            costCenterId: l.costCenterId ?? request.costCenterId ?? null,
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
        branchId: original.branchId ?? null,
        costCenterId: original.costCenterId ?? null,
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
            branchId: l.branchId ?? null,
            costCenterId: l.costCenterId ?? null,
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

  // ─── Rounding ─────────────────────────────────────────────────────────────

  /**
   * Ensure the base-currency lines balance. A residual ≤ 0.01 is posted to a
   * rounding account so the entry balances EXACTLY; a larger imbalance is
   * rejected. We NEVER persist an unbalanced entry (audit C2) — if no `rounding`
   * mapping exists, a protected system account is auto-created on first use.
   */
  private async applyRounding(lines: NormalizedLine[], client: any): Promise<void> {
    const t = totals(lines);
    const imbalance = t.debit.minus(t.credit);
    if (imbalance.isZero()) return;
    if (imbalance.abs().greaterThan(dec(0.01))) {
      throw new BadRequestException(
        `Unbalanced entry: total debit ${t.debit.toString()} != total credit ${t.credit.toString()}`,
      );
    }
    const roundingAccountId = await this.resolveRoundingAccount(client);
    const abs = imbalance.abs();
    lines.push(
      imbalance.greaterThan(0)
        ? { accountId: roundingAccountId, debit: ZERO, credit: abs, baseDebit: ZERO, baseCredit: abs }
        : { accountId: roundingAccountId, debit: abs, credit: ZERO, baseDebit: abs, baseCredit: ZERO },
    );
  }

  /** Resolve the 'rounding' account, auto-creating a protected system account on first use. */
  private async resolveRoundingAccount(client: any): Promise<string> {
    const organizationId = this.tenant.organizationId;
    const mapping = await client.accountMapping.findFirst({ where: { key: 'rounding' } });
    if (mapping) return mapping.accountId;
    let acct = await client.account.findFirst({ where: { code: 'ROUNDING' } });
    if (!acct) {
      acct = await client.account.create({
        data: {
          organizationId,
          code: 'ROUNDING',
          name: 'Rounding Differences',
          accountType: 'expense',
          cashFlowCategory: 'operating',
          isSystem: true,
          isProtected: true,
        },
      });
    }
    await client.accountMapping.upsert({
      where: { organizationId_key: { organizationId, key: 'rounding' } },
      create: { organizationId, key: 'rounding', accountId: acct.id },
      update: {},
    });
    return acct.id;
  }

  // ─── Manual JE maker-checker (draft → post) ───────────────────────────────

  /**
   * Stage a manual journal entry as a DRAFT (validated + balanced, but not yet
   * in the books). A different user must approve it via `postDraft` before it
   * affects any balance (maker-checker, audit fix #5). Drafts get a temporary
   * `DRAFT-<uuid>` number; the real gap-free sequence number is assigned at post.
   */
  async stageDraft(request: PostingRequest, tx?: any): Promise<any> {
    return tx ? this.doStageDraft(request, tx) : this.prisma.client.$transaction((c: any) => this.doStageDraft(request, c));
  }

  private async doStageDraft(request: PostingRequest, client: any): Promise<any> {
    if (!request.lines || request.lines.length < 2) {
      throw new BadRequestException('A journal entry requires at least two lines');
    }
    const journal = await client.journal.findFirst({ where: { code: request.journalCode } });
    if (!journal) throw new BadRequestException(`Journal '${request.journalCode}' not found`);

    const date = new Date(request.date);
    const org = await client.organization.findUnique({ where: { id: this.tenant.organizationId } });
    const baseCode = org?.currencyCode ?? 'USD';
    let rate = dec(request.exchangeRate ?? 1);
    if (request.currencyId && request.currencyId !== baseCode) {
      try {
        rate = await this.currency.getRate(request.currencyId, baseCode, date);
      } catch {
        // keep caller-supplied rate
      }
    }
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

    await this.applyRounding(lines, client);

    const organizationId = this.tenant.organizationId;
    return client.journalEntry.create({
      data: {
        organizationId,
        journalId: journal.id,
        entryNumber: `DRAFT-${randomUUID()}`,
        postingDate: date,
        description: request.description ?? null,
        status: 'draft',
        currencyId: request.currencyId ?? null,
        sourceType: request.sourceType ?? null,
        sourceId: request.sourceId ?? null,
        branchId: request.branchId ?? null,
        costCenterId: request.costCenterId ?? null,
        createdBy: this.tenant.userId ?? null,
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
            branchId: l.branchId ?? request.branchId ?? null,
            costCenterId: l.costCenterId ?? request.costCenterId ?? null,
            lineNumber: i + 1,
          })),
        },
      },
      include: { lines: true },
    });
  }

  /**
   * Approve + post a DRAFT entry. Enforces maker-checker: the approver must
   * differ from the user who created the draft. Assigns the real sequence number
   * and runs period control at the moment of posting.
   */
  async postDraft(entryId: string, tx?: any): Promise<any> {
    return tx ? this.doPostDraft(entryId, tx) : this.prisma.client.$transaction((c: any) => this.doPostDraft(entryId, c));
  }

  private async doPostDraft(entryId: string, client: any): Promise<any> {
    const draft = await client.journalEntry.findFirst({ where: { id: entryId }, include: { journal: true } });
    if (!draft) throw new NotFoundException('Journal entry not found');
    if (draft.status !== 'draft') throw new BadRequestException('Only draft entries can be posted');
    if (draft.createdBy && this.tenant.userId && draft.createdBy === this.tenant.userId) {
      throw new ForbiddenException('The user who created a journal entry cannot post it (maker-checker).');
    }

    const date = new Date(draft.postingDate);
    await this.fiscalPeriod.assertOpen(date, client);

    const organizationId = this.tenant.organizationId;
    const year = date.getUTCFullYear();
    const entryNumber = await this.sequence.next(
      `journal:${draft.journal.code}:${year}`,
      { prefix: `${draft.journal.code}/${year}/`, padding: 5 },
      client,
    );

    await client.journalEntry.updateMany({
      where: { id: draft.id },
      data: { entryNumber, status: 'posted', postedAt: new Date(), postedBy: this.tenant.userId ?? null },
    });

    this.events.publish('journal.posted', {
      organizationId,
      journalEntryId: draft.id,
      entryNumber,
      sourceType: draft.sourceType,
      sourceId: draft.sourceId,
    });
    return client.journalEntry.findFirst({ where: { id: draft.id }, include: { lines: true } });
  }

  /** Discard a DRAFT entry (and its lines). Posted/reversed entries are immutable. */
  async discardDraft(entryId: string): Promise<void> {
    await this.prisma.client.$transaction(async (client: any) => {
      const draft = await client.journalEntry.findFirst({ where: { id: entryId } });
      if (!draft) throw new NotFoundException('Journal entry not found');
      if (draft.status !== 'draft') throw new BadRequestException('Only draft entries can be discarded');
      await client.journalLine.deleteMany({ where: { journalEntryId: entryId } });
      await client.journalEntry.deleteMany({ where: { id: entryId } });
    });
  }
}
