import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaginatedResult } from '@erp/shared';
import { api } from '@/lib/api';

export interface Product {
  id: string;
  code: string;
  sku: string | null;
  name: string;
  productType: string;
  categoryId: string | null;
  category: { id: string; name: string } | null;
  salesPrice: string | null;
  costPrice: string | null;
  isActive: boolean;
  trackInventory: boolean;
  createdAt: string;
}

export interface ProductCategory {
  id: string;
  name: string;
  parentId: string | null;
}

export interface ListParams {
  page: number;
  pageSize: number;
  search?: string;
  categoryId?: string;
  productType?: string;
}

export interface CreateProductInput {
  code: string;
  sku?: string;
  name: string;
  productType: string;
  categoryId?: string;
  salesPrice?: number;
  costPrice?: number;
  trackInventory?: boolean;
}

export function useProducts(params: ListParams) {
  return useQuery({
    queryKey: ['products', params],
    queryFn: async () => (await api.get<PaginatedResult<Product>>('/products', { params })).data,
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProductInput) =>
      (await api.post<Product>('/products', input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<CreateProductInput> }) =>
      (await api.patch<Product>(`/products/${id}`, data)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useProductCategories() {
  return useQuery({
    queryKey: ['product-categories'],
    queryFn: async () =>
      (await api.get<PaginatedResult<ProductCategory>>('/product-categories', { params: { pageSize: 200 } })).data?.data ?? [],
  });
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/products/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useRestoreProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.patch(`/products/${id}/restore`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['products'] }),
  });
}
