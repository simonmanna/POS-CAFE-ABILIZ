import { BadRequestException } from '@nestjs/common';

export type TenderMethod = 'cash' | 'bank' | 'card' | 'mobile_money' | 'store_credit';

/** Tender kinds a POS payment method may be configured as (`cheque` is
 *  accepted by the resolver for invoice collections but has no POS tile). */
export const POS_TENDER_METHODS: TenderMethod[] = ['cash', 'bank', 'card', 'mobile_money', 'store_credit'];

/**
 * Which AccountCategory keys may back each tender method. Exported so POS
 * payment-method configuration validates against the SAME rule the posting
 * engine enforces below — a tile that saves can never produce a tender this
 * resolver later rejects.
 */
export const ALLOWED_CATEGORIES_BY_METHOD: Record<string, string[]> = {
  cash: ['cash', 'petty_cash'], bank: ['bank'], cheque: ['bank'], card: ['bank', 'current_asset'],
  mobile_money: ['mobile_money'], store_credit: ['current_liabilities', 'other_current_liabilities'],
};

/** One resolver for POS, invoice collections and refunds. No electronic-to-cash fallback. */
export async function resolveTenderAccount(
  tx: any, determination: any, organizationId: string,
  input: { method: string; accountId?: string; cashSessionId?: string },
): Promise<{ accountId: string; journalCode: string; session: any }> {
  const { method } = input;
  if (!['cash', 'bank', 'cheque', 'card', 'mobile_money', 'store_credit'].includes(method)) {
    throw new BadRequestException('Unsupported payment method');
  }
  let session: any = null;
  if (input.cashSessionId) {
    // Close, payment and refund take the same lock before touching the drawer.
    await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', input.cashSessionId, organizationId);
    session = await tx.cashSession.findFirst({ where: { id: input.cashSessionId, organizationId }, include: { cashRegister: true } });
    if (!session || session.status !== 'open') throw new BadRequestException('The selected register session is closed or unavailable. Resolve this sale before changing its register.');
  }
  let accountId = input.accountId;
  if (method === 'cash' && session) {
    // The drawer captured when the shift opened; register edits never redirect a live shift.
    const drawer = session.drawerAccountId ?? session.cashRegister.defaultAccountId;
    if (accountId && accountId !== drawer) throw new BadRequestException('Cash must use the selected register’s drawer account');
    accountId = drawer;
  }
  if (!accountId) {
    const key: Record<string, string> = { cash: 'default_cash', bank: 'default_bank', cheque: 'default_bank', card: 'card_clearing', mobile_money: 'mobile_money', store_credit: 'store_credit' };
    try { accountId = await determination.mapped(key[method], tx); }
    catch { throw new BadRequestException(`Select a named ${method.replace('_', ' ')} account or configure its account mapping`); }
  }
  const account = await tx.account.findFirst({ where: { id: accountId, organizationId, isActive: true, deletedAt: null }, include: { category: true } });
  if (!account) throw new BadRequestException('Payment account is inactive or unavailable');
  const category = account.category?.key;
  if (account.currencyId) {
    const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { currencyCode: true } });
    if (org && account.currencyId !== org.currencyCode) throw new BadRequestException('POS tenders must use the organization currency; convert foreign currency through treasury first');
  }
  const allowed = ALLOWED_CATEGORIES_BY_METHOD;
  // Store credit must use the configured liability, regardless of category naming.
  if (method === 'store_credit') {
    if (account.id !== await determination.mapped('store_credit', tx)) throw new BadRequestException('Store credit must use its configured liability account');
  } else if (!allowed[method].includes(category)) {
    throw new BadRequestException(`Account ${account.name} is not a ${method.replace('_', ' ')} account`);
  }
  if (method === 'card' && category === 'current_asset' && account.id !== await determination.mapped('card_clearing', tx)) throw new BadRequestException('Card clearing must use the configured card clearing account');
  return { accountId: account.id, journalCode: method === 'cash' ? 'CASH' : method === 'store_credit' ? 'GEN' : 'BANK', session };
}
