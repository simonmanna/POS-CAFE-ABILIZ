import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { idempotentPost } from '@/lib/idempotent-request';

// ───────────────────────────── Activity ─────────────────────────────

export type MoneyDirection = 'in' | 'out' | 'internal' | 'adjustment';

export interface MoneyActivityLeg {
  accountId: string;
  accountName: string;
  accountType: string | null;
  side: 'in' | 'out';
  amount: string;
}

export interface MoneyActivity {
  id: string;
  journalEntryId: string;
  entryNumber: string;
  occurredAt: string;
  category: string;
  categoryLabel: string;
  direction: MoneyDirection;
  grossAmount: string;
  externalIn: string;
  externalOut: string;
  internalMoved: string;
  currencyCode: string | null;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  status: 'posted' | 'reversed';
  legs: MoneyActivityLeg[];
  register: { id: string; name: string; sessionId: string } | null;
}

export interface MoneyActivityFilters {
  from?: string;
  to?: string;
  categories?: string[];
  accountId?: string;
  direction?: MoneyDirection | 'all';
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface MoneyActivityResult {
  data: MoneyActivity[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  currencyCode: string | null;
  pageTotals?: { externalIn: string; externalOut: string; internalMoved: string };
  categoryOptions: { key: string; label: string }[];
}

export function useMoneyActivity(filters: MoneyActivityFilters) {
  const params: Record<string, string | number> = { page: filters.page ?? 1, pageSize: filters.pageSize ?? 25 };
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;
  if (filters.categories?.length) params.categories = filters.categories.join(',');
  if (filters.accountId) params.accountId = filters.accountId;
  if (filters.direction && filters.direction !== 'all') params.direction = filters.direction;
  if (filters.search?.trim()) params.search = filters.search.trim();
  return useQuery({
    queryKey: ['money-activity', params],
    queryFn: async () => (await api.get<MoneyActivityResult>('/accounts/cash-flow/activity', { params })).data,
    placeholderData: keepPreviousData,
  });
}

// ───────────────────────────── Overview ─────────────────────────────

export interface AttentionItem {
  kind: string;
  severity: 'warning' | 'info';
  message: string;
  amount?: string;
  href: string;
  actionLabel: string;
}

export interface MoneyOverview {
  baseCurrency: string | null;
  timezone: string;
  totalAvailableBookBalance: string;
  byType: { key: string; label: string; balance: string; accountCount: number }[];
  foreignCurrencyAccounts: { id: string; name: string; currencyId: string }[];
  openRegisters: {
    registerId: string;
    registerName: string;
    sessionId: string;
    cashierName: string | null;
    openedAt: string;
    hoursOpen: number;
    expectedCash: string;
  }[];
  cashAwaitingBanking: string;
  closedDrawers: { registerId: string; registerName: string; accountId: string; amount: string }[];
  today: { externalIn: string; externalOut: string; internalMoved: string; posReceipts: string; activityCount: number };
  attention: AttentionItem[];
  recent: MoneyActivity[];
}

export function useMoneyOverview() {
  return useQuery({
    queryKey: ['money-overview'],
    queryFn: async () => (await api.get<MoneyOverview>('/accounts/cash-flow/overview')).data,
    refetchInterval: 60_000,
  });
}

// ───────────────────────────── Settlements ─────────────────────────────

export interface SettlementSource {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string | null;
  methods: { id: string; label: string; kind: string; isActive: boolean }[];
  balance: string;
  posReceiptsSinceLastSettlement: string;
  suggestedAmount: string;
  lastSettledAt: string | null;
  settlementCount: number;
}

export interface SettlementSourcesResult {
  currencyCode: string | null;
  sources: SettlementSource[];
  destinations: { id: string; code: string; name: string }[];
  feeAccounts: { id: string; code: string; name: string }[];
}

export function useSettlementSources(enabled = true) {
  return useQuery({
    queryKey: ['settlement-sources'],
    queryFn: async () => (await api.get<SettlementSourcesResult>('/cash-sessions/tender-settlements/sources')).data,
    enabled,
  });
}

export interface SettlementRow {
  id: string;
  settledAt: string;
  reference: string;
  source: { id: string; code: string; name: string };
  destination: { id: string; code: string; name: string };
  feeAccount: { id: string; code: string; name: string } | null;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  session: { id: string; registerName: string | null; openedAt: string } | null;
  journalEntryId: string | null;
}

export function useSettlementHistory(params: { sourceAccountId?: string; page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: ['settlement-history', params],
    queryFn: async () =>
      (await api.get<{ data: SettlementRow[]; total: number; page: number; totalPages: number }>('/cash-sessions/tender-settlements', {
        params: { page: params.page ?? 1, pageSize: params.pageSize ?? 20, ...(params.sourceAccountId ? { sourceAccountId: params.sourceAccountId } : {}) },
      })).data,
    placeholderData: keepPreviousData,
  });
}

export interface SettleTenderInput {
  sourceAccountId: string;
  destinationAccountId: string;
  grossAmount: number;
  feeAmount?: number;
  feeAccountId?: string;
  reference: string;
  cashSessionId?: string;
  settledAt: string;
}

/** Invalidate everything that shows money balances or activity. */
export function invalidateMoney(qc: ReturnType<typeof useQueryClient>) {
  for (const key of ['cash-accounts', 'cash-account-transactions', 'money-overview', 'money-activity', 'settlement-sources', 'settlement-history', 'trial-balance', 'cash-flow-report']) {
    qc.invalidateQueries({ queryKey: [key] });
  }
}

export function useSettleTender() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SettleTenderInput) => idempotentPost('/cash-sessions/tender-settlements', input),
    onSuccess: () => {
      invalidateMoney(qc);
      qc.invalidateQueries({ queryKey: ['session-reconciliation'] });
    },
  });
}

// ───────────────────────────── Registers (configuration) ─────────────────────────────

export interface RegisterConfig {
  id: string;
  code: string;
  name: string;
  defaultAccountId: string;
  locationId?: string | null;
  branchId?: string | null;
  isActive: boolean;
}

export function useRegisterConfigs() {
  return useQuery({
    queryKey: ['cash-registers-crud'],
    queryFn: async () =>
      (await api.get<{ data: RegisterConfig[] }>('/cash-registers', { params: { pageSize: 100 } })).data?.data ?? [],
  });
}

export function useSaveRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id?: string; code?: string; name?: string; defaultAccountId?: string; locationId?: string; branchId?: string; isActive?: boolean }) =>
      id ? (await api.patch(`/cash-registers/${id}`, body)).data : (await api.post('/cash-registers', body)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-registers-crud'] });
      qc.invalidateQueries({ queryKey: ['cash-registers'] });
      invalidateMoney(qc);
    },
  });
}
