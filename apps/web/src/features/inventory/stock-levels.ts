import { api } from '@/lib/api';

/** One row of /inventory/product-stock-levels — the same source the Stock Levels page renders. */
export interface StockLevel {
  id: string;
  code: string;
  name: string;
  uom: string | null;
  totalQuantity: number;
  averageCost: number;
  batchTracking?: boolean;
}

/** Loads every page of stock levels for a location (the endpoint caps pageSize at 200). */
export async function fetchAllStockLevels(locationId: string): Promise<StockLevel[]> {
  const out: StockLevel[] = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ page: String(page), pageSize: '200', locationId });
    const res = await api.get<{ data: StockLevel[]; meta: { totalPages: number } }>(
      `/inventory/product-stock-levels?${params.toString()}`,
    );
    out.push(...(res.data.data ?? []));
    if (page >= (res.data.meta?.totalPages ?? 1)) break;
  }
  return out;
}

export const fmtQty = (n: number) =>
  Number(n.toFixed(4)).toLocaleString(undefined, { maximumFractionDigits: 4 });

export const apiErrorMessage = (e: any, fallback: string): string => {
  const m = e?.response?.data?.message;
  return Array.isArray(m) ? m.join(', ') : (m ?? fallback);
};
