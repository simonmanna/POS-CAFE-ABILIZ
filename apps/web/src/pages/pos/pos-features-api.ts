/**
 * POS P4 + P5 frontend hooks — modifiers, combos, KDS.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ModifierGroupFE {
  id: string;
  name: string;
  groupType: 'ADD_ON' | 'MODIFIER';
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

export interface VariantFE {
  id: string;
  name: string;
  price: number;
  sortOrder: number;
}

export interface AccompanimentOptionFE {
  id: string;
  name: string;
  priceImpact: number;
  isDefault: boolean;
  sortOrder: number;
}

export interface AccompanimentGroupFE {
  id: string;
  name: string;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
  isActive: boolean;
  options: AccompanimentOptionFE[];
}

export interface MenuItemBundleFE {
  product: { id: string; name: string; unitPrice: number; sku: string | null; productType: string };
  variants: VariantFE[];
  accompanimentGroups: AccompanimentGroupFE[];
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

/** Menu-based POS: a sellable menu item + its modifier groups (same shape).
 *  Legacy: only returns modifiers, no variants/accompaniments. */
export function useMenuItemModifierBundle(menuItemId: string | null) {
  return useQuery({
    queryKey: ['pos-menu-item-modifier-bundle', menuItemId],
    queryFn: async () => {
      if (!menuItemId) return null;
      return (await api.get<ProductBundleFE>(`/pos/modifiers/menu-items/${menuItemId}/bundle`)).data;
    },
    enabled: !!menuItemId,
    staleTime: 5 * 60_000,
  });
}

/**
 * Full menu item bundle — variants, accompaniments, add-ons, and modifiers.
 * Single endpoint the POS terminal uses to drive the 4-step order flow.
 */
export function useMenuItemBundle(menuItemId: string | null) {
  return useQuery({
    queryKey: ['pos-menu-item-full-bundle', menuItemId],
    queryFn: async () => {
      if (!menuItemId) return null;
      return (await api.get<MenuItemBundleFE>(`/pos/menu/items/${menuItemId}/bundle`)).data;
    },
    enabled: !!menuItemId,
    staleTime: 30_000,
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
    mutationFn: async (body: { name: string; groupType?: 'ADD_ON' | 'MODIFIER'; minSelect?: number; maxSelect?: number }) =>
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

/** Menu-based POS: assign modifier group to a menu item. */
export function useAssignModifierGroupToMenuItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { menuItemId: string; modifierGroupId: string; sortOrder?: number }) => {
      const { menuItemId, ...payload } = body;
      return (await api.post(`/pos/modifiers/menu-items/${menuItemId}/groups`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-menu-item-bundle'] });
      qc.invalidateQueries({ queryKey: ['pos-modifier-groups'] });
    },
  });
}

export function useUnassignModifierGroupFromMenuItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { menuItemId: string; modifierGroupId: string }) =>
      (await api.delete(`/pos/modifiers/menu-items/${body.menuItemId}/groups/${body.modifierGroupId}`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-menu-item-bundle'] });
      qc.invalidateQueries({ queryKey: ['pos-modifier-groups'] });
    },
  });
}

/* ============== Variant hooks ============== */

export function useVariants(menuItemId: string | null) {
  return useQuery({
    queryKey: ['pos-variants', menuItemId],
    queryFn: async () => {
      if (!menuItemId) return [];
      return (await api.get<VariantFE[]>(`/pos/menu/items/${menuItemId}/variants`)).data ?? [];
    },
    enabled: !!menuItemId,
    staleTime: 5 * 60_000,
  });
}

export function useCreateVariant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { menuItemId: string; name: string; price: number; sortOrder?: number }) =>
      (await api.post(`/pos/menu/items/${body.menuItemId}/variants`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-variants'] }),
  });
}

export function useUpdateVariant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { menuItemId: string; variantId: string; name?: string; price?: number; sortOrder?: number; isActive?: boolean }) => {
      const { menuItemId, variantId, ...payload } = body;
      return (await api.patch(`/pos/menu/items/${menuItemId}/variants/${variantId}`, payload)).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-variants'] }),
  });
}

export function useDeleteVariant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { menuItemId: string; variantId: string }) =>
      (await api.delete(`/pos/menu/items/${body.menuItemId}/variants/${body.variantId}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-variants'] }),
  });
}

/* ============== Accompaniment hooks ============== */

/** All accompaniment groups (standalone, admin page). */
export function useAllAccompanimentGroups() {
  return useQuery({
    queryKey: ['pos-accompaniment-groups'],
    queryFn: async () => (await api.get<AccompanimentGroupFE[]>('/pos/menu/accompaniments/groups')).data ?? [],
    staleTime: 5 * 60_000,
  });
}

/** Accompaniment groups assigned to a specific menu item. */
export function useMenuItemAccompaniments(menuItemId: string | null) {
  return useQuery({
    queryKey: ['pos-menu-item-accompaniments', menuItemId],
    queryFn: async () => {
      if (!menuItemId) return [];
      return (await api.get<AccompanimentGroupFE[]>(`/pos/menu/items/${menuItemId}/accompaniments`)).data ?? [];
    },
    enabled: !!menuItemId,
    staleTime: 5 * 60_000,
  });
}

export function useCreateAccompanimentGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; isRequired?: boolean; minSelect?: number; maxSelect?: number }) =>
      (await api.post('/pos/menu/accompaniments/groups', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-accompaniment-groups'] }),
  });
}

export function useUpdateAccompanimentGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { groupId: string; name?: string; isRequired?: boolean; minSelect?: number; maxSelect?: number; isActive?: boolean }) => {
      const { groupId, ...payload } = body;
      return (await api.patch(`/pos/menu/accompaniments/groups/${groupId}`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-accompaniment-groups'] });
      qc.invalidateQueries({ queryKey: ['pos-menu-item-full-bundle'] });
    },
  });
}

export function useDeleteAccompanimentGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (groupId: string) => (await api.delete(`/pos/menu/accompaniments/groups/${groupId}`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-accompaniment-groups'] });
      qc.invalidateQueries({ queryKey: ['pos-menu-item-full-bundle'] });
    },
  });
}

export function useCreateAccompanimentOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { groupId: string; name: string; priceImpact?: number; isDefault?: boolean }) => {
      const { groupId, ...payload } = body;
      return (await api.post(`/pos/menu/accompaniments/groups/${groupId}/options`, payload)).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-accompaniment-groups'] }),
  });
}

export function useUpdateAccompanimentOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { optionId: string; name?: string; priceImpact?: number; isDefault?: boolean; isActive?: boolean }) => {
      const { optionId, ...payload } = body;
      return (await api.patch(`/pos/menu/accompaniments/options/${optionId}`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-accompaniment-groups'] });
      qc.invalidateQueries({ queryKey: ['pos-menu-item-full-bundle'] });
    },
  });
}

export function useDeleteAccompanimentOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (optionId: string) => (await api.delete(`/pos/menu/accompaniments/options/${optionId}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-accompaniment-groups'] }),
  });
}

/** Assign a standalone accompaniment group to a menu item. */
export function useAssignAccompanimentGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { menuItemId: string; accompanimentGroupId: string; sortOrder?: number }) => {
      const { menuItemId, ...payload } = body;
      return (await api.post(`/pos/menu/items/${menuItemId}/accompaniments`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-menu-item-accompaniments'] });
      qc.invalidateQueries({ queryKey: ['pos-menu-item-full-bundle'] });
    },
  });
}

/** Unassign an accompaniment group from a menu item. */
export function useUnassignAccompanimentGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { menuItemId: string; groupId: string }) => {
      const { menuItemId, groupId } = body;
      return (await api.delete(`/pos/menu/items/${menuItemId}/accompaniments/${groupId}`)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-menu-item-accompaniments'] });
      qc.invalidateQueries({ queryKey: ['pos-menu-item-full-bundle'] });
    },
  });
}

/* ============== M-E edit / delete ============== */

function invalidateGroups(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['pos-modifier-groups'] });
  qc.invalidateQueries({ queryKey: ['pos-product-bundle'] });
}

export function useUpdateModifierGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { id: string; name?: string; groupType?: 'ADD_ON' | 'MODIFIER'; minSelect?: number; maxSelect?: number; isActive?: boolean; expectedVersion?: number }) => {
      const { id, ...payload } = body;
      return (await api.patch(`/pos/modifiers/groups/${id}`, payload)).data;
    },
    onSuccess: () => invalidateGroups(qc),
  });
}

export function useDeleteModifierGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/pos/modifiers/groups/${id}`)).data,
    onSuccess: () => invalidateGroups(qc),
  });
}

export function useUpdateModifier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { id: string; name?: string; priceDelta?: number; isDefault?: boolean; isActive?: boolean }) => {
      const { id, ...payload } = body;
      return (await api.patch(`/pos/modifiers/modifiers/${id}`, payload)).data;
    },
    onSuccess: () => invalidateGroups(qc),
  });
}

export function useDeleteModifier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/pos/modifiers/modifiers/${id}`)).data,
    onSuccess: () => invalidateGroups(qc),
  });
}

export function useUnassignModifierGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { productId: string; modifierGroupId: string }) =>
      (await api.delete(`/pos/modifiers/products/${body.productId}/groups/${body.modifierGroupId}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-product-bundle'] }),
  });
}

/* ============== M-F sales report ============== */

export interface ModifierSalesRow { name: string; count: number; revenue: number }

export function useModifierSalesReport(from?: string, to?: string) {
  return useQuery({
    queryKey: ['pos-modifier-sales', from ?? '', to ?? ''],
    queryFn: async () =>
      (await api.get<ModifierSalesRow[]>('/pos/modifiers/report/sales', { params: { from, to } })).data ?? [],
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
  variantName?: string;
  accompanimentNames?: string[];
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