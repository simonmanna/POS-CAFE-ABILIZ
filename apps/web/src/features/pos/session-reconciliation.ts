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
}

export interface SessionReconciliationData {
  ledgerCash: string;
  unsettledOrders: number;
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
  if (recon.unsettledOrders) {
    out.push({
      text: `${recon.unsettledOrders} order${s(recon.unsettledOrders)} still open on the floor`,
      hint: 'Settle or cancel them in the terminal, then check again.',
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

/** How many distinct problems to announce in the heading. */
export function blockerCount(groups: BlockerGroup[]): number {
  return groups.reduce((n, g) => n + (g.items?.length ?? 1), 0);
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
  /** opening + received − refunds. */
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
    const openingKnown = raw != null;
    const opening = toNum(typeof raw === 'object' && raw !== null ? raw.observed : raw);
    const received = toNum(r?.receipts);
    const refunds = toNum(r?.refunds);
    const expected = opening + received - refunds;
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
      pendingSettlement: toNum(r?.pendingSettlement),
      counted,
      variance: counted == null ? null : counted - expected,
    };
  });
}
