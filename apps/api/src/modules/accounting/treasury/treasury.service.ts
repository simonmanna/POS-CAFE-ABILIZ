import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { PostingService } from '../posting/posting.service';
import { TransferDto } from './dto/bank-account.dto';
import { AccountResolverService } from '../posting/account-resolver.service';
import { BALANCE_AFFECTING_STATUSES } from '../posting/posting.types';
import { dec } from '../../../kernel/common/money';

/**
 * Treasury operations (transfers between cash/bank accounts) post through the
 * PostingService — no separate cash ledger (ADR-009). Customer/supplier
 * receipts & payments live in the Payment module (Phase 3).
 */
@Injectable()
export class TreasuryService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly events: EventBus,
    private readonly posting: PostingService,
    private readonly prisma: PrismaService,
    private readonly accounts: AccountResolverService,
  ) {}

  async transfer(dto: TransferDto) {
    if (dto.fromAccountId === dto.toAccountId) throw new BadRequestException('Source and destination accounts must differ');
    const organizationId = this.tenant.organizationId;
    const cashIds = await this.accounts.cashEquivalentIds();
    if (!cashIds.includes(dto.fromAccountId) || !cashIds.includes(dto.toAccountId)) {
      throw new BadRequestException('Transfers require two active payment accounts');
    }
    const balance = await this.prisma.client.journalLine.aggregate({
      where: { organizationId, accountId: dto.fromAccountId, entry: { status: { in: [...BALANCE_AFFECTING_STATUSES] } } },
      _sum: { baseDebit: true, baseCredit: true },
    });
    if (dec(balance._sum.baseDebit ?? 0).minus(balance._sum.baseCredit ?? 0).lt(dto.amount)) {
      throw new BadRequestException('Source account has insufficient available funds');
    }
    const operationId = randomUUID();
    const entry = await this.posting.post({
      journalCode: 'BANK',
      date: dto.date,
      description: dto.reference ?? 'Funds transfer',
      sourceType: 'treasury_transfer',
      sourceId: operationId,
      postingKey: `treasury:transfer:${operationId}`,
      lines: [
        { accountId: dto.toAccountId, debit: dto.amount },
        { accountId: dto.fromAccountId, credit: dto.amount },
      ],
    });
    this.events.publish('bank.transfer', {
      organizationId,
      journalEntryId: entry.id,
      amount: String(dto.amount),
    });
    return entry;
  }
}
