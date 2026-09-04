import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';

export interface PaymentAccount { id: string; name: string; code: string; accountType: string }
export function accountsForMethod(accounts: PaymentAccount[], method: string) {
  return accounts.filter(a => method === 'mobile_money' ? a.accountType === 'mobile_money' : method === 'card' ? ['bank', 'current_asset'].includes(a.accountType) : method === 'bank' ? a.accountType === 'bank' : false);
}
export function usePaymentAccounts() {
  const org = useAuthStore((s) => s.organization?.id);
  return useQuery({ queryKey: ['pos-payment-accounts', org], queryFn: async () => (await api.get<PaymentAccount[]>('/pos/payment-accounts')).data, staleTime: 60_000 });
}

/**
 * A payment mode the cashier can pick, already bound to the finance account its
 * money lands in. `kind` is what goes on the tender (and on Payment.paymentMethod);
 * `accountId` is what the posting engine debits. The cashier sees `label` and,
 * when a kind has several methods, `provider`.
 */
export interface PosPaymentMethod {
  id: string;
  code: string;
  label: string;
  kind: 'cash' | 'mobile_money' | 'card' | 'bank' | 'store_credit';
  provider: string | null;
  accountId: string | null;
  accountName: string | null;
  accountCode: string | null;
  icon: string;
  sortOrder: number;
  requiresReference: boolean;
  trackInShift: boolean;
  isActive: boolean;
  /** Synthesized from accounts because the org has configured nothing yet. */
  synthetic?: boolean;
}

export function usePosPaymentMethods() {
  const org = useAuthStore((s) => s.organization?.id);
  return useQuery({
    queryKey: ['pos-payment-methods', org],
    queryFn: async () => (await api.get<PosPaymentMethod[]>('/pos/payment-methods')).data,
    staleTime: 60_000,
  });
}

/** Kind order in the Charge dialog. Store credit and credit settlement are appended by the dialog. */
export const TENDER_KIND_ORDER: PosPaymentMethod['kind'][] = ['cash', 'mobile_money', 'card', 'bank'];

export const TENDER_KIND_LABEL: Record<string, string> = {
  cash: 'Cash', mobile_money: 'Mobile Money', card: 'Card', bank: 'Bank', store_credit: 'Store Credit',
};

export const TENDER_KIND_COLOR: Record<string, string> = {
  cash: '#16a34a', mobile_money: '#f59e0b', card: '#1a7fcf', bank: '#8b5cf6', store_credit: '#0ea5e9',
};

/** Group active methods by kind, preserving the server's ordering within a kind. */
export function methodsByKind(methods: PosPaymentMethod[]) {
  const out = new Map<string, PosPaymentMethod[]>();
  for (const m of methods) {
    if (!m.isActive) continue;
    const bucket = out.get(m.kind) ?? [];
    bucket.push(m);
    out.set(m.kind, bucket);
  }
  return out;
}

/**
 * The distinct accounts to count at shift open/close: every method that tracks a
 * provider balance, deduped by account (two methods on one wallet = one row).
 */
export function shiftTrackedAccounts(methods: PosPaymentMethod[]) {
  const seen = new Map<string, { accountId: string; label: string; accountName: string; accountCode: string }>();
  for (const m of methods) {
    if (!m.isActive || !m.trackInShift || !m.accountId) continue;
    const existing = seen.get(m.accountId);
    if (existing) {
      // Two tiles share this account — name both so the cashier knows what to count.
      if (!existing.label.includes(m.label)) existing.label = `${existing.label} / ${m.label}`;
      continue;
    }
    seen.set(m.accountId, {
      accountId: m.accountId,
      label: m.label,
      accountName: m.accountName ?? m.label,
      accountCode: m.accountCode ?? '',
    });
  }
  return [...seen.values()];
}
