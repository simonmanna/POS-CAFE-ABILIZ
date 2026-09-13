import { recordBusinessOutcome } from '../../../kernel/idempotency/business-outcome';
import { BadRequestException } from '@nestjs/common';
import { dec } from '../../../kernel/common/money';

export async function accountLedgerBalance(tx: any, organizationId: string, accountId: string) {
  const totals = await tx.journalLine.aggregate({ where: { organizationId, accountId, entry: { status: { in: ['posted', 'reversed'] } } }, _sum: { debit: true, credit: true } });
  return dec(totals._sum.debit ?? 0).minus(totals._sum.credit ?? 0);
}

export async function accountObservations(tx: any, organizationId: string, input?: Record<string, number | string>) {
  const rows: Record<string, any> = {};
  for (const [id, value] of Object.entries(input ?? {})) {
    const amount = dec(value);
    if (!amount.isFinite() || amount.lt(0)) throw new BadRequestException('Account balances must be non-negative numbers');
    const account = await tx.account.findFirst({ where: { id, organizationId, isActive: true, deletedAt: null }, include: { category: true } });
    if (!account || !['bank', 'mobile_money', 'current_asset'].includes(account.category?.key)) throw new BadRequestException('Select a bank, wallet or card clearing account');
    if (account.category.key === 'current_asset') {
      const mapping = await tx.accountMapping.findFirst({ where: { organizationId, key: 'card_clearing' } });
      if (mapping?.accountId !== id) throw new BadRequestException('Select the configured card clearing account');
    }
    const ledger = await accountLedgerBalance(tx, organizationId, id);
    rows[id] = { ledger: ledger.toString(), difference: amount.minus(ledger).toString(), accountId: id, code: account.code, name: account.name, accountType: account.category.key, observed: amount.toString() };
  }
  return rows;
}

/** Compare monetary evidence, not merely whether a journal balances. */
export async function reconcileSession(tx: any, organizationId: string, session: any) {
  const [payments, movements, invoices, unsettledOrders, postingJobs, register] = await Promise.all([
    tx.payment.findMany({ where: { organizationId, cashSessionId: session.id, status: { not: 'cancelled' } }, include: { allocations: true } }),
    tx.cashMovement.findMany({ where: { organizationId, cashSessionId: session.id } }),
    tx.invoice.findMany({ where: { organizationId, cashSessionId: session.id, status: { not: 'cancelled' } }, include: { items: true } }),
    tx.order.count({ where: { organizationId, cashSessionId: session.id, invoiceId: null, status: { notIn: ['closed', 'cancelled'] }, items: { some: { cancelled: false } } } }),
    tx.stockPostingJob.count({ where: { organizationId, status: { not: 'done' }, invoiceId: { in: (await tx.invoice.findMany({ where: { organizationId, cashSessionId: session.id }, select: { id: true } })).map((i: any) => i.id) } } }),
    tx.cashRegister.findFirst({ where: { id: session.cashRegisterId, organizationId } }),
  ]);
  const issues: string[] = [];
  const drawerAccountId = session.drawerAccountId ?? register?.defaultAccountId;
  if (!drawerAccountId) issues.push('Session has no immutable drawer account');
  const byAccount: Record<string, any> = {};
  const byMethod: Record<string, { method: string; count: number; total: string }> = {};
  const pendingPayments = invoices.filter((i: any) => i.paymentMode !== 'credit' && ['unsettled', 'partially_settled'].includes(i.settlementStatus) && Number(i.amountResidual) > 0).length;
  for (const p of payments) {
    const sign = p.direction === 'inbound' ? 1 : -1;
    const bucket = byMethod[p.paymentMethod] ?? { method: p.paymentMethod, count: 0, total: '0' };
    bucket.count++; bucket.total = dec(bucket.total).plus(dec(p.amount).times(sign)).toString(); byMethod[p.paymentMethod] = bucket;
    const account = byAccount[p.accountId] ?? { accountId: p.accountId, receipts: '0', refunds: '0', net: '0', paymentIds: [] };
    const field = sign === 1 ? 'receipts' : 'refunds';
    account[field] = dec(account[field]).plus(p.amount).toString(); account.net = dec(account.net).plus(dec(p.amount).times(sign)).toString(); account.paymentIds.push(p.id); byAccount[p.accountId] = account;
    const journal = p.journalEntryId ? await tx.journalEntry.findFirst({ where: { id: p.journalEntryId, organizationId }, include: { lines: true } }) : null;
    if (!journal || journal.status !== 'posted') { issues.push(`Payment ${p.paymentNumber} has no active posted journal`); continue; }
    const posted = journal.lines.filter((l: any) => l.accountId === p.accountId).reduce((n: any, l: any) => n.plus(dec(l.debit).minus(l.credit)), dec(0));
    if (!posted.eq(dec(p.amount).times(sign))) issues.push(`Payment ${p.paymentNumber} differs from its account journal`);
    const allocatedAR: Record<string, any> = {};
    for (const allocation of p.allocations.filter((a: any) => a.invoiceId)) {
      const invoice = await tx.invoice.findFirst({ where: { id: allocation.invoiceId, organizationId } });
      if (!invoice?.receivableAccountId) issues.push(`Payment ${p.paymentNumber} has an unverified invoice receivable`);
      else allocatedAR[invoice.receivableAccountId] = dec(allocatedAR[invoice.receivableAccountId] ?? 0).plus(allocation.amount);
    }
    for (const [accountId, allocated] of Object.entries(allocatedAR)) {
      const credited = journal.lines.filter((l: any) => l.accountId === accountId && l.partnerId === p.partnerId).reduce((n: any, l: any) => n.plus(dec(l.credit).minus(l.debit)), dec(0));
      if (!credited.eq(allocated as any)) issues.push(`Payment ${p.paymentNumber} does not clear the allocated receivable amount`);
    }
    const cashMoves = movements.filter((m: any) => m.paymentId === p.id);
    if (p.paymentMethod === 'cash') {
      if (p.accountId !== drawerAccountId || cashMoves.length !== 1 || !dec(cashMoves[0].amount).eq(p.amount) || cashMoves[0].movementType !== (sign === 1 ? 'sale' : 'refund')) issues.push(`Payment ${p.paymentNumber} differs from the physical drawer movement`);
    } else if (cashMoves.length) issues.push(`Electronic payment ${p.paymentNumber} incorrectly moved drawer cash`);
  }
  for (const m of movements.filter((m: any) => !m.paymentId)) {
    const journal = await tx.journalEntry.findFirst({ where: { organizationId, ...(m.journalEntryId ? { id: m.journalEntryId } : { sourceType: 'cash_movement', sourceId: m.id }), status: { in: ['posted', 'reversed'] } }, include: { lines: true } });
    if (!journal) { issues.push(`Drawer movement ${m.id} has no posted journal`); continue; }
    const expected = dec(m.amount).times(m.movementType === 'pay_out' ? -1 : 1);
    const actual = journal.lines.filter((l: any) => l.accountId === drawerAccountId).reduce((s: any, l: any) => s.plus(dec(l.debit).minus(l.credit)), dec(0));
    if (!expected.eq(actual)) issues.push(`Drawer movement ${m.id} differs from the register cash account`);
  }
  const settlements = await tx.tenderSettlement.findMany({ where: { organizationId, cashSessionId: session.id } });
  for (const account of Object.values(byAccount) as any[]) {
    const master = await tx.account.findFirst({ where: { id: account.accountId, organizationId } });
    account.name = master?.name; account.code = master?.code;
    account.settled = settlements.filter((s: any) => s.sourceAccountId === account.accountId).reduce((n: any, s: any) => n.plus(s.grossAmount), dec(0)).toString();
    account.pendingSettlement = dec(account.net).minus(account.settled).toString();
  }
  const movementTotal = (type: string) => movements.filter((m: any) => m.movementType === type).reduce((s: any, m: any) => s.plus(m.amount), dec(0));
  const expectedCash = dec(session.openingFloat).plus(movementTotal('sale')).plus(movementTotal('pay_in')).plus(movementTotal('adjustment')).minus(movementTotal('pay_out')).minus(movementTotal('refund'));
  const sumInvoices = (field: string) => invoices.reduce((n: any, i: any) => n.plus(i[field] ?? 0), dec(0)).toString();
  const ledgerCash = drawerAccountId ? await accountLedgerBalance(tx, organizationId, drawerAccountId) : dec(0);
  const expectedLedger = session.status === 'open' ? expectedCash : dec(session.closingCounted ?? expectedCash);
  // A later shift may legitimately change this account; only the open drawer owns today's balance.
  if (session.status === 'open' && !ledgerCash.eq(expectedLedger)) issues.push('Physical drawer movements differ from the register ledger balance');
  const refundEvents = await tx.posRefund.findMany({ where: { organizationId, cashSessionId: session.id } });
  const categories: Record<string, any> = {};
  let approvedDiscounts = dec(0);
  for (const invoice of invoices) for (const item of invoice.items ?? []) {
    const catalog = item.menuItemId
      ? await tx.menuItem.findFirst({ where: { id: item.menuItemId, organizationId }, include: { category: true } })
      : item.productId ? await tx.product.findFirst({ where: { id: item.productId, organizationId }, include: { category: true } }) : null;
    const category = catalog?.category;
    const key = category?.id ?? 'uncategorised';
    const bucket = categories[key] ?? { categoryId: category?.id ?? null, categoryName: category?.name ?? 'Uncategorised', count: 0, total: '0' };
    bucket.count += Number(item.quantity); bucket.total = dec(bucket.total).plus(item.total).toString(); categories[key] = bucket;
    if (item.discountApprovedBy) approvedDiscounts = approvedDiscounts.plus(item.discountAmount ?? 0);
  }
  const cashier = await tx.user.findFirst({ where: { id: session.userId, organizationId }, select: { firstName: true, lastName: true } });
  return { ledgerCash: ledgerCash.toString(), unsettledOrders, pendingPayments, pendingPostings: postingJobs, issues, accounts: Object.values(byAccount), settlements, byMethod: Object.values(byMethod),
    report: { asOf: new Date().toISOString(), cashSession: { registerName: register.name, cashierName: cashier ? `${cashier.firstName} ${cashier.lastName ?? ''}`.trim() : session.userId, id: session.id, cashRegisterId: session.cashRegisterId, userId: session.userId, openedAt: session.openedAt, openingFloat: String(session.openingFloat) },
      totals: { grossSales: sumInvoices('totalAmount'), netRevenue: sumInvoices('subtotal'), taxTotal: sumInvoices('taxAmount'), discountTotal: sumInvoices('discountTotal'), overridesTotal: approvedDiscounts.toString(), refundedTotal: refundEvents.reduce((n: any, r: any) => n.plus(r.amount), dec(0)).toString(), saleCount: invoices.length, salesTotal: invoices.reduce((s: any, i: any) => s.plus(i.totalAmount), dec(0)).toString(), cashCollected: movementTotal('sale').toString(), cashRefunds: movementTotal('refund').toString(), payInsTotal: movementTotal('pay_in').toString(), payOutsTotal: movementTotal('pay_out').toString(), adjustments: movementTotal('adjustment').toString(), expectedCash: expectedCash.toString() }, byMethod: Object.values(byMethod), byCategory: Object.values(categories), refunds: refundEvents } };
}

export async function settleTender(ctx: any, input: any) {
  const org = ctx.tenant.organizationId;
  const gross = dec(input.grossAmount), fee = dec(input.feeAmount ?? 0);
  if (!gross.isFinite() || !gross.gt(0) || !fee.isFinite() || fee.lt(0) || fee.gt(gross) || !input.reference?.trim()) throw new BadRequestException('Enter a positive gross settlement, valid fee and provider reference');
  return ctx.prisma.client.$transaction(async (tx: any) => {
    const accounts = await accountObservations(tx, org, { [input.sourceAccountId]: 0, [input.destinationAccountId]: 0 });
    if (input.sourceAccountId === input.destinationAccountId || accounts[input.destinationAccountId].accountType !== 'bank') throw new BadRequestException('Settlement must move to a different bank account');
    if (input.cashSessionId) {
      await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', input.cashSessionId, org);
      const session = await tx.cashSession.findFirst({ where: { id: input.cashSessionId, organizationId: org } });
      if (!session) throw new BadRequestException('Session is unavailable');
      // Provider settlement may arrive days after physical cash was reconciled.
      // Its own posting date/period is checked by PostingService; the frozen Z-report stays intact.
    }
    await tx.$queryRawUnsafe('SELECT id FROM "Account" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', input.sourceAccountId, org);
    const original = await tx.tenderSettlement.findFirst({ where: { organizationId: org, sourceAccountId: input.sourceAccountId, reference: input.reference.trim() } });
    if (original) {
      if (!gross.eq(original.grossAmount) || !fee.eq(original.feeAmount) || original.destinationAccountId !== input.destinationAccountId || (original.cashSessionId ?? null) !== (input.cashSessionId ?? null) || (original.feeAccountId ?? null) !== (input.feeAccountId ?? null) || original.settledAt.toISOString() !== new Date(input.settledAt).toISOString()) throw new BadRequestException('Provider reference already belongs to a different settlement');
      await recordBusinessOutcome(tx, original, true);
      return original;
    }
    if (gross.gt(await accountLedgerBalance(tx, org, input.sourceAccountId))) throw new BadRequestException('Settlement exceeds the available source-account balance');
    if (input.cashSessionId) {
      const payments = await tx.payment.findMany({ where: { organizationId: org, cashSessionId: input.cashSessionId, accountId: input.sourceAccountId, status: { not: 'cancelled' } } });
      const net = payments.reduce((n: any, p: any) => n.plus(dec(p.amount).times(p.direction === 'inbound' ? 1 : -1)), dec(0));
      const prior = await tx.tenderSettlement.aggregate({ where: { organizationId: org, cashSessionId: input.cashSessionId, sourceAccountId: input.sourceAccountId }, _sum: { grossAmount: true } });
      if (gross.gt(net.minus(prior._sum.grossAmount ?? 0))) throw new BadRequestException('Settlement exceeds this session’s outstanding provider receipts');
    }
    const lines: any[] = [{ accountId: input.sourceAccountId, credit: gross.toString() }, { accountId: input.destinationAccountId, debit: gross.minus(fee).toString() }];
    if (fee.gt(0)) {
      const expense = await tx.account.findFirst({ where: { id: input.feeAccountId, organizationId: org, isActive: true }, include: { category: true } });
      if (!expense || expense.category?.classification !== 'expense') throw new BadRequestException('Select an expense account for provider fees');
      lines.push({ accountId: expense.id, debit: fee.toString() });
    }
    const id = crypto.randomUUID();
    const entry = await ctx.posting.post({ journalCode: 'BANK', date: input.settledAt, description: `Provider settlement ${input.reference}`, sourceType: 'tender_settlement', sourceId: id, lines }, tx);
    const result = await tx.tenderSettlement.create({ data: { id, organizationId: org, cashSessionId: input.cashSessionId, sourceAccountId: input.sourceAccountId, destinationAccountId: input.destinationAccountId, grossAmount: gross, feeAmount: fee, feeAccountId: input.feeAccountId, reference: input.reference.trim(), settledAt: new Date(input.settledAt), journalEntryId: entry.id, createdBy: ctx.tenant.userId } });
    await ctx.audit.recordInTx(tx, { entity: 'TenderSettlement', entityId: id, action: 'create', newValues: { sourceAccountId: input.sourceAccountId, destinationAccountId: input.destinationAccountId, gross: gross.toString(), fee: fee.toString(), reference: input.reference } });
    await recordBusinessOutcome(tx, result, true);
    return result;
  });
}
