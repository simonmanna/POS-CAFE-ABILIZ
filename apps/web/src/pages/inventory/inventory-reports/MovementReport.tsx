import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { dateTime } from '@/lib/format';
import { DataTable, Kpi, KpiGrid, moveTypeLabel, ReportState, money, qty, type Column } from './shared';
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

interface RegisterLine {
  id: string;
  date: string;
  ledgerCode: string;
  docRef: string | null;
  source: string;
  sourceLabel: string;
  type: string;
  typeLabel: string;
  productId: string;
  code: string;
  name: string;
  category: string;
  uom: string | null;
  locationId: string;
  location: string;
  toLocation: string | null;
  qtyBefore: number;
  balanceAfter: number;
  batchNumber: string | null;
  qty: number;
  unitCost: number;
  value: number;
  reason: string;
  responsible: string | null;
  approvedBy: string | null;
  performedBy: string | null;
  notes: string | null;
}

interface RegisterResponse {
  range: { start: string; end: string; days: number };
  summary: {
    lines: number; qty: number; value: number; documents: number; items: number; locations: number;
    grossValue: number; gainQty?: number; gainValue?: number; lossQty?: number; lossValue?: number;
  };
  rows: RegisterLine[];
  truncated: boolean;
}

const TXN_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  receipt: { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Receipt' },
  issue: { bg: 'bg-purple-50', text: 'text-purple-700', label: 'Issue' },
  adjustment_in: { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Adj In' },
  adjustment_out: { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Adj Out' },
  transfer_in: { bg: 'bg-slate-50', text: 'text-slate-700', label: 'Transfer In' },
  transfer_out: { bg: 'bg-slate-50', text: 'text-slate-700', label: 'Transfer Out' },
  waste: { bg: 'bg-red-50', text: 'text-red-700', label: 'Waste' },
  return_in: { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Return In' },
  return_to_supplier: { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Return Out' },
  expiry_write_off: { bg: 'bg-red-50', text: 'text-red-700', label: 'Expired' },
  opening_balance: { bg: 'bg-gray-50', text: 'text-gray-700', label: 'Opening' },
};

function MoveBadge({ type }: { type: string }) {
  const c = TXN_COLORS[type] ?? { bg: 'bg-gray-50', text: 'text-gray-700', label: moveTypeLabel(type) };
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-semibold ${c.bg} ${c.text}`}>{c.label}</span>;
}

const signed = (v: number) => (
  <span className={cn(v > 0 && 'text-emerald-600', v < 0 && 'text-destructive')}>
    {v > 0 ? '+' : ''}{qty(v)}
  </span>
);

const GROUPS = [
  { key: 'received', label: 'Received' },
  { key: 'consumed', label: 'Consumed / sold' },
  { key: 'adjusted', label: 'Adjusted' },
  { key: 'transferred', label: 'Transfers' },
  { key: 'lost', label: 'Waste / loss' },
  { key: 'returned', label: 'Returned to supplier' },
];

export function MovementReport({ ctl }: { ctl: ReturnType<typeof useReportFilters> }) {
  const navigate = useNavigate();
  const { filters: f, toQuery } = ctl;
  const [view, setView] = useState<'summary' | 'lines'>('summary');
  const qs = toQuery(['start', 'end', 'locationId', 'categoryId', 'productId', 'search', 'moveTypes', 'includeIdle', 'excludeTransfers']);

  const report = useQuery<MovementResponse>({
    queryKey: ['inventory-report', 'item-movements', qs],
    queryFn: async () => (await api.get(`/inventory/reports/item-movements?${qs}`)).data,
  });

  const linesQ = toQuery(['start', 'end', 'locationId', 'categoryId', 'productId', 'search']);
  const lines = useQuery<RegisterResponse>({
    queryKey: ['inventory-report', 'register', 'all', linesQ],
    queryFn: async () => (await api.get(`/inventory/reports/register/all?${linesQ}`)).data,
    placeholderData: (prev) => prev,
    enabled: view === 'lines',
  });

  const t = report.data?.totals;
  const l = lines.data;
  const ls = l?.summary;
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

  const lineCols: Column<RegisterLine>[] = [
    { key: 'date', header: 'Date', render: (l) => <span className="whitespace-nowrap text-xs text-muted-foreground">{dateTime(l.date)}</span>, sort: (l) => l.date, csv: (l) => dateTime(l.date) },
    { key: 'type', header: 'Type', render: (l) => <MoveBadge type={l.type} />, sort: (l) => l.type },
    { key: 'name', header: 'Item', className: 'whitespace-nowrap font-medium', render: (l) => <>{l.name}{l.code && <span className="ml-1 font-mono text-xs text-muted-foreground">{l.code}</span>}</>, sort: (l) => l.name },
    { key: 'location', header: 'Location', render: (l) => <span className="text-xs">{l.location}</span>, sort: (l) => l.location },
    {
      key: 'qty', header: 'Change', align: 'right', sort: (l) => l.qty,
      render: (l) => (
        <span className={`font-bold text-sm ${l.qty >= 0 ? 'text-emerald-600' : 'text-destructive'}`}>
          {l.qty >= 0 ? '+' : ''}{qty(l.qty)}{l.uom ? ` ${l.uom}` : ''}
        </span>
      ),
    },
    { key: 'qtyBefore', header: 'Before', align: 'right', render: (l) => <span className="text-sm text-muted-foreground">{qty(l.qtyBefore)}</span>, sort: (l) => l.qtyBefore },
    { key: 'balanceAfter', header: 'After', align: 'right', render: (l) => <span className="text-sm font-semibold">{qty(l.balanceAfter)}</span>, sort: (l) => l.balanceAfter },
    { key: 'batch', header: 'Batch', render: (l) => <span className="text-xs font-mono text-muted-foreground">{l.batchNumber ?? '—'}</span>, sort: (l) => l.batchNumber },
    { key: 'reference', header: 'Reference', render: (l) => (l.docRef && l.docRef.length < 30 ? <span className="text-xs font-mono">{l.docRef}</span> : <span className="text-xs text-muted-foreground">—</span>), sort: (l) => l.docRef, csv: (l) => l.docRef },
  ];

  return (
    <div className="space-y-4">
      <FilterBar ctl={ctl} show={['date', 'location', 'category', 'product', 'search', 'moveTypes', 'detailed', 'idle', 'transfers']} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-full border bg-muted/50 p-1 text-sm">
          {(['summary', 'lines'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn('rounded-full px-3 py-1', view === v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
            >
              {v === 'summary' ? 'Item summary' : 'All movements'}
            </button>
          ))}
        </div>
        {view === 'lines' && <span className="text-xs text-muted-foreground">Every stock movement — stock in, stock out, waste / damages, adjustments, transfers.</span>}
      </div>

      {view === 'summary' && (
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
      )}

      {view === 'lines' && (
        <ReportState query={lines}>
          {ls && (
            <KpiGrid>
              <Kpi label="Movements" value={ls.lines.toLocaleString()} hint={`${l?.range.start} → ${l?.range.end}`} />
              <Kpi label="Stock in (value)" value={money(ls.gainValue)} tone="good" hint={`${qty(ls.gainQty)} units`} />
              <Kpi label="Stock out / loss (value)" value={money(ls.lossValue)} tone="bad" hint={`${qty(ls.lossQty)} units`} />
              <Kpi label="Net value" value={money(ls.value)} tone={ls.value < 0 ? 'bad' : ls.value > 0 ? 'good' : undefined} />
              <Kpi label="Documents / lines" value={`${ls.documents} / ${ls.lines}`} />
              <Kpi label="Items / locations" value={`${ls.items} / ${ls.locations}`} />
            </KpiGrid>
          )}
          <DataTable
            rows={l?.rows ?? []}
            columns={lineCols}
            rowKey={(r) => r.id}
            defaultSort={{ key: 'date', dir: 'desc' }}
            exportName={`inventory-all-movements_${f.start || 'all'}_${f.end || 'all'}`}
            emptyText="No stock movements for the selected filters in this period."
            onRowClick={(r) => navigate(`/inventory/ledger/${r.id}`)}
            toolbar={
              <span className="text-xs">
                Click a line to open the ledger entry.{l?.truncated && ' Showing the latest 5,000 lines — narrow the filters for the rest.'}
              </span>
            }
          />
        </ReportState>
      )}
    </div>
  );
}
