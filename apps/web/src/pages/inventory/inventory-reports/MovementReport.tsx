import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DataTable, Kpi, KpiGrid, ReportState, money, qty, type Column } from './shared';
import { FilterBar, type useReportFilters } from './filters';

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
  closingQty: number;
  valueIn: number;
  valueOut: number;
  avgCost: number;
  closingValue: number;
  movements: number;
  byGroup: Record<string, number>;
  minQuantity: number | null;
  currentOnHand: number;
  ledgerDrift: number | null;
}

interface MovementResponse {
  data: MovementRow[];
  totals: {
    items: number; openingQty: number; qtyIn: number; qtyOut: number; netQty: number;
    closingQty: number; valueIn: number; valueOut: number; closingValue: number; movements: number; driftItems: number;
  };
  meta: { start: string | null; end: string | null };
}

const GROUPS = [
  { key: 'received', label: 'Received' },
  { key: 'consumed', label: 'Consumed / sold' },
  { key: 'adjusted', label: 'Adjusted' },
  { key: 'transferred', label: 'Transfers' },
  { key: 'lost', label: 'Waste / loss' },
  { key: 'returned', label: 'Returned to supplier' },
];

const signed = (v: number) => (
  <span className={cn(v > 0 && 'text-emerald-600', v < 0 && 'text-destructive')}>
    {v > 0 ? '+' : ''}{qty(v)}
  </span>
);

export function MovementReport({ ctl }: { ctl: ReturnType<typeof useReportFilters> }) {
  const navigate = useNavigate();
  const { filters: f, toQuery } = ctl;
  const qs = toQuery(['start', 'end', 'locationId', 'categoryId', 'productId', 'search', 'moveTypes', 'includeIdle', 'excludeTransfers']);

  const report = useQuery<MovementResponse>({
    queryKey: ['inventory-report', 'item-movements', qs],
    queryFn: async () => (await api.get(`/inventory/reports/item-movements?${qs}`)).data,
  });

  const t = report.data?.totals;
  const periodLabel = f.start || f.end ? `${f.start || 'beginning'} → ${f.end || 'today'}` : 'All time';

  const columns: Column<MovementRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.code}</span>, sort: (r) => r.code },
    {
      key: 'name', header: 'Item', className: 'whitespace-nowrap font-medium',
      render: (r) => <>{r.name}{r.uom && <span className="text-xs text-muted-foreground"> · {r.uom}</span>}</>,
      sort: (r) => r.name, footer: `Totals — ${t?.items ?? 0} item(s)`,
    },
    { key: 'category', header: 'Category', render: (r) => <span className="text-muted-foreground">{r.category ?? '—'}</span>, sort: (r) => r.category },
    { key: 'uom', header: 'UoM', render: (r) => r.uom ?? '', csv: (r) => r.uom, hidden: true },
    { key: 'openingQty', header: 'Opening', align: 'right', render: (r) => qty(r.openingQty), sort: (r) => r.openingQty, footer: qty(t?.openingQty) },
    { key: 'qtyIn', header: 'Qty In', align: 'right', render: (r) => <span className="text-emerald-600">{qty(r.qtyIn)}</span>, sort: (r) => r.qtyIn, footer: qty(t?.qtyIn), hidden: f.detailed },
    { key: 'qtyOut', header: 'Qty Out', align: 'right', render: (r) => <span className="text-destructive">{qty(r.qtyOut)}</span>, sort: (r) => r.qtyOut, footer: qty(t?.qtyOut), hidden: f.detailed },
    ...GROUPS.map<Column<MovementRow>>((g) => ({
      key: `g_${g.key}`, header: g.label, align: 'right', hidden: !f.detailed,
      render: (r) => (r.byGroup[g.key] ? signed(r.byGroup[g.key]) : <span className="text-muted-foreground">—</span>),
      sort: (r) => r.byGroup[g.key] ?? 0,
    })),
    { key: 'netQty', header: 'Net', align: 'right', render: (r) => signed(r.netQty), sort: (r) => r.netQty, footer: qty(t?.netQty) },
    {
      key: 'closingQty', header: 'Closing', align: 'right',
      render: (r) => (
        <span className={cn('font-semibold', r.closingQty < 0 && 'text-destructive', r.minQuantity != null && r.closingQty >= 0 && r.closingQty <= r.minQuantity && 'text-amber-600')}>
          {qty(r.closingQty)}
          {r.ledgerDrift != null && Math.abs(r.ledgerDrift) > 1e-6 && (
            <span className="ml-1 text-amber-600" title={`Ledger closing ${qty(r.closingQty)} ≠ cached on-hand ${qty(r.currentOnHand)} — run a stock reconciliation`}>⚠</span>
          )}
        </span>
      ),
      sort: (r) => r.closingQty, footer: qty(t?.closingQty),
    },
    { key: 'currentOnHand', header: 'On Hand (cached)', align: 'right', render: (r) => qty(r.currentOnHand), sort: (r) => r.currentOnHand, hidden: true },
    { key: 'ledgerDrift', header: 'Ledger Drift', align: 'right', render: (r) => qty(r.ledgerDrift), sort: (r) => r.ledgerDrift, hidden: true },
    { key: 'valueIn', header: 'Value In', align: 'right', render: (r) => money(r.valueIn), sort: (r) => r.valueIn, footer: money(t?.valueIn) },
    { key: 'valueOut', header: 'Value Out', align: 'right', render: (r) => money(r.valueOut), sort: (r) => r.valueOut, footer: money(t?.valueOut) },
    { key: 'avgCost', header: 'Avg Cost', align: 'right', render: (r) => money(r.avgCost), sort: (r) => r.avgCost },
    { key: 'closingValue', header: 'Closing Value', align: 'right', render: (r) => <span className="font-semibold">{money(r.closingValue)}</span>, sort: (r) => r.closingValue, footer: money(t?.closingValue) },
    { key: 'movements', header: 'Moves', align: 'right', render: (r) => r.movements, sort: (r) => r.movements, footer: t?.movements },
  ];

  return (
    <div className="space-y-4">
      <FilterBar ctl={ctl} show={['date', 'location', 'category', 'product', 'search', 'moveTypes', 'detailed', 'idle', 'transfers']} />
      <ReportState query={report}>
        {t && (
          <KpiGrid>
            <Kpi label="Items" value={t.items.toLocaleString()} hint={periodLabel} />
            <Kpi label="Value received (in)" value={money(t.valueIn)} tone="good" hint={`${qty(t.qtyIn)} units`} />
            <Kpi label="Value issued (out)" value={money(t.valueOut)} tone="bad" hint={`${qty(t.qtyOut)} units`} />
            <Kpi label="Net quantity" value={qty(t.netQty)} tone={t.netQty < 0 ? 'bad' : t.netQty > 0 ? 'good' : undefined} />
            <Kpi label="Closing stock value" value={money(t.closingValue)} hint="Closing qty × current avg cost" />
            <Kpi
              label="Ledger movements"
              value={t.movements.toLocaleString()}
              tone={t.driftItems ? 'warn' : undefined}
              hint={t.driftItems ? `⚠ ${t.driftItems} item(s) where ledger ≠ on-hand` : undefined}
            />
          </KpiGrid>
        )}
        <DataTable
          rows={report.data?.data ?? []}
          columns={columns}
          rowKey={(r) => r.productId}
          defaultSort={{ key: 'name', dir: 'asc' }}
          exportName={`inventory-movements_${f.start || 'all'}_${f.end || 'all'}`}
          emptyText="No stock movements for the selected filters. Try a wider period or tick “Include items with no stock / movement”."
          onRowClick={(r) => {
            navigate(`/inventory/items/${r.productId}${f.locationId ? `?locationId=${f.locationId}` : ''}`);
          }}
          toolbar={<span className="text-xs">Click a row to open the item's stock card. Balances ignore the movement-type filter.</span>}
        />
      </ReportState>
    </div>
  );
}
