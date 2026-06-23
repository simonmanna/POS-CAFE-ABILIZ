/**
 * POS P4 + P5 frontend hooks — modifiers, combos, KDS.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ModifierGroupFE {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
  modifiers: Array<{
    id: string;
    name: string;
    priceDelta: number;
    isDefault: boolean;
    sortOrder: number;
  }>;
}

export interface ProductBundleFE {
  product: { id: string; name: string; unitPrice: number; sku: string | null; productType: string };
  groups: ModifierGroupFE[];
}

export interface ComboFE {
  id: string;
  name: string;
  price: number;
  description: string | null;
  imageUrl: string | null;
  items: Array<{ productId: string; productName: string; quantity: number }>;
}

export function useModifierGroups() {
  return useQuery({
    queryKey: ['pos-modifier-groups'],
    queryFn: async () => (await api.get<ModifierGroupFE[]>('/pos/modifiers/groups')).data,
    staleTime: 5 * 60_000,
  });
}

export function useProductBundle(productId: string | null) {
  return useQuery({
    queryKey: ['pos-product-bundle', productId],
    queryFn: async () => {
      if (!productId) return null;
      return (await api.get<ProductBundleFE>(`/pos/modifiers/products/${productId}/bundle`)).data;
    },
    enabled: !!productId,
    staleTime: 5 * 60_000,
  });
}

export function useCombos() {
  return useQuery({
    queryKey: ['pos-combos'],
    queryFn: async () => (await api.get<ComboFE[]>('/pos/modifiers/combos')).data ?? [],
    staleTime: 5 * 60_000,
  });
}

export function useCreateModifierGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; minSelect?: number; maxSelect?: number }) =>
      (await api.post('/pos/modifiers/groups', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-modifier-groups'] }),
  });
}

export function useCreateModifier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { groupId: string; name: string; priceDelta?: number; isDefault?: boolean }) =>
      (await api.post('/pos/modifiers/modifiers', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-modifier-groups'] }),
  });
}

export function useCreateCombo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; price: number; description?: string; items: Array<{ productId: string; quantity: number }> }) =>
      (await api.post('/pos/modifiers/combos', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-combos'] }),
  });
}

export function useAssignModifierGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { productId: string; modifierGroupId: string; sortOrder?: number }) =>
      (await api.post(`/pos/modifiers/products/${body.productId}/groups`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-product-bundle'] }),
  });
}

/* ============== P5 KDS ============== */

export interface KdsTicketItemFE {
  productId: string;
  productName: string;
  quantity: number;
  modifiers: Array<{ name: string; priceDelta: number }>;
  notes: string | null;
  station: 'bar' | 'kitchen' | 'cafe';
}

export interface KdsTicketFE {
  id: string;
  invoiceId: string;
  label: string;
  station: 'bar' | 'kitchen' | 'cafe';
  status: 'new' | 'preparing' | 'ready' | 'served' | 'cancelled';
  items: KdsTicketItemFE[];
  startedAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function useKdsTickets(station?: 'bar' | 'kitchen' | 'cafe', refetchInterval = 2_000) {
  return useQuery({
    queryKey: ['pos-kds-tickets', station ?? 'all'],
    queryFn: async () =>
      (await api.get<KdsTicketFE[]>('/pos/kds/tickets', { params: { station } })).data ?? [],
    refetchInterval,
  });
}

export function useKdsTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { ticketId: string; action: 'start' | 'ready' | 'serve' | 'cancel' }) =>
      (await api.post(`/pos/kds/tickets/${body.ticketId}/transition`, { action: body.action })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-kds-tickets'] }),
  });
}