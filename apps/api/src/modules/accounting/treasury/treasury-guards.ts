import { BadRequestException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { dec } from '../../../kernel/common/money';
import { businessOperation } from '../../../kernel/idempotency/business-outcome';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Shared money-movement guards for every treasury-style write (deposits,
 * withdrawals, transfers, expense payments). One rule set, one lock order:
 * accounts are always locked in ascending id order before any balance is read.
 */

/** Row-lock the accounts (ascending id) so concurrent balance checks serialise. */
export async function lockAccounts(tx: any, organizationId: string, accountIds: string[]): Promise<void> {
  for (const id of [...new Set(accountIds)].sort()) {
    const rows = await tx.$queryRawUnsafe(
      'SELECT id FROM "Account" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE',
      id, organizationId,
    );
    if (!rows.length) throw new BadRequestException('Account not found');
  }
}

/** Posted ledger balance (debit − credit, base currency). Reversed originals count; their reversal cancels them. */
export async function postedBalance(tx: any, organizationId: string, accountId: string): Promise<Prisma.Decimal> {
  const totals = await tx.journalLine.aggregate({
    where: { organizationId, accountId, entry: { status: { in: ['posted', 'reversed'] } } },
    _sum: { baseDebit: true, baseCredit: true },
  });
  return dec(totals._sum.baseDebit ?? 0).minus(totals._sum.baseCredit ?? 0);
}

/** Negative cash, bank and wallet balances are never allowed. */
export async function assertSufficientFunds(
  tx: any, organizationId: string, accountId: string, amount: Prisma.Decimal | number | string, label = 'Account',
): Promise<void> {
  const balance = await postedBalance(tx, organizationId, accountId);
  if (balance.lt(dec(amount))) {
    throw new BadRequestException(`${label} has insufficient funds (available ${balance.toFixed(2)})`);
  }
}

/**
 * A register's drawer account is only ever moved by its own shift (sales,
 * refunds, pay-ins/outs, banking). Any other posting would change the drawer
 * ledger without a physical drawer movement and break the shift count.
 */
export async function assertNotDrawerAccount(tx: any, organizationId: string, accountId: string, action: string): Promise<void> {
  const register = await tx.cashRegister.findFirst({
    where: { organizationId, defaultAccountId: accountId, deletedAt: null },
    select: { code: true },
  });
  if (register) {
    throw new BadRequestException(`${action} cannot use the drawer account of register ${register.code}. Record it from that register's shift (pay-in, pay-out or banking).`);
  }
}

/** Active, postable account in this organization, with its category. */
export async function requireAccount(tx: any, organizationId: string, accountId: string, label = 'Account') {
  const account = await tx.account.findFirst({
    where: { id: accountId, organizationId, isActive: true, deletedAt: null },
    include: { category: true },
  });
  if (!account) throw new BadRequestException(`${label} not found or inactive`);
  if (account.isPostable === false) throw new BadRequestException(`${label} ${account.code} is a header account and cannot be posted to`);
  return account;
}

/**
 * Stable identity for one business operation. Under an Idempotency-Key the id is
 * derived from (organization, key), so the posting key of a retried request is
 * identical and the unique (organizationId, postingKey) index rejects a duplicate
 * journal even if the idempotency record itself were lost.
 */
export function operationId(): string {
  const op = businessOperation.getStore();
  if (!op) return randomUUID();
  const h = createHash('sha256').update(`${op.organizationId}\n${op.key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
