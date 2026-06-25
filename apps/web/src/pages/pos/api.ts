/**
 * POS terminal — API client.
 *
 * Builds on top of `@/features/pos/api` (cart store hooks) and adds the
 * domain pieces the terminal UI needs:
 *   - Product categories (strip)
 *   - Partner (customer) search + create
 *   - Cash registers + sessions (shift open/close)
 *
 * Endpoint map:
 *   /products                    → Product list (with category included)
 *   /product-categories          → Category strip
 *   /partners                    → Customer search
 *   /cash-registers              → List of registers
 *   /cash-sessions               → Open / close shift
 *   /pos/checkout                → POST sale
 *   /pos/holds                   → Hold / recall / cancel
 *   /pos/reports/{x,z}-report    → Shift reports
 *   /pos/reports/{sales-by-hour,top-items}
 *   /pos/override/{verify,pin}   → Manager PIN flow
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PaginatedResult } from '@erp/shared';
import type { CashRegister, CashSession, Category, Customer, Product, MovementsResponse } from './types';

/* ============== Catalog ============== */

export function useCategories() {
  return useQuery({
    queryKey: ['pos-categories'],
    queryFn: async () => (await api.get<PaginatedResult<Category>>('/product-categories', { params: { pageSize: 200 } })).data?.data ?? [],
    staleTime: 60_000,
  });
}

export function useProductsForPos(params: { search?: string; categoryId?: string | null } = {}) {
  return useQuery({
    queryKey: ['pos-products', params],
    queryFn: async () => {
      const res = await api.get<{ data: Product[] }>('/products', {
        params: {
          page: 1,
          pageSize: 200,
          search: params.search || undefined,
        },
      });
      const items = (res.data.data ?? []) as unknown as Product[];
      if (params.categoryId) return items.filter((p) => p.categoryId === params.categoryId);
      return items;
    },
    staleTime: 30_000,
  });
}

/** Barcode/SKU lookup — runs only when sku is non-empty. */
export function useLookupSku(sku: string | null) {
  return useQuery({
    queryKey: ['pos-lookup', sku],
    queryFn: async () => {
      if (!sku) return [];
      const res = await api.get<Product[]>('/pos/lookup', { params: { sku } });
      return res.data;
    },
    enabled: !!sku,
    staleTime: 60_000,
  });
}

/* ============== Customers (Partners with isCustomer=true) ============== */

export function useCustomers(q?: string) {
  return useQuery({
    queryKey: ['pos-customers', q ?? ''],
    queryFn: async () =>
      (await api.get<PaginatedResult<Customer>>('/partners', { params: { pageSize: 50, search: q || undefined } })).data?.data ?? [],
    enabled: q !== undefined,
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; phone?: string; email?: string }) =>
      (await api.post<Customer>('/partners', { ...body, isCustomer: true })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-customers'] }),
  });
}

/* ============== Cash registers + sessions (shifts) ============== */

export function useCashRegisters() {
  return useQuery({
    queryKey: ['cash-registers'],
    queryFn: async () => (await api.get<PaginatedResult<CashRegister>>('/cash-registers')).data?.data ?? [],
    staleTime: 5 * 60_000,
  });
}

/** Returns the cashier's currently-open session (across all registers), if any. */
export function useOpenSession() {
  return useQuery({
    queryKey: ['cash-session', 'open'],
    queryFn: async () => {
      try {
        const res = await api.get<CashSession>('/cash-sessions/open');
        return res.data ?? null;
      } catch {
        return null;
      }
    },
    refetchInterval: 30_000,
  });
}

export function useOpenShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { cashRegisterId: string; openingFloat?: number; notes?: string }) =>
      (await api.post<CashSession>('/cash-sessions/open', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cash-session'] }),
  });
}

export function useCloseShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { closingCounted: number; notes?: string; sessionId?: string }) =>
      // Close-session endpoint accepts the active session via tenant context;
      // sessionId is ignored if the cashier only has one open.
      (await api.post<CashSession>('/cash-sessions/close', {
        closingCounted: body.closingCounted,
        notes: body.notes,
      })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cash-session'] }),
  });
}

/**
 * Shift handover (module 8) — close the outgoing cashier's session and open a
 * new one on the same register for the incoming cashier in a single atomic step.
 * Requires the incoming cashier's PIN and a manager approval.
 */
export function useShiftHandover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      cashRegisterId: string;
      closingCounted: number;
      incomingUserId: string;
      incomingPin: string;
      approvedById: string;
      managerPin: string;
      varianceReason?: string;
      openingFloat?: number;
      notes?: string;
    }) => (await api.post('/pos/shift/handover', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cash-session'] }),
  });
}

export function useExpectedCash(sessionId?: string) {
  return useQuery({
    queryKey: ['cash-session', 'expected', sessionId],
    queryFn: async () => (await api.get<{ expectedCash: string }>(`/cash-sessions/${sessionId}/expected`)).data,
    enabled: !!sessionId,
    refetchInterval: 15_000,
  });
}

export function useRecordMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { sessionId?: string; movementType: 'pay_in' | 'pay_out' | 'adjustment'; amount: number; reason?: string }) =>
      (await api.post('/cash-sessions/movement', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cash-session'] }),
  });
}

export function useSessionMovements(sessionId?: string) {
  return useQuery({
    queryKey: ['cash-session', 'movements', sessionId],
    queryFn: async () => (await api.get<MovementsResponse>(`/cash-sessions/${sessionId}/movements`)).data,
    enabled: !!sessionId,
    refetchInterval: 10_000,
  });
}

export function useSessionHistory(page = 1, perPage = 20, registerId?: string) {
  return useQuery({
    queryKey: ['cash-session', 'history', page, perPage, registerId],
    queryFn: async () => (await api.get('/cash-sessions/history', { params: { page, perPage, registerId } })).data,
  });
}

export function useRecordBankDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { sessionId: string; amount: number; bankName: string; reference?: string; notes?: string }) =>
      (await api.post(`/cash-sessions/${body.sessionId}/banking`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cash-session'] }),
  });
}

export function useUpdateVariance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { sessionId: string; reason: string; status?: string }) =>
      (await api.patch(`/cash-sessions/${body.sessionId}/variance`, { reason: body.reason, status: body.status })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cash-session'] }),
  });
}

export function useDailyReconciliation(date?: string) {
  return useQuery({
    queryKey: ['cash-session', 'reconciliation', date],
    queryFn: async () => (await api.get('/cash-sessions/report/daily', { params: { date } })).data,
    enabled: !!date,
  });
}

export function useSessionDetail(sessionId?: string) {
  return useQuery({
    queryKey: ['cash-session', 'detail', sessionId],
    queryFn: async () => (await api.get(`/cash-sessions/${sessionId}`)).data,
    enabled: !!sessionId,
  });
}



/* ============== Held orders ============== */

export function useHeldOrders(status: 'open' | 'recalled' | 'cancelled' = 'open') {
  return useQuery({
    queryKey: ['pos-holds', status],
    queryFn: async () => (await api.get<any[]>('/pos/holds', { params: { status } })).data ?? [],
    refetchInterval: 10_000,
  });
}

export function useCreateHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: any) => (await api.post('/pos/holds', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-holds'] }),
  });
}

export function useRecallHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post(`/pos/holds/${id}/recall`)).data,
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

/* ============== Checkout ============== */

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return (crypto as any).randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface CheckoutBody {
  lines: Array<{
    productId?: string;
    menuItemId?: string;
    sku?: string;
    description: string;
    quantity: number;
    unitPrice: number;
    taxId?: string;
    discountPercent?: number;
    note?: string;
    modifiers?: Array<{ modifierId: string; name: string; priceDelta: number }>;
    comboId?: string;
    taxInclusive?: boolean;
  }>;
  tenders?: Array<{ method: 'cash' | 'bank' | 'card' | 'mobile_money' | 'store_credit'; amount: number; reference?: string }>;
  paymentMethod?: 'cash' | 'bank' | 'card' | 'mobile_money';
  amountTendered?: number;
  transactionDiscountPercent?: number;
  overrideById?: string;
  cashSessionId?: string;
  branchId?: string;
  reference?: string;
  notes?: string;
  partnerId?: string;
  tableId?: string;
  guestCount?: number;
}

export function useCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CheckoutBody) =>
      (await api.post('/pos/checkout', body, { headers: { 'Idempotency-Key': uuid() } })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-holds'] });
      qc.invalidateQueries({ queryKey: ['pos-reports'] });
    },
  });
}

/* ============== Open-tab dine-in (M4) ============== */

export interface TabDocument {
  id: string;
  documentNumber: string;
  status: string;
  subtotal: string;
  discountTotal: string;
  taxAmount: string;
  totalAmount: string;
  lines: Array<{ id: string; description: string; quantity: string; unitPrice: string; total: string }>;
}

/** The running bill for a table's open tab (null when none is open). */
export function useTab(tableId?: string) {
  return useQuery({
    queryKey: ['pos-tab', tableId],
    enabled: !!tableId,
    queryFn: async () => (await api.get<TabDocument | null>(`/pos/tabs/${tableId}`)).data,
  });
}

/** Add a round of items to a table's tab (creates the tab on the first round). */
export function useAddToTab() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tableId, ...body }: {
      tableId: string;
      lines: CheckoutBody['lines'];
      partnerId?: string;
      guestCount?: number;
      sendToKitchen?: boolean;
      overrideById?: string;
      transactionDiscountPercent?: number;
      // tableId travels in the URL only — the API DTOs use forbidNonWhitelisted,
      // so leaving it in the body returns 400 "property tableId should not exist".
    }) => (await api.post(`/pos/tabs/${tableId}/items`, body)).data,
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['pos-tab', v.tableId] });
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
    },
  });
}

/** Settle a table's tab — posts, takes payment, issues stock, frees the table. */
export function useSettleTab() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tableId, ...body }: {
      tableId: string;
      tenders?: CheckoutBody['tenders'];
      paymentMethod?: 'cash' | 'bank' | 'card' | 'mobile_money';
      amountTendered?: number;
      cashSessionId?: string;
    }) => (await api.post(`/pos/tabs/${tableId}/settle`, body, { headers: { 'Idempotency-Key': uuid() } })).data,
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['pos-tab', v.tableId] });
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-reports'] });
    },
  });
}

/**
 * Auto-save: replace the table's open order with the current item set. This is
 * the source-of-truth write for the "one open order per table" model — the cart
 * on screen always equals the server order. Empty `lines` frees the table.
 */
export function useSaveTab() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tableId, ...body }: { tableId: string; lines: CheckoutBody['lines']; partnerId?: string; guestCount?: number }) =>
      (await api.post<TabDocument | null>(`/pos/tabs/${tableId}/save`, body)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      // Note: we deliberately do NOT invalidate ['pos-tab', tableId] here — the
      // local cart is already the source of truth; refetching would fight typing.
    },
  });
}

/** Fire the table's current saved order to the kitchen display (KDS / KOT). */
export function useFireKitchen() {
  return useMutation({
    mutationFn: async (body: { tableId: string }) =>
      (await api.post<{ count: number }>(`/pos/tabs/${body.tableId}/fire-kitchen`, {})).data,
  });
}

export function useRefundSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { invoiceId: string; reason?: string; cashSessionId?: string; overrideById?: string }) =>
      (await api.post('/pos/refund', body, { headers: { 'Idempotency-Key': uuid() } })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-reports'] }),
  });
}

export function useVoidSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { invoiceId: string; reason: string; overrideById: string }) =>
      (await api.post(`/pos/sales/${body.invoiceId}/void`, body, { headers: { 'Idempotency-Key': uuid() } })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-reports'] }),
  });
}

/* ============== Manager override ============== */

/* ============== Send To Kitchen ============== */

export function useSendToKitchen() {
  return useMutation({
    mutationFn: async (body: {
      label: string;
      tableId?: string;
      items: Array<{ productId: string; productName: string; notes?: string }>;
    }) => (await api.post('/pos/kds/send-to-kitchen', body)).data,
  });
}

export function useVerifyOverride() {
  return useMutation({
    mutationFn: async (body: { email: string; pin?: string; password?: string; overrideKind: 'discount' | 'void' | 'manual_refund' }) =>
      (await api.post('/pos/override/verify', body)).data,
  });
}

export function useSetManagerPin() {
  return useMutation({
    mutationFn: async (pin: string) => (await api.post('/pos/override/pin', { pin })).data,
  });
}

/* ============== Reports ============== */

export function useXReport(cashSessionId?: string) {
  return useQuery({
    queryKey: ['pos-reports', 'x', cashSessionId ?? 'auto'],
    queryFn: async () => (await api.get('/pos/reports/x-report', { params: { cashSessionId } })).data,
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useZReport(cashSessionId?: string) {
  return useQuery({
    queryKey: ['pos-reports', 'z', cashSessionId ?? 'auto'],
    queryFn: async () => (await api.get('/pos/reports/z-report', { params: { cashSessionId } })).data,
    retry: false,
  });
}

export function useSalesByHour(date: string) {
  return useQuery({
    queryKey: ['pos-reports', 'hourly', date],
    queryFn: async () => (await api.get('/pos/reports/sales-by-hour', { params: { date } })).data,
    enabled: !!date,
  });
}

export function useSalesSummary(fromDate: string, toDate: string, groupBy: 'day' | 'week' | 'month') {
  return useQuery({
    queryKey: ['pos-reports', 'sales-summary', fromDate, toDate, groupBy],
    queryFn: async () => (await api.get('/pos/reports/sales-summary', { params: { fromDate, toDate, groupBy } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

export function useTopItems(fromDate: string, toDate: string, limit = 20) {
  return useQuery({
    queryKey: ['pos-reports', 'top-items', fromDate, toDate, limit],
    queryFn: async () => (await api.get('/pos/reports/top-items', { params: { fromDate, toDate, limit } })).data,
    enabled: !!fromDate && !!toDate,
  });
}