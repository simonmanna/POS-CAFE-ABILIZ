import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { PostingService } from '../posting/posting.service';
import { TransferDto } from './dto/bank-account.dto';
import { AuditService } from '../../../kernel/audit/audit.service';
import { recordBusinessOutcome } from '../../../kernel/idempotency/business-outcome';
import { assertNotDrawerAccount, assertSufficientFunds, lockAccounts, operationId, requireAccount } from './treasury-guards';
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
    private readonly audit: AuditService,
  ) {}

  /**
   * Transfer between two payment accounts (bank ↔ bank, bank ↔ wallet, safe ↔
   * bank). Register drawers are excluded: cash leaves a drawer through its
   * shift (pay-out / banking) so the physical count and the ledger move
   * together. Accounts are locked before the balance check; the posting key is
   * derived from the Idempotency-Key.
   */
  async transfer(dto: TransferDto) {
    if (dto.fromAccountId === dto.toAccountId) throw new BadRequestException('Source and destination accounts must differ');
    const amount = dec(dto.amount);
    if (!amount.isFinite() || !amount.gt(0)) throw new BadRequestException('Transfer amount must be positive');
    const organizationId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      await lockAccounts(tx, organizationId, [dto.fromAccountId, dto.toAccountId]);
      const from = await requireAccount(tx, organizationId, dto.fromAccountId, 'Source account');
      const to = await requireAccount(tx, organizationId, dto.toAccountId, 'Destination account');
      if (!from.category?.isCashEquivalent || !to.category?.isCashEquivalent) {
        throw new BadRequestException('Transfers require two active payment accounts');
      }
      if ((from.currencyId ?? null) !== (to.currencyId ?? null)) {
        throw new BadRequestException('Transfers between different currencies need an FX conversion, not a transfer');
      }
      await assertNotDrawerAccount(tx, organizationId, from.id, 'A transfer');
      await assertNotDrawerAccount(tx, organizationId, to.id, 'A transfer');
      await assertSufficientFunds(tx, organizationId, from.id, amount, from.name);
      const id = operationId();
      const entry = await this.posting.post({
        journalCode: 'BANK',
        date: dto.date,
        description: dto.reference ? `Funds transfer: ${dto.reference}` : `Funds transfer ${from.code} → ${to.code}`,
        sourceType: 'treasury_transfer',
        sourceId: id,
        postingKey: `treasury:transfer:${id}`,
        lines: [
          { accountId: to.id, debit: amount.toString() },
          { accountId: from.id, credit: amount.toString() },
        ],
      }, tx);
      await this.audit.recordInTx(tx, {
        entity: 'TreasuryOperation', entityId: id, action: 'create',
        newValues: { direction: 'transfer', fromAccountId: from.id, toAccountId: to.id, amount: amount.toString(), journalEntryId: entry.id },
      });
      await recordBusinessOutcome(tx, entry, true);
      this.events.publish('bank.transfer', { organizationId, journalEntryId: entry.id, amount: amount.toString() });
      return entry;
    });
  }
}
