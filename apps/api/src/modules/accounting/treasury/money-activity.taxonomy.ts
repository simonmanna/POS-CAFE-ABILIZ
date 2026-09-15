/**
 * Money activity taxonomy — the single source of truth for "what kind of money
 * movement is this journal entry?". Shared by the Money Activity feed and the
 * Cash Flow (movement) report so the two can never disagree.
 *
 * Classification is by `JournalEntry.sourceType`; direction and totals are
 * derived from the entry's lines on cash-equivalent (money) accounts, never
 * defaulted, so an unknown source can still not be shown as the wrong way round.
 */

/** Movement categories, derived from the journal entry's `sourceType`. */
export const CASH_MOVEMENT_CATEGORIES: { key: string; label: string; sourceTypes: string[] }[] = [
  { key: 'pos_sales', label: 'POS Sales', sourceTypes: ['pos', 'pos_invoice', 'pos_invoice_extra', 'pos_payment'] },
  {
    key: 'customer_receipts',
    label: 'Customer Receipts',
    sourceTypes: ['payment', 'invoice', 'sales_invoice', 'document', 'reservation', 'agreement'],
  },
  {
    key: 'refunds',
    label: 'Refunds & Credits',
    sourceTypes: ['pos_refund', 'pos_payment_refund', 'credit_note', 'pos_invoice_writeoff', 'store_credit_issue'],
  },
  {
    key: 'supplier_payments',
    label: 'Supplier Payments',
    sourceTypes: ['purchase_payment', 'payment_outbound', 'vendor_bill', 'debit_note', 'purchase_order', 'goods_receipt'],
  },
  { key: 'expenses', label: 'Expenses', sourceTypes: ['expense_payment'] },
  { key: 'payroll', label: 'Payroll', sourceTypes: ['payroll_run'] },
  { key: 'transfers', label: 'Internal Transfers', sourceTypes: ['treasury_transfer'] },
  { key: 'deposits', label: 'Other Money In', sourceTypes: ['cash_flow_deposit'] },
  { key: 'withdrawals', label: 'Other Money Out', sourceTypes: ['cash_flow_withdrawal'] },
  {
    key: 'cash_drawer',
    label: 'Cash Drawer',
    sourceTypes: [
      'cash_movement',
      'cash_session_opening',
      'cash_session_banking',
      'cash_session_variance',
      'drawer_account_split',
    ],
  },
  { key: 'tender_settlement', label: 'Provider Settlement', sourceTypes: ['tender_settlement'] },
  { key: 'rental', label: 'Rental', sourceTypes: ['rental_checkout', 'rental_inspect', 'rental_return'] },
  {
    key: 'adjustments',
    label: 'Manual & Adjustments',
    sourceTypes: [
      'manual',
      'reversal',
      'fx_revaluation',
      'period_close',
      'recurring',
      'a009_legacy_adjustment',
    ],
  },
];

export const OTHER_CATEGORY = { key: 'other', label: 'Other', sourceTypes: [] as string[] };

export const CATEGORY_OF_SOURCE = new Map<string, string>();
for (const c of CASH_MOVEMENT_CATEGORIES) {
  for (const st of c.sourceTypes) CATEGORY_OF_SOURCE.set(st, c.key);
}
export const KNOWN_SOURCE_TYPES = [...CATEGORY_OF_SOURCE.keys()];

export const CATEGORY_LABEL = new Map<string, string>(
  [...CASH_MOVEMENT_CATEGORIES, OTHER_CATEGORY].map((c) => [c.key, c.label]),
);

export const CATEGORY_OPTIONS = [...CASH_MOVEMENT_CATEGORIES, OTHER_CATEGORY].map((c) => ({
  key: c.key,
  label: c.label,
}));

/**
 * Refine a generic `payment` entry by the Payment behind it (see
 * EFFECTIVE_SOURCE_TYPE in money-activity.sql.ts, which must stay in step).
 */
export function effectiveSourceType(
  sourceType: string | null | undefined,
  payment?: { cashSessionId: string | null; direction: string } | null,
): string | null {
  if (sourceType !== 'payment' || !payment) return sourceType ?? null;
  if (payment.cashSessionId) return payment.direction === 'inbound' ? 'pos_payment' : 'pos_payment_refund';
  return payment.direction === 'outbound' ? 'payment_outbound' : 'payment';
}

export function categoryOf(sourceType: string | null | undefined): string {
  if (!sourceType) return 'other';
  return CATEGORY_OF_SOURCE.get(sourceType) ?? 'other';
}

/** Sources whose money legs only move value between the organisation's own accounts. */
export const INTERNAL_SOURCE_TYPES = new Set([
  'treasury_transfer',
  'tender_settlement',
  'cash_session_banking',
  'drawer_account_split',
]);

/** Sources that correct the books rather than represent an ordinary payment. */
export const ADJUSTMENT_SOURCE_TYPES = new Set([
  'cash_session_variance',
  ...(CASH_MOVEMENT_CATEGORIES.find((c) => c.key === 'adjustments')?.sourceTypes ?? []),
]);

export type MoneyActivityDirection = 'in' | 'out' | 'internal' | 'adjustment';

export interface MoneyLineInput {
  accountId: string;
  accountName: string;
  accountType: string | null;
  baseDebit: string | number;
  baseCredit: string | number;
}

export interface MoneyActivityLeg {
  accountId: string;
  accountName: string;
  accountType: string | null;
  side: 'in' | 'out';
  amount: string;
}

export interface MoneyActivityFigures {
  category: string;
  categoryLabel: string;
  direction: MoneyActivityDirection;
  /** Money-account total on the dominant side (what a person would call "the amount"). */
  grossAmount: string;
  externalIn: string;
  externalOut: string;
  internalMoved: string;
  legs: MoneyActivityLeg[];
}

/** Work in integer minor units (4dp) so sums never drift. */
const toUnits = (v: string | number) => Math.round(Number(v || 0) * 10000);
const fromUnits = (u: number) => (u / 10000).toFixed(2);

/**
 * Classify one journal entry from its lines on money accounts.
 *
 *   externalIn    = max(0, Σdebit − Σcredit)
 *   externalOut   = max(0, Σcredit − Σdebit)
 *   internalMoved = min(Σdebit, Σcredit)
 *
 * e.g. a provider settlement of 100,000 with a 2,000 fee (clearing Cr 100,000,
 * bank Dr 98,000) → internalMoved 98,000, externalOut 2,000.
 */
export function classifyMoneyEntry(
  sourceType: string | null | undefined,
  moneyLines: MoneyLineInput[],
): MoneyActivityFigures {
  const category = categoryOf(sourceType);

  // Net each account first so an account debited and credited in one entry
  // shows as a single leg.
  const perAccount = new Map<string, { line: MoneyLineInput; net: number }>();
  let debit = 0;
  let credit = 0;
  for (const l of moneyLines) {
    const d = toUnits(l.baseDebit);
    const c = toUnits(l.baseCredit);
    debit += d;
    credit += c;
    const cur = perAccount.get(l.accountId) ?? { line: l, net: 0 };
    cur.net += d - c;
    perAccount.set(l.accountId, cur);
  }

  const externalIn = Math.max(0, debit - credit);
  const externalOut = Math.max(0, credit - debit);
  const internalMoved = Math.min(debit, credit);

  const legs: MoneyActivityLeg[] = [...perAccount.values()]
    .filter((a) => a.net !== 0)
    .sort((x, y) => Math.abs(y.net) - Math.abs(x.net))
    .map(({ line, net }) => ({
      accountId: line.accountId,
      accountName: line.accountName,
      accountType: line.accountType,
      side: net > 0 ? ('in' as const) : ('out' as const),
      amount: fromUnits(Math.abs(net)),
    }));

  let direction: MoneyActivityDirection;
  if (sourceType && ADJUSTMENT_SOURCE_TYPES.has(sourceType)) direction = 'adjustment';
  else if (sourceType && INTERNAL_SOURCE_TYPES.has(sourceType) && internalMoved > 0) direction = 'internal';
  else if (externalIn > 0) direction = 'in';
  else if (externalOut > 0) direction = 'out';
  else direction = 'internal';

  return {
    category,
    categoryLabel: CATEGORY_LABEL.get(category) ?? 'Other',
    direction,
    grossAmount: fromUnits(Math.max(debit, credit)),
    externalIn: fromUnits(externalIn),
    externalOut: fromUnits(externalOut),
    internalMoved: fromUnits(internalMoved),
    legs,
  };
}
