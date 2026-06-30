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
import type {
  CashRegister, CashSession, Category, Customer, Product, MovementsResponse,
  Order, InvoiceResult, PaymentResult, PaymentTender,
} from './types';

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
    queryFn: async () => {
      const res = await api.get<PaginatedResult<any>>('/partners', { params: { pageSize: 50, search: q || undefined } });
      return (res.data?.data ?? []).filter((p: any) => p.isCustomer) as Customer[];
    },
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
      const res = await api.get<CashSession | null>('/cash-sessions/open');
      return res.data ?? null;
    },
    // Open session is stable; rely on mutation invalidation, not polling.
    // Long staleTime prevents flicker; no refetchInterval needed.
    staleTime: 5 * 60_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
    retry: 1,
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
    mutationFn: async (body: { closingCounted: number; notes?: string; varianceReason?: string; varianceStatus?: string }) =>
      (await api.post<CashSession>('/cash-sessions/close', body)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-session'] });
      qc.invalidateQueries({ queryKey: ['cash-session', 'movements'] });
    },
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-session'] });
      qc.invalidateQueries({ queryKey: ['cash-session', 'movements'] });
    },
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-session'] });
      qc.invalidateQueries({ queryKey: ['cash-session', 'movements'] });
    },
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
  orderType?: 'dine_in' | 'takeaway' | 'delivery';
  /** Client-only: the cart's stable Idempotency-Key. Stripped before POST so it
   *  never reaches the (forbidNonWhitelisted) DTO; sent as the header instead. */
  _idemKey?: string;
}

export function useCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ _idemKey, ...body }: CheckoutBody) =>
      (await api.post('/pos/checkout', body, { headers: { 'Idempotency-Key': _idemKey ?? uuid() } })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-holds'] });
      qc.invalidateQueries({ queryKey: ['pos-reports'] });
      qc.invalidateQueries({ queryKey: ['cash-session'] });
      qc.invalidateQueries({ queryKey: ['cash-session', 'expected'] });
      qc.invalidateQueries({ queryKey: ['cash-session', 'movements'] });
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
  lines: Array<{
    id: string; description: string; quantity: string; unitPrice: string; total: string;
    modifiers?: Array<{ modifierId: string | null; name: string; priceDelta: string }>;
  }>;
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
    mutationFn: async ({ tableId, _idemKey, ...body }: {
      tableId: string;
      tenders?: CheckoutBody['tenders'];
      paymentMethod?: 'cash' | 'bank' | 'card' | 'mobile_money';
      amountTendered?: number;
      transactionDiscountPercent?: number;
      cashSessionId?: string;
      _idemKey?: string;
    }) => (await api.post(`/pos/tabs/${tableId}/settle`, body, { headers: { 'Idempotency-Key': _idemKey ?? uuid() } })).data,
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['pos-tab', v.tableId] });
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-reports'] });
      qc.invalidateQueries({ queryKey: ['cash-session'] });
      qc.invalidateQueries({ queryKey: ['cash-session', 'expected'] });
      qc.invalidateQueries({ queryKey: ['cash-session', 'movements'] });
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

/** Print a pre-payment bill for a table's draft order. */
export function usePrintBill() {
  return useMutation({
    mutationFn: async (body: { invoiceId: string }) =>
      (await api.post(`/pos/receipts/${body.invoiceId}/print-bill`, {})).data,
  });
}

/** Print only the items not yet included on any previous bill print. */
export function usePrintAdditionalBill() {
  return useMutation({
    mutationFn: async (body: { invoiceId: string }) =>
      (await api.post(`/pos/receipts/${body.invoiceId}/print-additional-bill`, {})).data,
  });
}

/** Print the KOT (delta items only) to the thermal kitchen printer. */
export function usePrintKot() {
  return useMutation({
    mutationFn: async (body: { invoiceId: string }) =>
      (await api.post(`/pos/receipts/${body.invoiceId}/print-kot`, {})).data,
  });
}

/** Reprint a receipt (admin-only, requires reason for reprint). */
export function useReprintReceipt() {
  return useMutation({
    mutationFn: async (body: { invoiceId: string; reason?: string }) =>
      (await api.post(`/pos/receipts/${body.invoiceId}/reprint`, { reason: body.reason })).data,
  });
}

export function useRefundSale() {
  const qc = useQueryClient();
  return useMutation({
    // New pipeline: refund targets the Invoice id (URL); body carries only the
    // whitelisted fields. See features/pos/api.ts for the primary copy.
    mutationFn: async (body: { invoiceId: string; reason?: string; cashSessionId?: string; overrideById?: string }) =>
      (await api.post(
        `/pos/invoices/${body.invoiceId}/refund`,
        { reason: body.reason, overrideById: body.overrideById, cashSessionId: body.cashSessionId },
        { headers: { 'Idempotency-Key': uuid() } },
      )).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-reports'] }),
  });
}

export function useVoidSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { invoiceId: string; reason: string; overrideById: string }) =>
      (await api.post(
        `/pos/invoices/${body.invoiceId}/refund`,
        { reason: body.reason, overrideById: body.overrideById },
        { headers: { 'Idempotency-Key': uuid() } },
      )).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-reports'] }),
  });
}

/* ============== Store credit ============== */

/** The customer's redeemable store-credit balance (0 when none / no customer). */
export function useStoreCredit(partnerId?: string) {
  return useQuery({
    queryKey: ['pos-store-credit', partnerId],
    enabled: !!partnerId,
    queryFn: async () =>
      (await api.get<{ balance: number; expiresAt: string | null }>(`/pos/loyalty/credit/${partnerId}`)).data,
    staleTime: 15_000,
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

export function useSalesByHour(fromDate: string, toDate: string, hours?: string) {
  return useQuery({
    queryKey: ['pos-reports', 'hourly', fromDate, toDate, hours ?? 'all'],
    queryFn: async () => (await api.get('/pos/reports/sales-by-hour', { params: { fromDate, toDate, hours: hours || undefined } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

export function useSalesSummary(fromDate: string, toDate: string, groupBy: 'day' | 'week' | 'month') {
  return useQuery({
    queryKey: ['pos-reports', 'sales-summary', fromDate, toDate, groupBy],
    queryFn: async () => (await api.get('/pos/reports/sales-summary', { params: { fromDate, toDate, groupBy } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

export function useTopItems(fromDate: string, toDate: string, limit = 20, categoryId?: string) {
  return useQuery({
    queryKey: ['pos-reports', 'top-items', fromDate, toDate, limit, categoryId ?? 'all'],
    queryFn: async () => (await api.get('/pos/reports/top-items', { params: { fromDate, toDate, limit, categoryId: categoryId || undefined } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

export function useSalesReport(fromDate: string, toDate: string, waiterId?: string, search?: string, paymentMethod?: string, orderType?: string) {
  return useQuery({
    queryKey: ['pos-reports', 'sales-report', fromDate, toDate, waiterId ?? 'all', search ?? '', paymentMethod ?? 'all', orderType ?? 'all'],
    queryFn: async () => (await api.get('/pos/reports/sales-report', { params: { fromDate, toDate, waiterId, search: search || undefined, paymentMethod, orderType } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

export function useWaiterReport(fromDate: string, toDate: string, waiterId?: string, orderType?: string) {
  return useQuery({
    queryKey: ['pos-reports', 'waiter-report', fromDate, toDate, waiterId ?? 'all', orderType ?? 'all'],
    queryFn: async () => (await api.get('/pos/reports/waiter-report', { params: { fromDate, toDate, waiterId, orderType } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

export function useCashierShiftSummary(fromDate: string, toDate: string, cashierId?: string) {
  return useQuery({
    queryKey: ['pos-reports', 'cashier-shift-summary', fromDate, toDate, cashierId ?? 'all'],
    queryFn: async () => (await api.get('/pos/reports/cashier-shift-summary', { params: { fromDate, toDate, cashierId } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

export function useCashierReport(fromDate: string, toDate: string, waiterId?: string, search?: string, paymentMethod?: string, orderType?: string) {
  return useQuery({
    queryKey: ['pos-reports', 'cashier-report', fromDate, toDate, waiterId ?? 'all', search ?? '', paymentMethod ?? 'all', orderType ?? 'all'],
    queryFn: async () => (await api.get('/pos/reports/cashier-report', { params: { fromDate, toDate, waiterId, search: search || undefined, paymentMethod, orderType } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

export function useOrderReport(fromDate: string, toDate: string, orderType?: string, status?: string) {
  return useQuery({
    queryKey: ['pos-reports', 'order-report', fromDate, toDate, orderType ?? 'all', status ?? 'all'],
    queryFn: async () => (await api.get('/pos/reports/order-report', { params: { fromDate, toDate, orderType, status: status && status !== 'draft' ? status : undefined } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

export function useSoldItems(fromDate: string, toDate: string, categoryId?: string, waiterId?: string, orderType?: string) {
  return useQuery({
    queryKey: ['pos-reports', 'sold-items', fromDate, toDate, categoryId ?? 'all', waiterId ?? 'all', orderType ?? 'all'],
    queryFn: async () => (await api.get('/pos/reports/sold-items', { params: { fromDate, toDate, categoryId: categoryId || undefined, waiterId, orderType } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

/* ============================================================================
 * Orders → Invoices → Receipts (DDD split).
 *
 * The operational Order is created up-front and edited freely (no GL/stock).
 * "Generate Bill" mints the Invoice (deducts stock, posts AR); payment settles
 * it and emits a typed Receipt. IDs travel in the URL (never the body — the API
 * uses forbidNonWhitelisted), matching the existing tab hooks.
 * ==========================================================================*/

export interface OrderLineBody {
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
  variantId?: string;
  accompanimentOptionIds?: string[];
  comboId?: string;
  taxInclusive?: boolean;
}

/** Fetch a single order with its (non-cancelled) items. */
export function useOrder(orderId?: string) {
  return useQuery({
    queryKey: ['pos-order', orderId],
    enabled: !!orderId,
    queryFn: async () => (await api.get<Order>(`/pos/orders/${orderId}`)).data,
  });
}

/** The current open (un-billed) order on a table, or null. */
export function useOrderByTable(tableId?: string) {
  return useQuery({
    queryKey: ['pos-order', 'by-table', tableId],
    enabled: !!tableId,
    queryFn: async () => (await api.get<Order | null>(`/pos/orders/by-table/${tableId}`)).data,
  });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      orderType?: 'dine_in' | 'takeaway' | 'delivery';
      tableId?: string; partnerId?: string; waiterId?: string; branchId?: string;
      cashSessionId?: string; guestCount?: number; notes?: string; lines?: OrderLineBody[];
    }) => (await api.post<Order>('/pos/orders', body)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-orders'] });
    },
  });
}

/** Auto-save: replace the order's whole item set (optimistic-lock via expectedVersion). */
export function useSaveOrderItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, ...body }: {
      orderId: string; lines: OrderLineBody[]; expectedVersion?: number;
      guestCount?: number; partnerId?: string; transactionDiscountPercent?: number;
    }) => (await api.put<Order>(`/pos/orders/${orderId}/items`, body)).data,
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['pos-order', v.orderId] }),
  });
}

/** Append a round of items (optionally fire to kitchen). */
export function useAddOrderItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, ...body }: {
      orderId: string; lines: OrderLineBody[]; sendToKitchen?: boolean;
      guestCount?: number; overrideById?: string; transactionDiscountPercent?: number;
    }) => (await api.post<Order>(`/pos/orders/${orderId}/items`, body)).data,
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['pos-order', v.orderId] });
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
    },
  });
}

export function useFireOrderKitchen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { orderId: string }) =>
      (await api.post<{ count: number }>(`/pos/orders/${body.orderId}/fire-kitchen`, {})).data,
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['pos-order', v.orderId] }),
  });
}

export function useMoveOrderTable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, targetTableId }: { orderId: string; targetTableId: string }) =>
      (await api.post(`/pos/orders/${orderId}/move`, { targetTableId })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-tables'] }),
  });
}

export function useMergeOrders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, sourceOrderId }: { orderId: string; sourceOrderId: string }) =>
      (await api.post(`/pos/orders/${orderId}/merge`, { sourceOrderId })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-tables'] }),
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, reason }: { orderId: string; reason?: string }) =>
      (await api.post(`/pos/orders/${orderId}/cancel`, { reason })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-tables'] }),
  });
}

export function useReopenOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { orderId: string }) =>
      (await api.post(`/pos/orders/${body.orderId}/reopen`, {})).data,
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['pos-order', v.orderId] }),
  });
}

/** Generate the bill/invoice from an order (deducts stock, posts AR). */
export function useGenerateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, ...body }: {
      orderId: string;
      paymentMode?: 'cash' | 'card' | 'mobile_money' | 'mixed' | 'credit';
      transactionDiscountPercent?: number; branchId?: string;
    }) => (await api.post<InvoiceResult>(`/pos/orders/${orderId}/invoice`, body, { headers: { 'Idempotency-Key': uuid() } })).data,
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['pos-order', v.orderId] });
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
    },
  });
}

/** Receive one or more payments and settle the invoice. */
export function useReceivePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ invoiceId, ...body }: {
      invoiceId: string;
      tenders?: PaymentTender[];
      paymentMethod?: 'cash' | 'bank' | 'card' | 'mobile_money';
      amountTendered?: number; cashSessionId?: string;
    }) => (await api.post<PaymentResult>(`/pos/invoices/${invoiceId}/payments`, body, { headers: { 'Idempotency-Key': uuid() } })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-reports'] });
      qc.invalidateQueries({ queryKey: ['cash-session'] });
    },
  });
}

/** Settle an invoice on credit (postpaid house account). */
export function useSettleCredit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ invoiceId, ...body }: { invoiceId: string; partnerId?: string; notes?: string }) =>
      (await api.post<PaymentResult>(`/pos/invoices/${invoiceId}/credit`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-tables'] }),
  });
}

/** Write off an invoice's outstanding balance (admin/manager). */
export function useWriteOffInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ invoiceId, reason }: { invoiceId: string; reason: string }) =>
      (await api.post(`/pos/invoices/${invoiceId}/write-off`, { reason })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-reports'] }),
  });
}

/* ============================================================================
 * Split bills — divide one table's open tab into independently-payable bills.
 * Item/bill ids travel in the URL (never the body — forbidNonWhitelisted). Every
 * mutation returns the full refreshed SplitState so the dialog stays in sync.
 * ==========================================================================*/

export interface SplitLine {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  lineTotal: number;
  assignedQty: number;
  unassignedQty: number;
  modifiers: string[];
}

export interface SplitBillItem {
  sourceLineId: string;
  description: string;
  quantity: number;
  lineTotal: number;
}

export interface SplitBill {
  id: string;
  label: string;
  status: 'open' | 'settled' | 'void';
  splitType: 'item' | 'even' | 'percent';
  partnerId: string | null;
  invoiceId: string | null;
  totalAmount: number;
  amountPaid: number;
  items: SplitBillItem[];
}

export interface SplitState {
  tableId: string;
  sourceDocumentId: string | null;
  lines: SplitLine[];
  bills: SplitBill[];
  summary: {
    tableTotal: number;
    assignedTotal: number;
    unassignedTotal: number;
    paidTotal: number;
    outstandingTotal: number;
    fullyAssigned: boolean;
    openBills: number;
  };
  splitActive: boolean;
}

export interface SettleSplitResult {
  billId: string;
  invoiceId: string;
  invoiceNumber?: string;
  settlementStatus: string;
  change: number;
  tableClosed: boolean;
  alreadySettled?: boolean;
}

type AssignItem = { sourceLineId: string; quantity: number };

/** The split workspace for a table (lines + bills + running balance). */
export function useSplitState(tableId?: string, enabled = true) {
  return useQuery({
    queryKey: ['pos-split', tableId],
    enabled: !!tableId && enabled,
    queryFn: async () => (await api.get<SplitState>(`/pos/tabs/${tableId}/split`)).data,
  });
}

export function useAddSplitBills() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tableId, count }: { tableId: string; count?: number }) =>
      (await api.post<SplitState>(`/pos/tabs/${tableId}/split/bills`, { count })).data,
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['pos-split', v.tableId] }),
  });
}

export function useCancelSplit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tableId }: { tableId: string }) =>
      (await api.post<SplitState>(`/pos/tabs/${tableId}/split/cancel`, {})).data,
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['pos-split', v.tableId] });
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
    },
  });
}

export function useAssignSplitItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ billId, items }: { billId: string; tableId?: string; items: AssignItem[] }) =>
      (await api.post<SplitState>(`/pos/split-bills/${billId}/assign`, { items })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-split'] }),
  });
}

export function useUnassignSplitItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ billId, items }: { billId: string; tableId?: string; items: AssignItem[] }) =>
      (await api.post<SplitState>(`/pos/split-bills/${billId}/unassign`, { items })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-split'] }),
  });
}

export function useMoveSplitItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ billId, targetBillId, items }: { billId: string; targetBillId: string; items: AssignItem[] }) =>
      (await api.post<SplitState>(`/pos/split-bills/${billId}/move/${targetBillId}`, { items })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-split'] }),
  });
}

export function useMergeSplitBills() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ billId, targetBillId }: { billId: string; targetBillId: string }) =>
      (await api.post<SplitState>(`/pos/split-bills/${billId}/merge/${targetBillId}`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-split'] }),
  });
}

export function useDeleteSplitBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ billId }: { billId: string }) =>
      (await api.delete<SplitState>(`/pos/split-bills/${billId}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-split'] }),
  });
}

export function useSettleSplitBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ billId, _idemKey, ...body }: {
      billId: string;
      tableId?: string;
      tenders?: PaymentTender[];
      paymentMethod?: 'cash' | 'bank' | 'card' | 'mobile_money';
      amountTendered?: number;
      cashSessionId?: string;
      _idemKey?: string;
    }) => (await api.post<SettleSplitResult>(`/pos/split-bills/${billId}/settle`, body, { headers: { 'Idempotency-Key': _idemKey ?? uuid() } })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-split'] });
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-reports'] });
      qc.invalidateQueries({ queryKey: ['cash-session'] });
    },
  });
}