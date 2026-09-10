import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Package, Search, AlertTriangle, TrendingDown,
  Boxes, RefreshCw, MapPin, XCircle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
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
import { DirectStockActions } from './DirectStockActions';

interface ProductStockLevel {
  id: string;
  code: string;
  name: string;
  sku: string | null;
  productType: string;
  minQuantity: number | null;
  batchTracking: boolean;
  uom: string | null;
  totalQuantity: number;
  averageCost: number;
  totalValue: number;
  isLow: boolean;
  isOut: boolean;
}

interface Stats { totalItems: number; lowStockCount: number; totalLocations: number; totalProducts: number }
interface Location { id: string; code: string; name: string; type: string }

const PRODUCT_TYPE_LABELS: Record<string, string> = {
  stockable: 'Stockable',
  consumable: 'Consumable',
  service: 'Service',
  fee: 'Fee',
  subscription: 'Subscription',
  asset: 'Asset',
};

export function InventoryItemsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [locationId, setLocationId] = useState('all');
  const [view, setView] = useState<'all' | 'low' | 'out'>('all');
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
  if (view === 'out') params.set('outOfStock', 'true');

  const items = useQuery<{ data: ProductStockLevel[]; meta: { page: number; pageSize: number; total: number; totalPages: number } }>({
    queryKey: ['inventory-product-stock-levels', debouncedSearch, locationId, view],
    queryFn: async () => (await api.get(`/inventory/product-stock-levels?${params.toString()}`)).data,
  });

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Stock Levels</h1>
          <div className="flex items-center gap-2">
            <DirectStockActions />
            <Button variant="outline" size="sm" onClick={() => items.refetch()}>
              <RefreshCw className="mr-2 h-3 w-3" />Refresh
            </Button>
          </div>
        </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Card className="p-2">
          <CardContent className="flex items-center gap-2 p-0">
            <Package className="h-4 w-4 text-sky-600 shrink-0" />
            <div className="flex w-full items-center justify-between gap-1">
              <span className="text-xs text-muted-foreground">Total Products</span>
              <span className="text-sm font-bold text-sky-600">{stats.data?.totalProducts ?? '—'}</span>
            </div>
          </CardContent>
        </Card>
        <Card className="p-2">
          <CardContent className="flex items-center gap-2 p-0">
            <Boxes className="h-4 w-4 text-emerald-600 shrink-0" />
            <div className="flex w-full items-center justify-between gap-1">
              <span className="text-xs text-muted-foreground">In Stock</span>
              <span className="text-sm font-bold text-emerald-600">{stats.data?.totalItems ?? '—'}</span>
            </div>
          </CardContent>
        </Card>
        <Card className="p-2">
          <CardContent className="flex items-center gap-2 p-0">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
            <div className="flex w-full items-center justify-between gap-1">
              <span className="text-xs text-muted-foreground">Low Stock</span>
              <span className="text-sm font-bold text-amber-600">{stats.data?.lowStockCount ?? '—'}</span>
            </div>
          </CardContent>
        </Card>
        <Card className="p-2">
          <CardContent className="flex items-center gap-2 p-0">
            <MapPin className="h-4 w-4 text-indigo-600 shrink-0" />
            <div className="flex w-full items-center justify-between gap-1">
              <span className="text-xs text-muted-foreground">Locations</span>
              <span className="text-sm font-bold text-indigo-600">{stats.data?.totalLocations ?? '—'}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8" placeholder="Search products…"
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
          <Button size="sm" variant={view === 'out' ? 'default' : 'outline'} onClick={() => setView('out')}>
            <XCircle className="mr-1 h-3 w-3" />Out of Stock
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
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-right font-medium">On Hand</th>
                  <th className="px-3 py-2 text-right font-medium">Min Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Avg Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Total Value</th>
                  <th className="px-3 py-2 text-center font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.data.data.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">No products found</td></tr>
                )}
                {items.data.data.map((item) => {
                  const value = item.averageCost * item.totalQuantity;
                  return (
                    <tr key={item.id} className="border-b hover:bg-muted/30 cursor-pointer" onClick={() => navigate(`/inventory/items/${item.id}`)}>
                      <td className="px-3 py-2 font-medium hover:text-primary hover:underline">{item.name}</td>
                      <td className="px-3 py-2 text-muted-foreground">{item.code}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="text-xs">{PRODUCT_TYPE_LABELS[item.productType] ?? item.productType}</Badge>
                      </td>
                      <td className={`px-3 py-2 text-right font-mono tabular-nums ${item.isOut ? 'text-destructive' : item.isLow ? 'text-amber-600' : ''}`}>
                        {item.totalQuantity}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {item.minQuantity ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {formatMoney(item.averageCost)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {formatMoney(value)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {item.isOut ? (
                          <Badge variant="destructive">Out of stock</Badge>
                        ) : item.isLow ? (
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
            <span>{items.data.meta.total} product(s)</span>
            <span>Page {items.data.meta.page} of {items.data.meta.totalPages}</span>
          </div>
        </>
      )}
    </div>

  </>
  );
}
