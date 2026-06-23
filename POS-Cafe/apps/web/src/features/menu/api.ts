/**
 * Menu management API hooks (categories + items + ingredient picker).
 *
 * Mirrors the conventions in features/products/api.ts: React Query hooks,
 * queryKey tuples for caching, mutation invalidation that re-fetches the
 * matching query keys.
 *
 * Endpoints (all under /api/v1/pos/menu):
 *   GET    /categories               list active categories
 *   POST   /categories               create category
 *   GET    /items                    list all items (admin)
 *   GET    /items/available          list categories + items grouped (POS/digital-menu payload)
 *   GET    /items/:id                detail with ingredients + product info
 *   POST   /items                    create item + ingredient links in one tx
 *   PATCH  /items/:id                update metadata (price, image, etc.)
 *   PATCH  /items/:id/availability   quick 86 toggle
 *   DELETE /items/:id                disable (isAvailable=false)
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────

export interface MenuCategory {
  id: string;
  organizationId: string;
  name: string;
  parentId: string | null;
  image: string | null;
  icon: string | null;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MenuIngredientProduct {
  id: string;
  code: string;
  name: string;
  station: string;
}

export interface MenuIngredient {
  id: string;
  organizationId: string;
  menuItemId: string;
  productId: string;
  quantity: string;
  product?: MenuIngredientProduct;
}

export interface MenuItem {
  id: string;
  organizationId: string;
  code: string | null;
  name: string;
  description: string | null;
  categoryId: string | null;
  /** Minor units (e.g. cents). String per Prisma Decimal serialization. */
  basePrice: string | null;
  image: string | null;
  preparationTime: number | null;
  isAvailable: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
  ingredients?: MenuIngredient[];
  category?: MenuCategory | null;
}

export interface MenuPayload {
  categories: MenuCategory[];
  items: MenuItem[];
}

/** Minimal product shape returned by /products; enough for the ingredient picker. */
export interface ProductMini {
  id: string;
  code: string;
  name: string;
  salesPrice: string | null;
  productType: string;
  station?: string;
}

// ─── Input shapes ─────────────────────────────────────────────────────────

export interface CreateCategoryInput {
  name: string;
  parentId?: string;
  image?: string;
  icon?: string;
  displayOrder?: number;
}

export interface IngredientInput {
  productId: string;
  quantity?: number;
}

export interface CreateMenuItemInput {
  code?: string;
  name: string;
  description?: string;
  categoryId?: string;
  /** Pass in MAJOR units (e.g. 5.00) — we multiply by 100 to send as minor units. */
  basePrice?: number;
  image?: string;
  preparationTime?: number;
  isAvailable?: boolean;
  displayOrder?: number;
  ingredients: IngredientInput[];
}

export interface UpdateMenuItemInput {
  code?: string;
  name?: string;
  description?: string;
  categoryId?: string | null;
  basePrice?: number | null;
  image?: string | null;
  preparationTime?: number | null;
  isAvailable?: boolean;
  displayOrder?: number;
  ingredients?: IngredientInput[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Convert major-unit input to API minor-unit form (cents). */
const toMinor = (v?: number | null) => (v == null ? undefined : Math.round(v * 100));

// ─── Categories ───────────────────────────────────────────────────────────

export function useMenuCategories() {
  return useQuery({
    queryKey: ['menu-categories'],
    queryFn: async () => (await api.get<MenuCategory[]>('/pos/menu/categories')).data,
  });
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCategoryInput) =>
      (await api.post<MenuCategory>('/pos/menu/categories', input)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu-categories'] });
      qc.invalidateQueries({ queryKey: ['menu-items-available'] });
    },
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<CreateCategoryInput> }) =>
      (await api.patch<MenuCategory>(`/pos/menu/categories/${id}`, data)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu-categories'] });
      qc.invalidateQueries({ queryKey: ['menu-items-available'] });
    },
  });
}

export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/pos/menu/categories/${id}`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu-categories'] });
      qc.invalidateQueries({ queryKey: ['menu-items-available'] });
    },
  });
}

// ─── Items ────────────────────────────────────────────────────────────────

export function useMenuItemsAvailable() {
  return useQuery({
    queryKey: ['menu-items-available'],
    queryFn: async () => (await api.get<MenuPayload>('/pos/menu/items/available')).data,
  });
}

export function useMenuItems() {
  return useQuery({
    queryKey: ['menu-items-all'],
    queryFn: async () => (await api.get<MenuItem[]>('/pos/menu/items')).data,
  });
}

export function useMenuItem(id: string | undefined) {
  return useQuery({
    enabled: Boolean(id),
    queryKey: ['menu-item', id],
    queryFn: async () => (await api.get<MenuItem>(`/pos/menu/items/${id}`)).data,
  });
}

export function useCreateMenuItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateMenuItemInput) =>
      (await api.post<MenuItem>('/pos/menu/items', {
        ...input,
        basePrice: toMinor(input.basePrice),
      })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu-items-all'] });
      qc.invalidateQueries({ queryKey: ['menu-items-available'] });
    },
  });
}

export function useUpdateMenuItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateMenuItemInput }) =>
      (await api.patch<MenuItem>(`/pos/menu/items/${id}`, {
        ...patch,
        basePrice: patch.basePrice === undefined ? undefined : toMinor(patch.basePrice),
      })).data,
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['menu-items-all'] });
      qc.invalidateQueries({ queryKey: ['menu-items-available'] });
      qc.invalidateQueries({ queryKey: ['menu-item', vars.id] });
    },
  });
}

export function useToggleAvailability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isAvailable }: { id: string; isAvailable: boolean }) =>
      (await api.patch<MenuItem>(`/pos/menu/items/${id}/availability`, { isAvailable })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu-items-all'] });
      qc.invalidateQueries({ queryKey: ['menu-items-available'] });
    },
  });
}

export function useDisableMenuItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete<MenuItem>(`/pos/menu/items/${id}`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu-items-all'] });
      qc.invalidateQueries({ queryKey: ['menu-items-available'] });
    },
  });
}

// ─── Ingredient picker ────────────────────────────────────────────────────

/** Tiny product picker — pages/products.tsx has the full paginated version.
 *  For the menu dialog we just need a searchable list of products. We
 *  piggyback on /products with a large pageSize; if the catalogue grows past
 *  a few hundred SKUs this should switch to a typeahead endpoint. */
export function useProductPicker(search?: string) {
  return useQuery({
    queryKey: ['product-picker', search],
    queryFn: async () => {
      const res = await api.get<{ data: ProductMini[] }>('/products', {
        params: { page: 1, pageSize: 200, search: search || undefined },
      });
      // Backend returns active products by default; if a future flag includes
      // inactive ones, we hide them here so the picker stays clean.
      return (res.data.data ?? []).filter((p) => p.productType !== 'service');
    },
  });
}