import { idempotentPost } from '@/lib/idempotent-request';
import { submitSaleOperation } from '@/features/pos/offline-queue';
/**
 * POS API hooks + mutations.
 *
 * Conventions:
 *   - `useProductsForPos()` returns active saleable products (no pagination,
 *     small result set for the terminal UI; the catalog grows later).
 *   - `usePosHolds()`, `useLookupSku()` are polling-on-focus queries so the
 *     cashier UI is always fresh.
 *   - `useCheckout()` is a mutation; the Idempotency-Key header is generated
 *     client-side and sent so a retry won't double-charge.
 *   - `useManagerOverride()` is called before any privileged request; the
 *     server still re-verifies on the privileged write.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useCartStore } from './cart.store';
import type {
  CartLine,
  CheckoutResult,
  HourlyBucket,
  PaymentMethod,
  PaymentTender,
  PosHold,
  PosProduct,
  TopItemRow,
  XReport,
} from './types';

export interface PosProductsParams {
  search?: string;
  categoryId?: string | null;
}

export function useProductsForPos(params: PosProductsParams = {}) {
  // The terminal wants the *full* catalog, not paginated. Hit the same
  // /products endpoint with a large page size; refine later with a dedicated
  // /pos/catalog endpoint when the catalog grows past ~500 SKUs.
  return useQuery({
    queryKey: ['pos-products', params],
    queryFn: async () => {
      const res = await api.get<{ data: PosProduct[] }>('/products', {
        params: {
          page: 1,
          pageSize: 200,
          search: params.search || undefined,
        },
      });
      const items = res.data.data ?? [];
      if (params.categoryId) return items.filter((p) => p.categoryId === params.categoryId);
      return items;
    },
    staleTime: 30_000,
  });
}

export function usePosHolds(status: 'open' | 'recalled' | 'cancelled' = 'open') {
  return useQuery({
    queryKey: ['pos-holds', status],
    queryFn: async () => (await api.get<PosHold[]>('/pos/holds', { params: { status } })).data,
    refetchInterval: 10_000,
  });
}

export function useLookupSku(sku: string | null) {
  return useQuery({
    queryKey: ['pos-lookup', sku],
    queryFn: async () => {
      if (!sku) return [];
      const res = await api.get<PosProduct[]>('/pos/lookup', { params: { sku } });
      return res.data;
    },
    enabled: !!sku,
    staleTime: 60_000,
  });
}

export interface CheckoutBody {
  lines: CartLine[];
  tenders?: PaymentTender[];
  paymentMethod?: PaymentMethod;
  amountTendered?: number;
  transactionDiscountPercent?: number;
  overrideById?: string;
  cashSessionId?: string;
  branchId?: string;
  reference?: string;
  notes?: string;
  partnerId?: string;
}

export function useCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CheckoutBody) => {
      return idempotentPost<CheckoutResult>('/pos/checkout', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-holds'] });
      qc.invalidateQueries({ queryKey: ['pos-reports'] });
      qc.invalidateQueries({ queryKey: ['cash-session'] });
      qc.invalidateQueries({ queryKey: ['cash-session', 'expected'] });
      qc.invalidateQueries({ queryKey: ['cash-session', 'movements'] });
    },
  });
}

/**
 * Void / refund a settled sale. Targets the new Order→Invoice→Receipt pipeline
 * (`POST /pos/invoices/:id/refund`) — the id is the Invoice id returned at
 * checkout. `invoiceId` travels in the URL only; the body carries just the
 * whitelisted fields (forbidNonWhitelisted would 400 on extras). The cashier's
 * current open cash session is attached so the refund cash-out reconciles.
 */
export function useRefundSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ _idemKey, invoiceId, ...body }: { invoiceId: string; reason: string; cashSessionId?: string; overrideById: string; overridePin?: string; stockDisposition: 'restock' | 'waste' | 'no_return'; lines?: Array<{ lineId: string; quantity: number }>; _idemKey: string }) =>
      submitSaleOperation(`/pos/invoices/${invoiceId}/refund`, { ...body, cashSessionId: body.cashSessionId ?? useCartStore.getState().cashSessionId }, _idemKey),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pos-reports'] }); qc.invalidateQueries({ queryKey: ['pos-store-credit'] }); },
  });
}
export const useVoidSale = useRefundSale;

export function useCreateHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; notes?: string; lines: CartLine[]; partnerId?: string; branchId?: string; cashSessionId?: string }) => {
      const res = await api.post<PosHold>('/pos/holds', body);
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-holds'] }),
  });
}

export function useRecallHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post<PosHold>(`/pos/holds/${id}/recall`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-holds'] }),
  });
}

export function useCancelHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/pos/holds/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-holds'] }),
  });
}

export interface OverrideVerifyBody {
  email: string;
  pin?: string;
  password?: string;
  overrideKind: 'discount' | 'void' | 'manual_refund';
}
export interface OverrideVerifyResult {
  managerId: string;
  managerName: string;
  managerEmail: string;
  overrideKind: string;
}

export function useVerifyOverride() {
  return useMutation({
    mutationFn: async (body: OverrideVerifyBody) =>
      (await api.post<OverrideVerifyResult>('/pos/override/verify', body)).data,
  });
}

export function useSetManagerPin() {
  return useMutation({
    mutationFn: async (pin: string) => (await api.post('/pos/override/pin', { pin })).data,
  });
}

export function useXReport(cashSessionId?: string) {
  return useQuery({
    queryKey: ['pos-reports', 'x', cashSessionId ?? 'open'],
    queryFn: async () =>
      (await api.get<XReport>('/pos/reports/x-report', { params: { cashSessionId } })).data,
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useZReport(cashSessionId?: string) {
  return useQuery({
    queryKey: ['pos-reports', 'z', cashSessionId ?? 'open'],
    queryFn: async () =>
      (await api.get<XReport>('/pos/reports/z-report', { params: { cashSessionId } })).data,
    retry: false,
  });
}

export function useSalesByHour(date: string) {
  return useQuery({
    queryKey: ['pos-reports', 'hourly', date],
    queryFn: async () => (await api.get<{ date: string; buckets: HourlyBucket[] }>('/pos/reports/sales-by-hour', { params: { date } })).data,
    enabled: !!date,
  });
}

export function useTopItems(fromDate: string, toDate: string, limit = 20) {
  return useQuery({
    queryKey: ['pos-reports', 'top-items', fromDate, toDate, limit],
    queryFn: async () =>
      (await api.get<TopItemRow[]>('/pos/reports/top-items', { params: { fromDate, toDate, limit } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

// ---- POS self-service auth ----

// ---- POS Settings ----

export function usePosSettings() {
  return useQuery({
    queryKey: ['pos-settings'],
    queryFn: async () => (await api.get<{
      posMode?: string;
      sharedDrawer?: boolean;
      /** F-03: the ONE discount-approval threshold. Never hardcode it again. */
      discountApproval?: { tier1: number; tier1Amount?: number };
    }>('/pos/settings')).data,
    staleTime: 60_000,
  });
}

export function useUpdatePosSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { posMode?: string }) =>
      (await api.patch('/pos/settings', data)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-settings'] }),
  });
}

// ---- POS self-service auth ----

export function usePosChangePin() {
  return useMutation({
    mutationFn: async (input: { currentPin: string; newPin: string }) =>
      (await api.post('/pos/auth/change-pin', input)).data,
  });
}

export function usePosChangePassword() {
  return useMutation({
    mutationFn: async (input: { currentPassword: string; newPassword: string }) =>
      (await api.post('/pos/auth/change-password', input)).data,
  });
}