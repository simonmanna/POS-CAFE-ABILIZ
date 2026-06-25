import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Package, Search, AlertTriangle, TrendingDown,
  Boxes, RefreshCw, MapPin,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';

interface StockItem {
  id: string;
  quantity: number;
  runningAverageCost: string;
  product: {
    id: string; code: string; name: string; sku: string | null;
    minQuantity: string | null; batchTracking: boolean; uom: string | null;
  };
  location: { id: string; code: string; name: string };
}

interface Stats { totalItems: number; lowStockCount: number; totalLocations: number; totalProducts: number }
interface Location { id: string; code: string; name: string; type: string }

export function InventoryItemsPage() {
  const [search, setSearch] = useState('');
  const [locationId, setLocationId] = useState('all');
  const [view, setView] = useState<'all' | 'low'>('all');
  const debouncedSearch = useDebouncedValue(search, 350);

  const stats = useQuery<Stats>({
    queryKey: ['inventory-stats'],
    queryFn: async () => (await api.get<Stats>('/inventory/stats')).data,
    refetchInterval: 30_000,
  });

  const locations = useQuery<Location[]>({
    queryKey: ['inventory-locations'],
    queryFn: async () => {
      const res = await api.get<{ data: Location[] }>('/inventory/locations');
      return res.data.data ?? [];
    },
  });

  const params = new URLSearchParams();
  if (debouncedSearch) params.set('search', debouncedSearch);
  if (locationId && locationId !== 'all') params.set('locationId', locationId);
  if (view === 'low') params.set('lowStock', 'true');

  const items = useQuery<{ data: StockItem[]; meta: { page: number; pageSize: number; total: number; totalPages: number } }>({
    queryKey: ['inventory-items', debouncedSearch, locationId, view],
    queryFn: async () => (await api.get(`/inventory/items?${params.toString()}`)).data,
  });

  const isLow = (item: StockItem) => {
    const min = item.product.minQuantity ? Number(item.product.minQuantity) : 0;
    return min > 0 && item.quantity <= min;
  };
  const isOut = (item: StockItem) => item.quantity <= 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Inventory Items</h1>
          <p className="text-sm text-muted-foreground">Stock levels across all locations</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => items.refetch()}>
          <RefreshCw className="mr-2 h-3 w-3" />Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total Items</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <p className="flex items-center gap-2 text-2xl font-bold text-sky-600">
              <Package className="h-5 w-5" />{stats.data?.totalItems ?? '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Low Stock</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <p className="flex items-center gap-2 text-2xl font-bold text-amber-600">
              <AlertTriangle className="h-5 w-5" />{stats.data?.lowStockCount ?? '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Products</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <p className="flex items-center gap-2 text-2xl font-bold text-indigo-600">
              <Boxes className="h-5 w-5" />{stats.data?.totalProducts ?? '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Locations</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <p className="flex items-center gap-2 text-2xl font-bold text-emerald-600">
              <MapPin className="h-5 w-5" />{stats.data?.totalLocations ?? '—'}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8" placeholder="Search items…"
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={locationId} onValueChange={setLocationId}>
          <SelectTrigger className="w-44"><SelectValue placeholder="All locations" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All locations</SelectItem>
            {locations.data?.map((l) => (
              <SelectItem key={l.id} value={l.id}>{l.code} — {l.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex gap-1">
          <Button size="sm" variant={view === 'all' ? 'default' : 'outline'} onClick={() => setView('all')}>All</Button>
          <Button size="sm" variant={view === 'low' ? 'default' : 'outline'} onClick={() => setView('low')}>
            <TrendingDown className="mr-1 h-3 w-3" />Low Stock
          </Button>
        </div>
      </div>

      {items.isLoading && <Skeleton className="h-64 w-full" />}

      {items.data && (
        <>
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-left font-medium">Code</th>
                  <th className="px-3 py-2 text-left font-medium">Location</th>
                  <th className="px-3 py-2 text-right font-medium">On Hand</th>
                  <th className="px-3 py-2 text-right font-medium">Min Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Unit Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                  <th className="px-3 py-2 text-center font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.data.data.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">No items found</td></tr>
                )}
                {items.data.data.map((item) => {
                  const low = isLow(item);
                  const out = isOut(item);
                  const value = Number(item.runningAverageCost) * item.quantity;
                  return (
                    <tr key={item.id} className="border-b hover:bg-muted/30">
                      <td className="px-3 py-2 font-medium">{item.product.name}</td>
                      <td className="px-3 py-2 text-muted-foreground">{item.product.code}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="text-xs">{item.location.code}</Badge>
                      </td>
                      <td className={`px-3 py-2 text-right font-mono tabular-nums ${out ? 'text-destructive' : low ? 'text-amber-600' : ''}`}>
                        {item.quantity}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {item.product.minQuantity ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {formatMoney(item.runningAverageCost)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {formatMoney(value)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {out ? (
                          <Badge variant="destructive">Out of stock</Badge>
                        ) : low ? (
                          <Badge variant="secondary" className="bg-amber-100 text-amber-800">Low stock</Badge>
                        ) : (
                          <Badge variant="default" className="bg-emerald-100 text-emerald-800">In stock</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{items.data.meta.total} item(s)</span>
            <span>Page {items.data.meta.page} of {items.data.meta.totalPages}</span>
          </div>
        </>
      )}
    </div>
  );
}
