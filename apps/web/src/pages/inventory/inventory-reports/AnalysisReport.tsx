import { useQuery } from '@tanstack/react-query';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { DataTable, Kpi, KpiGrid, ReportState, money, moveTypeLabel, qty, type Column } from './shared';
import { FilterBar, type useReportFilters } from './filters';

interface TypeRow { type: string; group: string; movements: number; quantity: number; value: number; direction: 'in' | 'out' }
interface TopRow { productId: string; code: string | null; name: string; uom: string | null; value: number; quantity: number | null }
interface AnalysisResponse {
  range: { start: string; end: string };
  summary: { movements: number; valueIn: number; valueOut: number; consumedValue: number; lostValue: number; lossRatePct: number | null };
  byType: TypeRow[];
  trend: { date: string; valueIn: number; valueOut: number; qtyIn: number; qtyOut: number; movements: number }[];
  topConsumed: TopRow[];
  topLost: TopRow[];
  topReceived: TopRow[];
}

function TopList({ title, rows, empty }: { title: string; rows: TopRow[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card className="p-3">
      <div className="mb-2 text-sm font-medium">{title}</div>
      {rows.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">{empty}</div>}
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.productId} className="text-sm">
            <div className="flex justify-between gap-2">
              <span className="truncate" title={r.name}>{r.name}</span>
              <span className="whitespace-nowrap font-mono text-xs tabular-nums">
                {money(r.value)}{r.quantity != null && ` · ${qty(r.quantity)}${r.uom ? ` ${r.uom}` : ''}`}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted">
              <div className="h-full rounded bg-primary/70" style={{ width: `${(r.value / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function AnalysisReport({ ctl }: { ctl: ReturnType<typeof useReportFilters> }) {
  const { filters: f, toQuery } = ctl;
  const qs = toQuery(['start', 'end', 'locationId', 'categoryId', 'productId', 'search', 'moveTypes']);
  const report = useQuery<AnalysisResponse>({
    queryKey: ['inventory-report', 'movement-analysis', qs],
    queryFn: async () => (await api.get(`/inventory/reports/movement-analysis?${qs}`)).data,
  });
  const d = report.data;
  const s = d?.summary;

  const columns: Column<TypeRow>[] = [
    { key: 'type', header: 'Movement type', className: 'font-medium', render: (r) => moveTypeLabel(r.type), sort: (r) => moveTypeLabel(r.type) },
    { key: 'group', header: 'Group', render: (r) => <span className="capitalize text-muted-foreground">{r.group}</span>, sort: (r) => r.group },
    { key: 'direction', header: 'Direction', align: 'center', render: (r) => <span className={r.direction === 'in' ? 'text-emerald-600' : 'text-destructive'}>{r.direction === 'in' ? 'In' : 'Out'}</span>, sort: (r) => r.direction },
    { key: 'movements', header: 'Movements', align: 'right', render: (r) => r.movements.toLocaleString(), sort: (r) => r.movements, footer: s?.movements.toLocaleString() },
    { key: 'quantity', header: 'Net Qty', align: 'right', render: (r) => qty(r.quantity), sort: (r) => r.quantity },
    { key: 'value', header: 'Value', align: 'right', render: (r) => <span className="font-semibold">{money(r.value)}</span>, sort: (r) => r.value },
  ];

  return (
    <div className="space-y-4">
      <FilterBar ctl={ctl} show={['date', 'location', 'category', 'product', 'search', 'moveTypes']} />
      <ReportState query={report}>
        {d && s && (
          <>
            {f.preset === 'all' && (
              <div className="text-xs text-muted-foreground">“All time” is not charted — showing the last 30 days ({d.range.start} → {d.range.end}).</div>
            )}
            <KpiGrid>
              <Kpi label="Value in" value={money(s.valueIn)} tone="good" hint={`${d.range.start} → ${d.range.end}`} />
              <Kpi label="Value out" value={money(s.valueOut)} tone="bad" />
              <Kpi label="Consumed / sold (cost)" value={money(s.consumedValue)} />
              <Kpi label="Waste & loss (cost)" value={money(s.lostValue)} tone={s.lostValue > 0 ? 'warn' : undefined} />
              <Kpi
                label="Loss rate"
                value={s.lossRatePct == null ? '—' : `${s.lossRatePct}%`}
                tone={s.lossRatePct == null ? undefined : s.lossRatePct > 5 ? 'bad' : s.lossRatePct > 2 ? 'warn' : 'good'}
                hint={s.lossRatePct == null ? 'No costed consumption in period' : 'Loss ÷ (consumed + loss), at cost'}
              />
              <Kpi label="Movements" value={s.movements.toLocaleString()} />
            </KpiGrid>

            <Card className="p-3">
              <div className="mb-2 text-sm font-medium">Daily stock flow (value at cost)</div>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.trend} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-muted" />
                    <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} fontSize={11} minTickGap={16} />
                    <YAxis fontSize={11} width={70} tickFormatter={(v: number) => v.toLocaleString(undefined, { notation: 'compact' })} />
                    <Tooltip formatter={(v: number) => money(v)} labelFormatter={(l: string) => l} />
                    <Legend />
                    <Bar dataKey="valueIn" name="In" fill="#10b981" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="valueOut" name="Out" fill="#ef4444" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <TopList title="Top consumed / sold (cost)" rows={d.topConsumed} empty="No consumption in period." />
              <TopList title="Top waste & loss (cost)" rows={d.topLost} empty="No waste or loss recorded." />
              <TopList title="Top received (cost)" rows={d.topReceived} empty="No receipts in period." />
            </div>

            <DataTable
              rows={d.byType}
              columns={columns}
              rowKey={(r) => r.type}
              defaultSort={{ key: 'value', dir: 'desc' }}
              exportName={`inventory-movement-types_${d.range.start}_${d.range.end}`}
              emptyText="No movements in the selected period."
            />
          </>
        )}
      </ReportState>
    </div>
  );
}
