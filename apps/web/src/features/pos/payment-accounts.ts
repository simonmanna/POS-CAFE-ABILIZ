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
