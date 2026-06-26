import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  CreateReservationInput,
  CreateTableInput,
  PosTable,
  PosTableReservationFE,
  PosTableStats,
  ReservationReport,
  RevenueReport,
  SplitBillInput,
  UpdateReservationInput,
  UpdateTableInput,
  UtilizationReport,
} from './types';

/** Small UUID generator for Idempotency-Key on money-mutating requests. */
function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as any).randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── Tables ──────────────────────────────────────────────────────────────────

export function useTables(filter: { status?: string; zone?: string; active?: boolean } = {}) {
  return useQuery({
    queryKey: ['pos-tables', filter],
    queryFn: async () => {
      const params: Record<string, string | boolean> = {};
      if (filter.status) params.status = filter.status;
      if (filter.zone) params.zone = filter.zone;
      if (filter.active !== undefined) params.active = filter.active;
      const res = await api.get<PosTable[]>('/pos/tables', { params });
      return Array.isArray(res.data) ? res.data : [];
    },
    refetchInterval: 10_000,
  });
}

export function useTable(id: string | null) {
  return useQuery({
    queryKey: ['pos-tables', 'detail', id],
    queryFn: async () => {
      if (!id) return null;
      const res = await api.get<PosTable>(`/pos/tables/${id}`);
      return res.data;
    },
    enabled: !!id,
    refetchInterval: 8_000,
  });
}

export function useTableStats() {
  return useQuery({
    queryKey: ['pos-tables', 'stats'],
    queryFn: async () => (await api.get<PosTableStats>('/pos/tables/stats')).data,
    refetchInterval: 5_000,
  });
}

export function useCreateTable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateTableInput) =>
      (await api.post<PosTable>('/pos/tables', body, {
        headers: { 'Idempotency-Key': uuid() },
      })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-tables', 'stats'] });
    },
  });
}

export function useUpdateTable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; body: UpdateTableInput }) =>
      (await api.patch<PosTable>(`/pos/tables/${args.id}`, args.body)).data,
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-tables', 'detail', args.id] });
      qc.invalidateQueries({ queryKey: ['pos-tables', 'stats'] });
    },
  });
}

export function useArchiveTable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete<PosTable>(`/pos/tables/${id}`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-tables', 'stats'] });
    },
  });
}

export function useSetTableStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; status: string; reason?: string }) =>
      (await api.put<PosTable>(`/pos/tables/${args.id}/status`, {
        status: args.status,
        reason: args.reason,
      })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-tables', 'stats'] });
    },
  });
}

export function useAssignWaiter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; waiterId: string | null }) =>
      (await api.post<PosTable>(`/pos/tables/${args.id}/assign-waiter`, {
        waiterId: args.waiterId,
      })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-tables'] }),
  });
}

export function useMergeTables() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { sourceId: string; targetId: string }) =>
      (await api.post<unknown>(`/pos/tables/${args.sourceId}/merge/${args.targetId}`, {}, {
        headers: { 'Idempotency-Key': uuid() },
      })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-tables', 'stats'] });
    },
  });
}

export function useUnmergeTable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<unknown>(`/pos/tables/${id}/unmerge`, {}, {
        headers: { 'Idempotency-Key': uuid() },
      })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-tables', 'stats'] });
    },
  });
}

export function useTransferTable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { sourceId: string; targetId: string; documentIds?: string[] }) =>
      (await api.post<unknown>(`/pos/tables/${args.sourceId}/transfer/${args.targetId}`, {
        documentIds: args.documentIds,
      }, {
        headers: { 'Idempotency-Key': uuid() },
      })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-tables', 'stats'] });
    },
  });
}

/**
 * Item-level transfer: move selected lines (with optional partial quantities)
 * from one table's draft order into another's. Works into an occupied table.
 */
export function useTransferItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { sourceId: string; targetId: string; items: Array<{ lineId: string; quantity: number }> }) =>
      (await api.post<unknown>(`/pos/tables/${args.sourceId}/transfer-items/${args.targetId}`, { items: args.items }, {
        headers: { 'Idempotency-Key': uuid() },
      })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-tables', 'stats'] });
      qc.invalidateQueries({ queryKey: ['pos-tab'] });
    },
  });
}

export function useSplitBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { tableId: string; body: SplitBillInput }) =>
      (await api.post<unknown>(`/pos/tables/${args.tableId}/split-bill`, args.body, {
        headers: { 'Idempotency-Key': uuid() },
      })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-tables'] }),
  });
}

// ─── Reservations ────────────────────────────────────────────────────────────

export function useReservations(filter: { date?: string; status?: string; tableId?: string } = {}) {
  return useQuery({
    queryKey: ['pos-reservations', filter],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filter.date) params.date = filter.date;
      if (filter.status) params.status = filter.status;
      if (filter.tableId) params.tableId = filter.tableId;
      const res = await api.get<PosTableReservationFE[]>('/pos/reservations', { params });
      return res.data;
    },
    refetchInterval: 15_000,
  });
}

export function useReservation(id: string | null) {
  return useQuery({
    queryKey: ['pos-reservations', 'detail', id],
    queryFn: async () => {
      if (!id) return null;
      const res = await api.get<PosTableReservationFE>(`/pos/reservations/${id}`);
      return res.data;
    },
    enabled: !!id,
  });
}

export function useCreateReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateReservationInput) =>
      (await api.post<PosTableReservationFE>('/pos/reservations', body)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-reservations'] });
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-tables', 'stats'] });
    },
  });
}

export function useUpdateReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; body: UpdateReservationInput }) =>
      (await api.patch<PosTableReservationFE>(`/pos/reservations/${args.id}`, args.body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-reservations'] }),
  });
}

export function useSeatReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; documentId?: string }) =>
      (await api.post<PosTableReservationFE>(`/pos/reservations/${args.id}/seat`, {
        documentId: args.documentId,
      })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-reservations'] });
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-tables', 'stats'] });
    },
  });
}

export function useCancelReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<PosTableReservationFE>(`/pos/reservations/${id}/cancel`, {})).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-reservations'] });
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
      qc.invalidateQueries({ queryKey: ['pos-tables', 'stats'] });
    },
  });
}

export function useNoShowReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<PosTableReservationFE>(`/pos/reservations/${id}/no-show`, {})).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-reservations'] });
      qc.invalidateQueries({ queryKey: ['pos-tables'] });
    },
  });
}

export function useCompleteReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<PosTableReservationFE>(`/pos/reservations/${id}/complete`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-reservations'] }),
  });
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export function useUtilizationReport(date: string) {
  return useQuery({
    queryKey: ['pos-tables-reports', 'utilization', date],
    queryFn: async () =>
      (await api.get<UtilizationReport>('/pos/reports/tables/utilization', { params: { date } })).data,
    enabled: !!date,
  });
}

export function useRevenueReport(fromDate: string, toDate: string) {
  return useQuery({
    queryKey: ['pos-tables-reports', 'revenue', fromDate, toDate],
    queryFn: async () =>
      (await api.get<RevenueReport>('/pos/reports/tables/revenue', { params: { fromDate, toDate } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

export function useReservationReport(fromDate: string, toDate: string) {
  return useQuery({
    queryKey: ['pos-tables-reports', 'reservations', fromDate, toDate],
    queryFn: async () =>
      (await api.get<ReservationReport>('/pos/reports/reservations', { params: { fromDate, toDate } })).data,
    enabled: !!fromDate && !!toDate,
  });
}