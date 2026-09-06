import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { exportCSV } from '@/lib/export-csv';

interface Product { id: string; code: string; name: string }
interface Location { id: string; code: string; name: string }
interface Category { id: string; name: string }

interface MovementRow {
  productId: string;
  code: string;
  name: string;
  category: string | null;
  uom: string | null;
  openingQty: number;
  qtyIn: number;
  qtyOut: number;
  netQty: number;
  balance: number;
  totalValue: number;
}

interface MovementMeta { page: number; pageSize: number; total: number; totalPages: number }

const num = (v: number) => {
  const n = Number(v ?? 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

export function InventoryReportsPage() {
  const [page, setPage] = useState(1);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [locationId, setLocationId] = useState('');
  const [productId, setProductId] = useState('');
  const [categoryId, setCategoryId] = useState('');

  const locations = useQuery<Location[]>({
    queryKey: ['inventory-locations'],
    queryFn: async () => (await api.get<{ data: Location[] }>('/inventory/locations')).data.data ?? [],
  });

  const products = useQuery<Product[]>({
    queryKey: ['products'],
    queryFn: async () => (await api.get<{ data: Product[] }>('/products?pageSize=500')).data.data ?? [],
  });

  const categories = useQuery<Category[]>({
    queryKey: ['product-categories'],
    queryFn: async () => {
      const res = await api.get<{ data: Category[] } | Category[]>('/product-categories');
      const rows = Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
      return rows;
    },
  });

  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('pageSize', '25');
  if (dateFrom) params.set('start', dateFrom);
  if (dateTo) params.set('end', dateTo);
  if (locationId) params.set('locationId', locationId);
  if (productId) params.set('productId', productId);
  if (categoryId) params.set('categoryId', categoryId);

  const report = useQuery<{ data: MovementRow[]; meta: MovementMeta }>({
    queryKey: ['inventory-item-movements', page, dateFrom, dateTo, locationId, productId, categoryId],
    queryFn: async () => (await api.get(`/inventory/reports/item-movements?${params.toString()}`)).data,
  });

  const rows = report.data?.data ?? [];

  const handleExport = async () => {
    // Pull every page for the current filter set.
    const all: MovementRow[] = [];
    let p = 1;
    let totalPages = 1;
    do {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set('start', dateFrom);
      if (dateTo) qs.set('end', dateTo);
      if (locationId) qs.set('locationId', locationId);
      if (productId) qs.set('productId', productId);
      if (categoryId) qs.set('categoryId', categoryId);
      qs.set('page', String(p));
      qs.set('pageSize', '500');
      const res = await api.get<{ data: MovementRow[]; meta: MovementMeta }>(
        `/inventory/reports/item-movements?${qs.toString()}`,
      );
      all.push(...(res.data.data ?? []));
      totalPages = res.data.meta?.totalPages ?? 1;
      p += 1;
    } while (p <= totalPages);

    exportCSV(
      `inventory-movements-${dateFrom || 'all'}_${dateTo || 'all'}.csv`,
      ['Code', 'Item', 'Category', 'UoM', 'Qty Before', 'Qty In', 'Qty Out', 'Balance', 'Movement Value'],
      all.map((r) => [
        r.code, r.name, r.category ?? '', r.uom ?? '',
        num(r.openingQty), num(r.qtyIn), num(r.qtyOut), num(r.balance), formatMoney(r.totalValue),
      ]),
    );
  };

  const resetFilters = () => {
    setDateFrom(''); setDateTo(''); setLocationId(''); setProductId(''); setCategoryId(''); setPage(1);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Inventory Reports</h1>
          <p className="text-sm text-muted-foreground">Item movement summary — opening, in, out and balance per item.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleExport} disabled={report.isLoading}>
            <Download className="mr-2 h-3 w-3" />Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => report.refetch()}>
            <RefreshCw className="mr-2 h-3 w-3" />Refresh
          </Button>
        </div>
      </div>

      <Card className="p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">From</label>
            <Input type="date" className="w-36" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">To</label>
            <Input type="date" className="w-36" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Location</label>
            <Select value={locationId} onValueChange={(v) => { setLocationId(v); setPage(1); }}>
              <SelectTrigger className="w-44"><SelectValue placeholder="All locations" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">All locations</SelectItem>
                {locations.data?.map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.code} — {l.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Item</label>
            <Select value={productId} onValueChange={(v) => { setProductId(v); setPage(1); }}>
              <SelectTrigger className="w-52"><SelectValue placeholder="All items" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">All items</SelectItem>
                {products.data?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.code} — {p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Category</label>
            <Select value={categoryId} onValueChange={(v) => { setCategoryId(v); setPage(1); }}>
              <SelectTrigger className="w-44"><SelectValue placeholder="All categories" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">All categories</SelectItem>
                {categories.data?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="ghost" size="sm" onClick={resetFilters}>Reset</Button>
        </div>
      </Card>

      {report.isLoading && <Skeleton className="h-64 w-full" />}
      {report.isError && (
        <Card className="p-6 text-sm text-destructive">Failed to load the report. Check permissions and API, then refresh.</Card>
      )}

      {report.data && (
        <>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Code</th>
                  <th className="px-3 py-2 text-left font-medium">Item</th>
                  <th className="px-3 py-2 text-left font-medium">Category</th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Qty Before</th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Qty In</th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Qty Out</th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Net</th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Balance</th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Value (Movement)</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                      No movements found for the selected filters.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.productId} className="border-b hover:bg-muted/30">
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.code}</td>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">
                      {r.name}
                      {r.uom && <span className="text-muted-foreground text-xs"> · {r.uom}</span>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{r.category ?? '—'}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{num(r.openingQty)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-emerald-600">{num(r.qtyIn)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-destructive">{num(r.qtyOut)}</td>
                    <td className={`px-3 py-2 text-right font-mono tabular-nums ${r.netQty > 0 ? 'text-emerald-600' : r.netQty < 0 ? 'text-destructive' : ''}`}>
                      {r.netQty > 0 ? '+' : ''}{num(r.netQty)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold">{num(r.balance)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{formatMoney(r.totalValue)}</td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="border-t bg-muted/40 font-medium">
                    <td className="px-3 py-2" colSpan={3}>Totals — {report.data.meta.total} item(s)</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{num(rows.reduce((s, r) => s + r.openingQty, 0))}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{num(rows.reduce((s, r) => s + r.qtyIn, 0))}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{num(rows.reduce((s, r) => s + r.qtyOut, 0))}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{num(rows.reduce((s, r) => s + r.netQty, 0))}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{num(rows.reduce((s, r) => s + r.balance, 0))}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {formatMoney(rows.reduce((s, r) => s + r.totalValue, 0))}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{report.data.meta.total} item(s)</span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span>Page {report.data.meta.page} of {report.data.meta.totalPages}</span>
              <Button size="sm" variant="outline" disabled={page >= report.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
