import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { DataTable, Kpi, KpiGrid, ReportState, money, qty, type Column } from './shared';
import { FilterBar, type useReportFilters } from './filters';

type Ctl = ReturnType<typeof useReportFilters>;

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

interface ReorderRow {
  productId: string; code: string; name: string; category: string | null; uom: string | null;
  onHand: number; par: number; shortfall: number; suggestedOrderQty: number;
  unitCost: number; estimatedCost: number; supplier: { id: string; name: string } | null;
}

export function ReorderReport({ ctl }: { ctl: Ctl }) {
  const navigate = useNavigate();
  const qs = ctl.toQuery(['locationId', 'categoryId', 'search']);
  const report = useQuery<ReorderRow[]>({
    queryKey: ['inventory-report', 'reorder', qs],
    queryFn: async () => (await api.get(`/inventory/reports/reorder?${qs}`)).data,
  });
  const rows = report.data ?? [];
  const cost = rows.reduce((s, r) => s + r.estimatedCost, 0);

  const columns: Column<ReorderRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.code}</span>, sort: (r) => r.code },
    { key: 'name', header: 'Item', className: 'whitespace-nowrap font-medium', render: (r) => <>{r.name}{r.uom && <span className="text-xs text-muted-foreground"> · {r.uom}</span>}</>, sort: (r) => r.name },
    { key: 'category', header: 'Category', render: (r) => r.category ?? '—', sort: (r) => r.category },
    { key: 'supplier', header: 'Supplier', render: (r) => r.supplier?.name ?? <span className="text-muted-foreground">—</span>, sort: (r) => r.supplier?.name ?? null },
    { key: 'onHand', header: 'On Hand', align: 'right', render: (r) => <span className={r.onHand <= 0 ? 'text-destructive font-semibold' : ''}>{qty(r.onHand)}</span>, sort: (r) => r.onHand },
    { key: 'par', header: 'Par', align: 'right', render: (r) => qty(r.par), sort: (r) => r.par },
    { key: 'shortfall', header: 'Shortfall', align: 'right', render: (r) => <span className="text-amber-600">{qty(r.shortfall)}</span>, sort: (r) => r.shortfall },
    { key: 'suggestedOrderQty', header: 'Suggested Order (purchase units)', align: 'right', render: (r) => <span className="font-semibold">{qty(r.suggestedOrderQty)}</span>, sort: (r) => r.suggestedOrderQty },
    { key: 'estimatedCost', header: 'Est. Cost', align: 'right', render: (r) => money(r.estimatedCost), sort: (r) => r.estimatedCost, footer: money(cost) },
  ];

  return (
    <div className="space-y-4">
      <FilterBar ctl={ctl} show={['location', 'category', 'search']} />
      <ReportState query={report}>
        <KpiGrid>
          <Kpi label="Items at / below par" value={rows.length} tone={rows.length ? 'warn' : 'good'} />
          <Kpi label="Out of stock" value={rows.filter((r) => r.onHand <= 0).length} tone="bad" />
          <Kpi label="Without supplier" value={rows.filter((r) => !r.supplier).length} />
          <Kpi label="Estimated reorder cost" value={money(cost)} hint="Suggested qty × product cost price" />
        </KpiGrid>
        <DataTable
          rows={rows} columns={columns} rowKey={(r) => r.productId}
          defaultSort={{ key: 'shortfall', dir: 'desc' }}
          exportName={`inventory-reorder_${new Date().toISOString().slice(0, 10)}`}
          emptyText="Nothing below par. Set a minimum quantity (par) on products to use this report."
          onRowClick={(r) => navigate(`/inventory/items/${r.productId}`)}
        />
      </ReportState>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expiring batches
// ---------------------------------------------------------------------------

interface ExpiringRow {
  id: string; batchNumber: string; productId: string; code: string | null; name: string | null; uom: string | null;
  location: string | null; quantity: number; unitCost: number; value: number;
  expiryDate: string | null; daysToExpiry: number | null; expired: boolean;
}

export function ExpiringReport({ ctl }: { ctl: Ctl }) {
  const qs = ctl.toQuery(['locationId', 'categoryId', 'search', 'days']);
  const report = useQuery<ExpiringRow[]>({
    queryKey: ['inventory-report', 'expiring', qs],
    queryFn: async () => (await api.get(`/inventory/reports/expiring?${qs}`)).data,
  });
  const rows = report.data ?? [];
  const expired = rows.filter((r) => r.expired);

  const columns: Column<ExpiringRow>[] = [
    { key: 'name', header: 'Item', className: 'whitespace-nowrap font-medium', render: (r) => <>{r.name}{r.code && <span className="ml-1 font-mono text-xs text-muted-foreground">{r.code}</span>}</>, sort: (r) => r.name },
    { key: 'batchNumber', header: 'Batch', render: (r) => <span className="font-mono text-xs">{r.batchNumber}</span>, sort: (r) => r.batchNumber },
    { key: 'location', header: 'Location', render: (r) => r.location ?? '—', sort: (r) => r.location },
    { key: 'expiryDate', header: 'Expiry', render: (r) => date(r.expiryDate), sort: (r) => r.expiryDate },
    {
      key: 'daysToExpiry', header: 'Days Left', align: 'right',
      render: (r) => r.expired
        ? <Badge variant="destructive">Expired {Math.abs(r.daysToExpiry ?? 0)}d ago</Badge>
        : <span className={(r.daysToExpiry ?? 99) <= 7 ? 'font-semibold text-amber-600' : ''}>{r.daysToExpiry}</span>,
      sort: (r) => r.daysToExpiry,
    },
    { key: 'quantity', header: 'Qty', align: 'right', render: (r) => `${qty(r.quantity)}${r.uom ? ` ${r.uom}` : ''}`, sort: (r) => r.quantity },
    { key: 'value', header: 'Value at Risk', align: 'right', render: (r) => money(r.value), sort: (r) => r.value, footer: money(rows.reduce((s, r) => s + r.value, 0)) },
  ];

  return (
    <div className="space-y-4">
      <FilterBar ctl={ctl} show={['location', 'category', 'search', 'days']} />
      <ReportState query={report}>
        <KpiGrid>
          <Kpi label="Batches expiring" value={rows.length} tone={rows.length ? 'warn' : 'good'} hint={`Within ${ctl.filters.days} days`} />
          <Kpi label="Already expired" value={expired.length} tone={expired.length ? 'bad' : 'good'} />
          <Kpi label="Value at risk" value={money(rows.reduce((s, r) => s + r.value, 0))} />
          <Kpi label="Expired value" value={money(expired.reduce((s, r) => s + r.value, 0))} tone={expired.length ? 'bad' : undefined} />
        </KpiGrid>
        <DataTable
          rows={rows} columns={columns} rowKey={(r) => r.id}
          defaultSort={{ key: 'daysToExpiry', dir: 'asc' }}
          exportName={`inventory-expiring_${new Date().toISOString().slice(0, 10)}`}
          emptyText="No batch-tracked stock expiring in this window."
          rowClassName={(r) => (r.expired ? 'bg-red-50/60 dark:bg-red-950/20' : undefined)}
        />
      </ReportState>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Negative stock
// ---------------------------------------------------------------------------

interface NegativeRow {
  productId: string; variantKey: string; locationId: string; code: string | null; name: string | null;
  locationName: string | null; quantity: string; shortBy: string; unitCost: string;
  valuationExposure: string; zeroCostBasis: boolean; lastMovedAt: string;
}
interface NegativeResponse {
  summary: { cells: number; totalValuationExposure: string; zeroCostBasisCells: number };
  rows: NegativeRow[];
}

export function NegativeStockReport({ ctl }: { ctl: Ctl }) {
  const navigate = useNavigate();
  const qs = ctl.toQuery(['locationId', 'categoryId', 'search']);
  const report = useQuery<NegativeResponse>({
    queryKey: ['inventory-report', 'negative-stock', qs],
    queryFn: async () => (await api.get(`/inventory/reports/negative-stock?${qs}`)).data,
  });
  const s = report.data?.summary;

  const columns: Column<NegativeRow>[] = [
    { key: 'name', header: 'Item', className: 'whitespace-nowrap font-medium', render: (r) => <>{r.name}{r.code && <span className="ml-1 font-mono text-xs text-muted-foreground">{r.code}</span>}</>, sort: (r) => r.name },
    { key: 'locationName', header: 'Location', render: (r) => r.locationName ?? '—', sort: (r) => r.locationName },
    { key: 'quantity', header: 'On Hand', align: 'right', render: (r) => <span className="font-semibold text-destructive">{qty(r.quantity)}</span>, sort: (r) => Number(r.quantity) },
    { key: 'unitCost', header: 'Unit Cost', align: 'right', render: (r) => (r.zeroCostBasis ? <Badge variant="destructive">No cost</Badge> : money(r.unitCost)), sort: (r) => Number(r.unitCost) },
    { key: 'valuationExposure', header: 'Valuation Exposure', align: 'right', render: (r) => money(r.valuationExposure), sort: (r) => Number(r.valuationExposure), footer: money(s?.totalValuationExposure) },
    { key: 'lastMovedAt', header: 'Last Moved', render: (r) => date(r.lastMovedAt), sort: (r) => r.lastMovedAt },
  ];

  return (
    <div className="space-y-4">
      <FilterBar ctl={ctl} show={['location', 'category', 'search']} />
      <ReportState query={report}>
        {s && (
          <KpiGrid>
            <Kpi label="Negative cells" value={s.cells} tone={s.cells ? 'bad' : 'good'} hint="Item × location" />
            <Kpi label="Valuation exposure" value={money(s.totalValuationExposure)} tone={s.cells ? 'bad' : undefined} hint="Inventory overstated / COGS understated" />
            <Kpi label="Zero cost basis" value={s.zeroCostBasisCells} tone={s.zeroCostBasisCells ? 'bad' : undefined} hint="Sold with no cost — receive stock" />
          </KpiGrid>
        )}
        <DataTable
          rows={report.data?.rows ?? []} columns={columns}
          rowKey={(r) => `${r.productId}|${r.variantKey}|${r.locationId}`}
          defaultSort={{ key: 'valuationExposure', dir: 'desc' }}
          exportName={`inventory-negative-stock_${new Date().toISOString().slice(0, 10)}`}
          emptyText="No negative stock — every sale is covered by a receipt."
          onRowClick={(r) => navigate(`/inventory/items/${r.productId}?locationId=${r.locationId}`)}
        />
      </ReportState>
    </div>
  );
}
