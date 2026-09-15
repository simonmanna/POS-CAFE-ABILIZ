import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** One tender account's movement across a shift, as the ledger recorded it. */
export interface ReconAccount {
  accountId: string;
  receipts: string;
  refunds: string;
  net: string;
  settled?: string;
  pendingSettlement?: string;
  name?: string;
  code?: string;
  /**
   * Server-computed shift expectation (sessionProviderExpectations). The close
   * validation uses exactly these figures, so the dialog must not re-derive them.
   */
  opening?: string;
  openingKnown?: boolean;
  settledOut?: string;
  settledIn?: string;
  movementsIn?: string;
  movementsOut?: string;
  expected?: string;
}

/** An order still open on the floor (org-wide while the shift is open). */
export interface OpenOrderSummary {
  id: string;
  orderNumber: string;
  orderType: string | null;
  tableName: string | null;
  waiterName: string | null;
  cashSessionId: string | null;
  openedAt: string;
  totalAmount: string;
}

export interface SessionReconciliationData {
  ledgerCash: string;
  unsettledOrders: number;
  /** Full count — the blocker. `openOrders` holds at most the first 50. */
  openOrderCount?: number;
  openOrders?: OpenOrderSummary[];
  pendingPayments: number;
  pendingPostings: number;
  issues: string[];
  accounts: ReconAccount[];
  byMethod: { method: string; count: number; total: string }[];
  report: any;
}

/**
 * Close-readiness + per-account evidence for one cash session.
 *
 * Shared by the Cash Register page and the Close Shift dialog on one query key,
 * so the two never show the cashier different numbers.
 */
export function useSessionReconciliation(sessionId?: string, refetchMs = 20_000) {
  return useQuery({
    queryKey: ['session-reconciliation', sessionId],
    enabled: !!sessionId,
    queryFn: async () =>
      (await api.get(`/cash-sessions/${sessionId}/reconciliation`)).data as SessionReconciliationData,
    refetchInterval: refetchMs,
  });
}

export interface BlockerGroup {
  text: string;
  hint: string;
  /** Raw server findings behind this group, if it stands for more than itself. */
  items?: string[];
  /** How many problems the group stands for when `items` is only a sample. */
  count?: number;
}

/**
 * Turn raw readiness counters into things a cashier can act on.
 *
 * The ledger checks are grouped rather than listed one-per-line: a drawer with
 * seven unverified payments would otherwise repeat the same advice seven times,
 * which reads as seven separate problems.
 */
export function closeBlockers(recon?: SessionReconciliationData): BlockerGroup[] {
  if (!recon) return [];
  const out: BlockerGroup[] = [];
  const s = (n: number) => (n === 1 ? '' : 's');
  const openCount = recon.openOrderCount ?? recon.unsettledOrders;
  if (openCount) {
    const listed = recon.openOrders ?? [];
    const items = listed.map(openOrderLine);
    if (openCount > listed.length && listed.length) items.push(`+${openCount - listed.length} more`);
    out.push({
      text: `${openCount} open order${s(openCount)} must be settled or voided`,
      hint: 'Settle them, or void them through the normal order controls (manager approval applies), then check again.',
      items: items.length ? items : undefined,
      count: openCount,
    });
  }
  if (recon.pendingPayments) {
    out.push({
      text: `${recon.pendingPayments} sale${s(recon.pendingPayments)} not fully paid`,
      hint: 'Take the balance, or move it to the customer’s house account.',
    });
  }
  if (recon.pendingPostings) {
    out.push({
      text: `${recon.pendingPostings} stock posting${s(recon.pendingPostings)} still running`,
      hint: 'These normally finish in a few seconds — check again shortly.',
    });
  }
  const issues = recon.issues ?? [];
  if (issues.length) {
    out.push({
      text: `${issues.length} bookkeeping check${s(issues.length)} did not pass`,
      hint: 'A manager needs to look at these before the drawer closes.',
      items: issues,
    });
  }
  return out;
}

const ORDER_TYPE_LABEL: Record<string, string> = {
  dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery', counter: 'Counter',
};

/** "Table 4 · ORD-123 · Mary · 45,000" — enough for a cashier to find it on the floor. */
export function openOrderLine(o: OpenOrderSummary): string {
  const where = o.tableName ? `Table ${o.tableName}` : ORDER_TYPE_LABEL[o.orderType ?? ''] ?? 'Order';
  const total = toNum(o.totalAmount).toLocaleString();
  return [where, o.orderNumber, o.waiterName, total].filter(Boolean).join(' · ');
}

/** How many distinct problems to announce in the heading. */
export function blockerCount(groups: BlockerGroup[]): number {
  return groups.reduce((n, g) => n + (g.count ?? g.items?.length ?? 1), 0);
}

/* ------------------------------------------- per-account tender reconciliation */

/** One wallet / bank / clearing account's shift movement, ready to render. */
export interface TenderAccountRow {
  accountId: string;
  /** The payment method(s) that collect into this account, e.g. "MTN MoMo". */
  label: string;
  accountName: string;
  accountCode: string;
  opening: number;
  /** False when nobody recorded an opening balance for this account. */
  openingKnown: boolean;
  received: number;
  refunds: number;
  /** Settlements and drawer transfers in (+) / out (−) of the account this shift. */
  otherMovements: number;
  /** opening + received − refunds + otherMovements (server-computed). */
  expected: number;
  /** Still sitting with the provider, not yet swept to the bank. */
  pendingSettlement: number;
  /** What the cashier says the provider shows now, or null if not counted. */
  counted: number | null;
  /** counted − expected, or null when uncounted. */
  variance: number | null;
}

const toNum = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Fold the ledger's per-account movement together with the opening balances
 * captured at shift open and whatever the cashier has counted so far.
 *
 * Shared by the Cash Register panel and the Close Shift dialog so the two can
 * never show a cashier different numbers for the same account. Physical drawer
 * cash is deliberately absent — it is counted on its own, with pay-ins,
 * pay-outs and adjustments the server folds into `expectedCash`.
 */
export function tenderAccountRows(input: {
  /** Accounts to report on, from `shiftTrackedAccounts(methods)`. */
  accounts: { accountId: string; label: string; accountName: string; accountCode: string }[];
  recon?: SessionReconciliationData;
  /** `CashSession.openingAccounts` — accountId → observation. */
  openingAccounts?: Record<string, any>;
  /** Closing figures being entered right now, accountId → amount. */
  counted?: Record<string, number>;
}): TenderAccountRow[] {
  const byAccount = new Map<string, ReconAccount>();
  for (const a of input.recon?.accounts ?? []) byAccount.set(a.accountId, a);

  return input.accounts.map((a) => {
    const r = byAccount.get(a.accountId);
    // Opening observations are stored as `{ observed, ledger, difference }` by
    // accountObservations(); older sessions stored a bare number.
    const raw = input.openingAccounts?.[a.accountId];
    const received = toNum(r?.receipts);
    const refunds = toNum(r?.refunds);
    // Prefer the server's figures: they are what the close is validated against.
    // The fallback only covers an older API that does not send them yet.
    const openingKnown = r?.openingKnown ?? raw != null;
    const opening = r?.opening != null ? toNum(r.opening) : toNum(typeof raw === 'object' && raw !== null ? raw.observed : raw);
    const expected = r?.expected != null ? toNum(r.expected) : opening + received - refunds - toNum(r?.settled);
    const countedRaw = input.counted?.[a.accountId];
    const counted = countedRaw == null || Number.isNaN(countedRaw) ? null : Number(countedRaw);
    return {
      accountId: a.accountId,
      label: a.label,
      accountName: a.accountName,
      accountCode: a.accountCode,
      opening,
      openingKnown,
      received,
      refunds,
      expected,
      otherMovements: toNum(r?.settledIn) - toNum(r?.settledOut) + toNum(r?.movementsIn) - toNum(r?.movementsOut),
      pendingSettlement: toNum(r?.pendingSettlement),
      counted,
      variance: counted == null ? null : counted - expected,
    };
  });
}
