import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaginatedResult } from '@erp/shared';
import { api } from '@/lib/api';

export interface Account {
  id: string;
  code: string;
  name: string;
  accountType: string;
  isGroup: boolean;
  isActive: boolean;
}

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: async () =>
      (await api.get<PaginatedResult<Account>>('/accounts', { params: { pageSize: 200 } })).data,
  });
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totals: { debit: string; credit: string };
  balanced: boolean;
}

export function useTrialBalance(params: { from?: string; to?: string }) {
  return useQuery({
    queryKey: ['trial-balance', params],
    queryFn: async () =>
      (await api.get<TrialBalance>('/reports/accounting/trial-balance', { params })).data,
  });
}

export interface JournalEntryRow {
  id: string;
  entryNumber: string;
  postingDate: string;
  description: string | null;
  status: string;
  journal: { code: string; name: string };
  _count?: { lines: number };
}

export interface JournalLine {
  id: string;
  description: string | null;
  debit: string;
  credit: string;
  account: { code: string; name: string };
}

export interface JournalEntryDetail extends JournalEntryRow {
  lines: JournalLine[];
}

export function useJournalEntries(params: { page?: number; pageSize?: number; search?: string }) {
  return useQuery({
    queryKey: ['journal-entries', params],
    queryFn: async () =>
      (await api.get<PaginatedResult<JournalEntryRow>>('/journal-entries', { params })).data,
  });
}

export function useJournalEntry(id: string | undefined) {
  return useQuery({
    queryKey: ['journal-entry', id],
    queryFn: async () => (await api.get<JournalEntryDetail>(`/journal-entries/${id}`)).data,
    enabled: !!id,
  });
}

export interface Journal {
  id: string;
  code: string;
  name: string;
  journalType: string;
  isActive: boolean;
}

export function useJournals() {
  return useQuery({
    queryKey: ['journals'],
    queryFn: async () =>
      (await api.get<PaginatedResult<Journal>>('/journals', { params: { pageSize: 100 } })).data,
  });
}

export interface ManualJournalLineInput {
  accountId: string;
  debit?: number;
  credit?: number;
  partnerId?: string;
  description?: string;
}

export interface CreateJournalEntryInput {
  journalCode: string;
  date: string;
  description?: string;
  lines: ManualJournalLineInput[];
}

export function useCreateJournalEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateJournalEntryInput) =>
      (await api.post<JournalEntryDetail>('/journal-entries', input)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      qc.invalidateQueries({ queryKey: ['trial-balance'] });
    },
  });
}

export function useReverseJournalEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<JournalEntryDetail>(`/journal-entries/${id}/reverse`, {})).data,
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      qc.invalidateQueries({ queryKey: ['journal-entry', id] });
      qc.invalidateQueries({ queryKey: ['trial-balance'] });
    },
  });
}

// ── Cash Accounts / Cash Flow ──

export interface CashAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
  balance: string;
  bankName: string | null;
  accountNumber: string | null;
  isDefault: boolean;
  currencyId: string | null;
  cashRegister: { id: string; name: string; code: string } | null;
}

export function useCashAccounts() {
  return useQuery({
    queryKey: ['cash-accounts'],
    queryFn: async () => (await api.get<CashAccount[]>('/accounts/cash-flow')).data,
  });
}

export interface CashTransaction {
  id: string;
  journalEntryId: string;
  entryNumber: string;
  postingDate: string;
  description: string | null;
  sourceType: string | null;
  debit: string;
  credit: string;
  baseDebit: string;
  baseCredit: string;
}

export interface TransactionsResult {
  data: CashTransaction[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  account: { id: string; code: string; name: string; accountType: string; bankName: string | null; accountNumber: string | null; currencyId: string | null };
}

export function useCashAccountTransactions(id: string | undefined, params: { page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: ['cash-account-transactions', id, params],
    queryFn: async () =>
      (await api.get<TransactionsResult>(`/accounts/cash-flow/${id}/transactions`, { params })).data,
    enabled: !!id,
  });
}

export function useCashFlowDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { accountId: string; amount: number; description?: string }) =>
      (await api.post('/accounts/cash-flow/deposit', input)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-accounts'] });
      qc.invalidateQueries({ queryKey: ['cash-account-transactions'] });
      qc.invalidateQueries({ queryKey: ['trial-balance'] });
    },
  });
}

export function useCashFlowWithdraw() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { accountId: string; amount: number; description?: string }) =>
      (await api.post('/accounts/cash-flow/withdraw', input)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-accounts'] });
      qc.invalidateQueries({ queryKey: ['cash-account-transactions'] });
      qc.invalidateQueries({ queryKey: ['trial-balance'] });
    },
  });
}

export function useTreasuryTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { fromAccountId: string; toAccountId: string; amount: number; date: string; reference?: string }) =>
      (await api.post('/treasury/transfer', input)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-accounts'] });
      qc.invalidateQueries({ queryKey: ['cash-account-transactions'] });
      qc.invalidateQueries({ queryKey: ['trial-balance'] });
    },
  });
}

export function useCreateCashAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      code: string;
      name: string;
      accountType: string;
      currencyId?: string;
      bankName?: string;
      accountNumber?: string;
      isDefault?: boolean;
    }) => (await api.post('/accounts/cash-flow', input)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-accounts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useUpdateCashAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: { id: string; name?: string; bankName?: string; accountNumber?: string; isDefault?: boolean }) =>
      (await api.patch(`/accounts/cash-flow/${id}`, data)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-accounts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useDeleteCashAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/accounts/cash-flow/${id}`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-accounts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}
