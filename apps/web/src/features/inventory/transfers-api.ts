import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';

export interface StockTransferItem {
  id: string;
  productId: string;
  productName: string;
  unit: string | null;
  qtyRequested: number;
  qtyTransferred: number;
  qtyDispatched?: number | string;
  qtyReceived?: number | string;
  qtyDamaged?: number | string;
  qtyShort?: number | string;
  qtyRecalled?: number | string;
  batchNumber: string | null;
  distStrategy: string | null;
}

export interface StockTransfer {
  id: string;
  transferCode: string;
  fromLocId: string;
  toLocId: string;
  status: string;
  mode?: 'immediate' | 'transit';
  notes: string | null;
  createdAt: string;
  dispatchedAt?: string | null;
  reversedAt?: string | null;
  reversalReason?: string | null;
  items: StockTransferItem[];
  receipts?: StockTransferReceipt[];
}

export function useTransfers(status?: string) {
  return useQuery<StockTransfer[]>({
    queryKey: ['inventory-transfers', status],
    queryFn: async () => {
      const params = status ? { status } : {};
      const res = await api.get<StockTransfer[]>('/inventory/transfers', { params });
      return res.data;
    },
  });
}

export function useCreateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      fromLocationId: string;
      toLocationId: string;
      responsibleById: string;
      approvedById: string;
      mode?: 'immediate' | 'transit';
      notes?: string;
      items: { productId: string; qtyRequested: number; distStrategy?: string }[];
    }) => {
      const res = await api.post('/inventory/transfers', data);
      return res.data;
    },
    onSuccess: () => {
      notify.success('Transfer created');
      qc.invalidateQueries({ queryKey: ['inventory-transfers'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed to create transfer'),
  });
}

export function useApproveTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.post<StockTransfer>(`/inventory/transfers/${id}/approve`);
      return res.data;
    },
    onSuccess: (d: StockTransfer) => {
      notify.success(d?.mode === 'transit' ? 'Transfer approved — dispatch it when the goods leave' : 'Transfer approved');
      qc.invalidateQueries({ queryKey: ['inventory-transfers'] });
      qc.invalidateQueries({ queryKey: ['inventory-product-stock-levels'] });
      qc.invalidateQueries({ queryKey: ['inventory-stats'] });
      qc.invalidateQueries({ queryKey: ['inventory-ledger'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed to approve transfer'),
  });
}

export function useReverseTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; reason: string }) =>
      (await api.post<StockTransfer>(`/inventory/transfers/${v.id}/reverse`, { reason: v.reason })).data,
    onSuccess: (d) => {
      notify.success(`${d.transferCode} reversed — stock moved back`);
      for (const key of ['inventory-transfers', 'inventory-product-stock-levels', 'inventory-stats', 'inventory-ledger']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed to reverse transfer'),
  });
}

// ---- Transit transfers: dispatch → receive (partial / damaged / short) → recall ----

export interface StockTransferReceipt {
  id: string;
  receiptCode: string;
  kind: 'receipt' | 'recall';
  notes: string | null;
  createdAt: string;
  lines: Array<{ itemId: string; received?: string; damaged?: string; short?: string; recalled?: string }>;
}

export interface ReceiveTransferLine {
  itemId: string;
  received?: number;
  damaged?: number;
  short?: number;
}

function invalidateTransferViews(qc: ReturnType<typeof useQueryClient>) {
  for (const key of ['inventory-transfers', 'inventory-product-stock-levels', 'inventory-stats', 'inventory-ledger']) {
    qc.invalidateQueries({ queryKey: [key] });
  }
}

function useTransferAction<V>(fn: (v: V) => Promise<StockTransfer>, success: (d: StockTransfer) => string, failure: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (d) => {
      notify.success(success(d));
      invalidateTransferViews(qc);
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? failure),
  });
}

export function useDispatchTransfer() {
  return useTransferAction(
    async (id: string) => (await api.post<StockTransfer>(`/inventory/transfers/${id}/dispatch`)).data,
    (d) => `${d.transferCode} dispatched — stock is now in transit`,
    'Failed to dispatch transfer',
  );
}

export function useReceiveTransfer() {
  return useTransferAction(
    async (v: { id: string; lines: ReceiveTransferLine[]; notes?: string }) =>
      (await api.post<StockTransfer>(`/inventory/transfers/${v.id}/receive`, { lines: v.lines, notes: v.notes })).data,
    (d) => (d.status === 'completed' ? `${d.transferCode} fully received` : `${d.transferCode} partially received`),
    'Failed to receive transfer',
  );
}

export function useRecallTransfer() {
  return useTransferAction(
    async (v: { id: string; reason: string }) =>
      (await api.post<StockTransfer>(`/inventory/transfers/${v.id}/recall`, { reason: v.reason })).data,
    (d) => `${d.transferCode} recalled — in-transit stock returned to source`,
    'Failed to recall transfer',
  );
}

export function useCancelTransfer() {
  return useTransferAction(
    async (id: string) => (await api.post<StockTransfer>(`/inventory/transfers/${id}/cancel`)).data,
    (d) => `${d.transferCode} cancelled`,
    'Failed to cancel transfer',
  );
}
