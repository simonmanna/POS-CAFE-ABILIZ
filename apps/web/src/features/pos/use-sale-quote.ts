import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { useCartStore } from './cart.store';
import { cartLinePayload } from './cart-payload';

export function useSaleQuote() {
  const cart = useCartStore();
  const organizationId = useAuthStore((s) => s.organization?.id);
  const body = {
    lines: cart.lines.map(cartLinePayload), transactionDiscountPercent: cart.transactionDiscountPercent,
    transactionDiscountType: cart.transactionDiscountType, transactionDiscountAmount: cart.transactionDiscountAmount,
  };
  return useQuery({
    queryKey: ['pos-sale-quote', organizationId, body],
    queryFn: async () => (await api.post<{ total: number; subtotal: number; taxAmount: number; discountTotal: number; pricingVersion: number }>('/pos/orders/quote', body)).data,
    enabled: cart.lines.length > 0 && !!organizationId,
    staleTime: 15_000, retry: false,
  });
}
