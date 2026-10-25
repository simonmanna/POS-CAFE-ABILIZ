import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Boxes, Plus } from 'lucide-react';
import { useRentalUnits, useGenerateUnits, useRetireUnit, useServiceOrders, useCreateServiceOrder, useCompleteServiceOrder } from '@/features/rental/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { date } from '@/lib/format';
import { tx } from '@/lib/i18n/tx';

const STATUS_STYLES: Record<string, string> = {
  available: 'bg-emerald-100 text-emerald-800',
  rented: 'bg-blue-100 text-blue-800',
  maintenance: 'bg-amber-100 text-amber-800',
  damaged: 'bg-red-100 text-red-800',
  retired: 'bg-muted text-muted-foreground',
};

export function RentalUnitsPage() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const { data } = useRentalUnits({ status: status || undefined, search: search || undefined, pageSize: 100 });
  const generate = useGenerateUnits();
  const retire = useRetireUnit();

  const [genOpen, setGenOpen] = useState(false);
  const [productId, setProductId] = useState('');
  const [count, setCount] = useState(10);
  const [template, setTemplate] = useState('R-{n}');

  const [soUnit, setSoUnit] = useState('');
  const [soType, setSoType] = useState('cleaning');
  const createSo = useCreateServiceOrder();
  const completeSo = useCompleteServiceOrder();
  const { data: soData } = useServiceOrders({ pageSize: 10 });

  const rows = useMemo(() => data?.items ?? [], [data]);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? msg + ' failed');
    }
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{tx('Rental Units')}</h1>
          <p className="text-sm text-muted-foreground">{tx('Serialized fleet items with status and service history.')}</p>
        </div>
        <Button onClick={() => setGenOpen((v) => !v)}><Plus className="h-4 w-4" /> {tx('Generate units')}</Button>
      </div>

      {genOpen && (
        <Card>
          <CardHeader className="bg-muted/30 border-b rounded-t-lg">
            <CardTitle className="text-sm">{tx('Bulk generate units')}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-4 items-end gap-2 p-4">
            <label className="col-span-2">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{tx('Product ID')}</span>
              <input value={productId} onChange={(e) => setProductId(e.target.value)} placeholder={tx('productId')} className="w-full rounded-md border bg-card px-3 py-2 text-sm" />
            </label>
            <label>
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{tx('Count')}</span>
              <input type="number" min={1} value={count} onChange={(e) => setCount(Number(e.target.value))} className="w-full rounded-md border bg-card px-3 py-2 text-sm" />
            </label>
            <label>
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{tx('Code template')}</span>
              <input value={template} onChange={(e) => setTemplate(e.target.value)} className="w-full rounded-md border bg-card px-3 py-2 text-sm" />
            </label>
            <Button
              className="col-start-4"
              size="sm"
              disabled={!productId}
              onClick={() => run(
                () => generate.mutateAsync({ productId, count, template }),
                `${count} units generated`,
              )}
            >
              {tx('Generate')}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={tx('Search code or barcode…')}
          className="w-64 rounded-md border bg-card px-3 py-2 text-sm"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border bg-card px-3 py-2 text-sm">
          <option value="">{tx('All statuses')}</option>
          <option value="available">{tx('Available')}</option>
          <option value="rented">{tx('Rented')}</option>
          <option value="maintenance">{tx('Maintenance')}</option>
          <option value="damaged">{tx('Damaged')}</option>
          <option value="retired">{tx('Retired')}</option>
        </select>
      </div>

      <Card>
        <CardHeader className="bg-muted/30 border-b rounded-t-lg">
          <CardTitle className="text-sm">{rows.length} {tx('units')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {rows.length === 0 && <p className="p-6 text-sm text-muted-foreground">{tx('No units. Generate some above.')}</p>}
            {rows.map((u) => (
              <div key={u.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <Boxes className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{u.unitCode}</p>
                    <p className="text-xs text-muted-foreground">
                      {u.product?.name ?? u.productId.slice(0, 8)} · {u.barcode ?? 'no barcode'} {tx('· rentals')} {u.rentalCount}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {u.status === 'maintenance' || u.status === 'damaged' ? (
                    <button
                      className="rounded border px-2 py-1 text-xs hover:bg-muted"
                      onClick={() => { setSoUnit(u.id); }}
                      title={tx('Create service order')}
                    >
                      {tx('Service')}
                    </button>
                  ) : null}
                  {u.status === 'available' && (
                    <button
                      className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                      onClick={() => run(() => retire.mutateAsync({ id: u.id }), 'Unit retired')}
                    >
                      {tx('Retire')}
                    </button>
                  )}
                  <Badge variant="outline" className={STATUS_STYLES[u.status] ?? ''}>{u.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {soUnit && (
        <Card>
          <CardHeader className="bg-muted/30 border-b rounded-t-lg">
            <CardTitle className="text-sm">{tx('Service order for')} {soUnit}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-end gap-2 p-4">
            <label className="flex-1">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{tx('Type')}</span>
              <select value={soType} onChange={(e) => setSoType(e.target.value)} className="w-full rounded-md border bg-card px-3 py-2 text-sm">
                <option value="cleaning">{tx('Cleaning')}</option>
                <option value="repair">{tx('Repair')}</option>
                <option value="maintenance">{tx('Maintenance')}</option>
              </select>
            </label>
            <Button
              size="sm"
              onClick={() => run(
                () => createSo.mutateAsync({ unitId: soUnit, type: soType }),
                'Service order created',
              )}
            >
              {tx('Create')}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="bg-muted/30 border-b rounded-t-lg">
          <CardTitle className="text-sm">{tx('Recent service orders')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {(soData?.items ?? []).length === 0 && <p className="p-6 text-sm text-muted-foreground">{tx('None yet.')}</p>}
            {(soData?.items ?? []).map((so: any) => (
              <div key={so.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{so.serviceNumber ?? so.id.slice(0, 8)} · {so.type}</p>
                  <p className="text-xs text-muted-foreground">{tx('Unit')} {so.unit?.unitCode ?? so.unitId?.slice(0, 8)} {tx('· created')} {date(so.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {so.status === 'open' && (
                    <Button size="sm" variant="outline" onClick={() => run(() => completeSo.mutateAsync({ id: so.id }), 'Service order completed')}>
                      {tx('Complete')}
                    </Button>
                  )}
                  <Badge variant="outline">{so.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
