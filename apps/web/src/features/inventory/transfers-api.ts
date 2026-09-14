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
  batchNumber: string | null;
  distStrategy: string | null;
}

export interface StockTransfer {
  id: string;
  transferCode: string;
  fromLocId: string;
  toLocId: string;
  status: string;
  notes: string | null;
  createdAt: string;
  reversedAt?: string | null;
  reversalReason?: string | null;
  items: StockTransferItem[];
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
      const res = await api.post(`/inventory/transfers/${id}/approve`);
      return res.data;
    },
    onSuccess: () => {
      notify.success('Transfer approved');
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
