import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { DataTable, Kpi, KpiGrid, ReportState, money, qty, type Column } from './shared';
import { Field, FilterBar, type useReportFilters } from './filters';

type Ctl = ReturnType<typeof useReportFilters>;

interface HealthRow {
  productId: string; variantId: string | null; locationId: string; location: string;
  code: string; name: string; category: string | null; uom: string | null;
  onHand: number; unitCost: number; value: number;
  aging: { d0_30: number; d31_60: number; d61_90: number; d91_180: number; d180_plus: number };
  weightedAgeDays: number | null; lastConsumedAt: string | null; daysSinceConsumed: number | null;
  consumedQty: number; consumedValue: number; turnover: number | null; daysOfCover: number | null;
  status: 'active' | 'slow' | 'dead';
}

interface HealthReport {
  summary: {
    slowDays: number; deadDays: number; start: string; end: string; quants: number;
    totalValue: number; activeValue: number; slowValue: number; deadValue: number;
    slowCount: number; deadCount: number; truncated: boolean;
  };
  rows: HealthRow[];
}

const STATUS_BADGE: Record<HealthRow['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' }> = {
  active: { label: 'Active', variant: 'secondary' },
  slow: { label: 'Slow-moving', variant: 'default' },
  dead: { label: 'Dead stock', variant: 'destructive' },
};

/** Aging, turnover, days of cover and slow / dead stock per item and location. */
export function StockHealthReport({ ctl }: { ctl: Ctl }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'all' | HealthRow['status']>('all');
  const [slowDays, setSlowDays] = useState('90');
  const [deadDays, setDeadDays] = useState('180');
  const base = ctl.toQuery(['start', 'end', 'locationId', 'categoryId', 'search']);
  const qs = `${base}${base ? '&' : ''}status=${status}&slowDays=${encodeURIComponent(slowDays)}&deadDays=${encodeURIComponent(deadDays)}`;
  const report = useQuery<HealthReport>({
    queryKey: ['inventory-report', 'stock-health', qs],
    queryFn: async () => (await api.get(`/inventory/reports/stock-health?${qs}`)).data,
  });
  const rows = report.data?.rows ?? [];
  const s = report.data?.summary;

  const columns: Column<HealthRow>[] = [
    { key: 'name', header: 'Item', className: 'whitespace-nowrap font-medium', render: (r) => <>{r.name}{r.uom && <span className="text-xs text-muted-foreground"> · {r.uom}</span>}</>, sort: (r) => r.name },
    { key: 'location', header: 'Location', render: (r) => r.location, sort: (r) => r.location },
    { key: 'status', header: 'Status', render: (r) => <Badge variant={STATUS_BADGE[r.status].variant}>{STATUS_BADGE[r.status].label}</Badge>, sort: (r) => r.status },
    { key: 'onHand', header: 'On Hand', align: 'right', render: (r) => qty(r.onHand), sort: (r) => r.onHand },
    { key: 'value', header: 'Value', align: 'right', render: (r) => money(r.value), sort: (r) => r.value, footer: money(rows.reduce((t, r) => t + r.value, 0)) },
    { key: 'd0_30', header: '0–30d', align: 'right', render: (r) => qty(r.aging.d0_30), sort: (r) => r.aging.d0_30 },
    { key: 'd31_60', header: '31–60d', align: 'right', render: (r) => qty(r.aging.d31_60), sort: (r) => r.aging.d31_60 },
    { key: 'd61_90', header: '61–90d', align: 'right', render: (r) => qty(r.aging.d61_90), sort: (r) => r.aging.d61_90 },
    { key: 'd91_180', header: '91–180d', align: 'right', render: (r) => qty(r.aging.d91_180), sort: (r) => r.aging.d91_180 },
    { key: 'd180_plus', header: '180d+', align: 'right', render: (r) => <span className={r.aging.d180_plus > 0 ? 'font-semibold text-amber-600' : ''}>{qty(r.aging.d180_plus)}</span>, sort: (r) => r.aging.d180_plus },
    { key: 'lastConsumedAt', header: 'Last Used', render: (r) => (r.lastConsumedAt ? date(r.lastConsumedAt) : <span className="text-muted-foreground">Never</span>), sort: (r) => r.lastConsumedAt },
    { key: 'consumedQty', header: 'Used (period)', align: 'right', render: (r) => qty(r.consumedQty), sort: (r) => r.consumedQty },
    { key: 'turnover', header: 'Turnover', align: 'right', render: (r) => (r.turnover == null ? '—' : `${r.turnover}×`), sort: (r) => r.turnover },
    { key: 'daysOfCover', header: 'Days of Cover', align: 'right', render: (r) => (r.daysOfCover == null ? '—' : r.daysOfCover), sort: (r) => r.daysOfCover },
  ];

  const numberField = (label: string, value: string, onChange: (v: string) => void, id: string) => (
    <Field label={label}>
      <Input id={id} type="number" min="1" inputMode="numeric" className="h-9 w-24" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );

  return (
    <div className="space-y-4">
      <FilterBar
        ctl={ctl}
        show={['date', 'location', 'category', 'search']}
        extra={
          <>
            <Field label="Status">
              <select
                aria-label="Stock health status"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={status}
                onChange={(e) => setStatus(e.target.value as typeof status)}
              >
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="slow">Slow-moving</option>
                <option value="dead">Dead stock</option>
              </select>
            </Field>
            {numberField('Slow after (days)', slowDays, setSlowDays, 'health-slow-days')}
            {numberField('Dead after (days)', deadDays, setDeadDays, 'health-dead-days')}
          </>
        }
      />
      <ReportState query={report}>
        {s && (
          <KpiGrid>
            <Kpi label="Stock value" value={money(s.totalValue)} hint={`${s.quants} item-locations on hand`} />
            <Kpi label="Slow-moving" value={money(s.slowValue)} hint={`${s.slowCount} lines · no use in ${s.slowDays}+ days`} tone={s.slowCount ? 'warn' : 'good'} />
            <Kpi label="Dead stock" value={money(s.deadValue)} hint={`${s.deadCount} lines · no use in ${s.deadDays}+ days`} tone={s.deadCount ? 'bad' : 'good'} />
            <Kpi label="Turnover period" value={`${s.start} → ${s.end}`} hint="Used quantity ÷ average on hand" />
          </KpiGrid>
        )}
        {s?.truncated && <p role="status" className="text-sm text-amber-600">Showing the first 5,000 item-locations — narrow the location or category.</p>}
        <DataTable
          rows={rows} columns={columns} rowKey={(r) => `${r.productId}:${r.variantId ?? ''}:${r.locationId}`}
          defaultSort={{ key: 'value', dir: 'desc' }}
          exportName={`inventory-stock-health_${new Date().toISOString().slice(0, 10)}`}
          emptyText="No stock on hand in this scope."
          onRowClick={(r) => navigate(`/inventory/items/${r.productId}`)}
        />
      </ReportState>
    </div>
  );
}
