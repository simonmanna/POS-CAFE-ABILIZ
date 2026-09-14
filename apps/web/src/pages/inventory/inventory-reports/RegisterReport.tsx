import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { dateTime } from '@/lib/format';
import { DataTable, Kpi, KpiGrid, ReportState, money, qty, type Column } from './shared';
import { Field, FilterBar, type useReportFilters } from './filters';

export type RegisterKind = 'stock_in' | 'stock_out' | 'damages' | 'adjustments' | 'transfers';

interface Group {
  key: string; lines: number; documents: number; qty: number; value: number; netValue: number; sharePct: number;
  code?: string; name?: string; uom?: string | null; category?: string; avgUnitCost?: number;
}

interface RegisterLine {
  id: string; date: string; ledgerCode: string; docRef: string | null; source: string; sourceLabel: string;
  type: string; typeLabel: string; productId: string; code: string; name: string; category: string; uom: string | null;
  locationId: string; location: string; toLocation: string | null; qty: number; unitCost: number; value: number;
  reason: string; responsible: string | null; approvedBy: string | null; performedBy: string | null; notes: string | null;
}

interface RegisterResponse {
  range: { start: string; end: string; days: number };
  previousRange: { start: string; end: string };
  summary: {
    lines: number; qty: number; value: number; documents: number; items: number; locations: number;
    grossValue: number; avgValuePerDay: number; avgValuePerLine: number;
    previous: { lines: number; qty: number; value: number };
    changePct: { lines: number | null; qty: number | null; value: number | null };
    topItem: { name: string; value: number; sharePct: number } | null;
    paretoItems: number; unassignedLines: number; unapprovedLines: number;
    gainQty?: number; gainValue?: number; lossQty?: number; lossValue?: number;
  };
  trend: { bucket: 'day' | 'week' | 'month'; points: { key: string; lines: number; qty: number; value: number; gain: number; loss: number }[] };
  byProduct: Group[]; byCategory: Group[]; byLocation: Group[]; bySource: Group[]; byReason: Group[];
  byType: Group[]; byStaff: Group[];
  byWeekday: { key: string; lines: number; qty: number; value: number }[];
  byHour: { key: string; lines: number; value: number }[];
  facets: { sources: { value: string; label: string }[]; reasons: string[]; staff: { value: string; label: string }[] };
  rows: RegisterLine[];
  truncated: boolean;
}

const CONFIG: Record<RegisterKind, {
  noun: string; valueLabel: string; tone: 'good' | 'bad' | 'warn'; color: string; locationLabel: string;
  reasonLabel: string; empty: string;
}> = {
  stock_in: { noun: 'Stock in', valueLabel: 'Value received', tone: 'good', color: '#10b981', locationLabel: 'Received into', reasonLabel: 'Movement', empty: 'No stock received in this period.' },
  stock_out: { noun: 'Stock out', valueLabel: 'Value issued', tone: 'bad', color: '#6366f1', locationLabel: 'Issued from', reasonLabel: 'Movement', empty: 'No stock issued in this period.' },
  damages: { noun: 'Damages', valueLabel: 'Value lost', tone: 'bad', color: '#ef4444', locationLabel: 'Location', reasonLabel: 'Damage reason', empty: 'No damages, waste or write-offs recorded in this period.' },
  adjustments: { noun: 'Adjustments', valueLabel: 'Net adjustment value', tone: 'warn', color: '#f59e0b', locationLabel: 'Location', reasonLabel: 'Adjustment reason', empty: 'No stock adjustments in this period.' },
  transfers: { noun: 'Transfers', valueLabel: 'Value transferred', tone: 'good', color: '#0ea5e9', locationLabel: 'Route', reasonLabel: 'Reason', empty: 'No stock transfers in this period.' },
};

const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#0ea5e9', '#a855f7', '#14b8a6', '#f97316', '#64748b', '#84cc16'];

function Change({ pct, invert }: { pct: number | null; invert?: boolean }) {
  if (pct == null) return <span className="text-muted-foreground">new vs previous period</span>;
  if (pct === 0) return <span className="inline-flex items-center gap-0.5 text-muted-foreground"><Minus className="h-3 w-3" />0% vs previous</span>;
  const up = pct > 0;
  const good = invert ? !up : up;
  return (
    <span className={cn('inline-flex items-center gap-0.5', good ? 'text-emerald-600' : 'text-destructive')}>
      {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {Math.abs(pct)}% vs previous
    </span>
  );
}

function ChartCard({ title, children, className, subtitle }: { title: string; subtitle?: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn('p-3', className)}>
      <div className="mb-2">
        <div className="text-sm font-medium">{title}</div>
        {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {children}
    </Card>
  );
}

function Donut({ data, empty }: { data: Group[]; empty: string }) {
  const top = data.slice(0, 7);
  const rest = data.slice(7).reduce((s, g) => s + g.value, 0);
  const slices = [...top.map((g) => ({ name: g.key, value: g.value })), ...(rest > 0 ? [{ name: 'Other', value: rest }] : [])].filter((s) => s.value > 0);
  if (slices.length === 0) {
    // Zero-cost movements still count — fall back to line counts.
    const byLines = data.slice(0, 8).map((g) => ({ name: g.key, value: g.lines }));
    if (byLines.length === 0) return <div className="py-10 text-center text-sm text-muted-foreground">{empty}</div>;
    return <DonutChart slices={byLines} format={(v) => `${v} line(s)`} />;
  }
  return <DonutChart slices={slices} format={(v) => money(v)} />;
}

function DonutChart({ slices, format }: { slices: { name: string; value: number }[]; format: (v: number) => string }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  return (
    <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[160px_1fr]">
      <div className="mx-auto h-40 w-40">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={1} stroke="none">
              {slices.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
            </Pie>
            <Tooltip formatter={(v: number) => format(v)} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="space-y-1 text-xs">
        {slices.map((s, i) => (
          <div key={s.name} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="min-w-0 flex-1 truncate" title={s.name}>{s.name}</span>
            <span className="whitespace-nowrap font-mono tabular-nums">{format(s.value)} · {total ? ((s.value / total) * 100).toFixed(1) : 0}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RankBars({ rows, empty, color }: { rows: Group[]; empty: string; color: string }) {
  const useLines = rows.every((r) => r.value === 0);
  const metric = (g: Group) => (useLines ? g.lines : g.value);
  const max = Math.max(1, ...rows.map(metric));
  if (rows.length === 0) return <div className="py-10 text-center text-sm text-muted-foreground">{empty}</div>;
  return (
    <div className="space-y-2">
      {rows.slice(0, 10).map((g) => (
        <div key={g.key} className="text-sm">
          <div className="flex justify-between gap-2">
            <span className="truncate" title={g.name ?? g.key}>{g.name ?? g.key}</span>
            <span className="whitespace-nowrap font-mono text-xs tabular-nums">
              {useLines ? `${g.lines} line(s)` : money(g.value)} · {qty(g.qty)}{g.uom ? ` ${g.uom}` : ''}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted">
            <div className="h-full rounded" style={{ width: `${(metric(g) / max) * 100}%`, background: color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const BREAKDOWNS = [
  { key: 'byProduct', label: 'Items' },
  { key: 'byCategory', label: 'Categories' },
  { key: 'byLocation', label: 'Locations' },
  { key: 'bySource', label: 'Sources' },
  { key: 'byReason', label: 'Reasons' },
  { key: 'byType', label: 'Movement types' },
  { key: 'byStaff', label: 'Staff' },
] as const;

export function RegisterReport({ kind, ctl }: { kind: RegisterKind; ctl: ReturnType<typeof useReportFilters> }) {
  const navigate = useNavigate();
  const cfg = CONFIG[kind];
  const { filters: f, set, toQuery } = ctl;
  const [breakdown, setBreakdown] = useState<(typeof BREAKDOWNS)[number]['key']>('byProduct');
  const qs = toQuery(['start', 'end', 'locationId', 'categoryId', 'productId', 'search', 'staffId', 'source', 'reason', 'direction']);

  const report = useQuery<RegisterResponse>({
    queryKey: ['inventory-report', 'register', kind, qs],
    queryFn: async () => (await api.get(`/inventory/reports/register/${kind}?${qs}`)).data,
    placeholderData: (prev) => prev,
  });
  const d = report.data;
  const s = d?.summary;
  const isAdj = kind === 'adjustments';
  const isTrf = kind === 'transfers';

  const selectCls = 'h-9 w-full rounded-md border bg-background px-2 text-sm';
  const extra = (
    <>
      <Field label="Source">
        <select className={selectCls} value={f.source} onChange={(e) => set({ source: e.target.value })}>
          <option value="">All sources</option>
          {d?.facets.sources.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      <Field label={cfg.reasonLabel}>
        <select className={selectCls} value={f.reason} onChange={(e) => set({ reason: e.target.value })}>
          <option value="">All</option>
          {d?.facets.reasons.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Field>
      <Field label="Responsible person">
        <select className={selectCls} value={f.staffId} onChange={(e) => set({ staffId: e.target.value })}>
          <option value="">Anyone</option>
          {d?.facets.staff.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      {isAdj && (
        <Field label="Direction">
          <select className={selectCls} value={f.direction} onChange={(e) => set({ direction: e.target.value })}>
            <option value="">Gains & losses</option>
            <option value="gain">Gains only (+)</option>
            <option value="loss">Losses only (−)</option>
          </select>
        </Field>
      )}
    </>
  );

  const breakdownRows: Group[] = d ? d[breakdown] : [];
  const breakdownCols: Column<Group>[] = [
    {
      key: 'key', header: BREAKDOWNS.find((b) => b.key === breakdown)!.label.replace(/s$/, ''), className: 'font-medium',
      render: (g) => <>{g.name ?? g.key}{g.code && <span className="ml-1 font-mono text-xs text-muted-foreground">{g.code}</span>}</>,
      sort: (g) => g.name ?? g.key,
    },
    { key: 'category', header: 'Category', render: (g) => g.category ?? '', sort: (g) => g.category ?? null, hidden: breakdown !== 'byProduct' },
    { key: 'documents', header: 'Documents', align: 'right', render: (g) => g.documents, sort: (g) => g.documents },
    { key: 'lines', header: 'Lines', align: 'right', render: (g) => g.lines, sort: (g) => g.lines },
    { key: 'qty', header: isAdj ? 'Net Qty' : 'Qty', align: 'right', render: (g) => `${qty(g.qty)}${g.uom ? ` ${g.uom}` : ''}`, sort: (g) => g.qty },
    { key: 'avgUnitCost', header: 'Avg Unit Cost', align: 'right', render: (g) => money(g.avgUnitCost), sort: (g) => g.avgUnitCost ?? 0, hidden: breakdown !== 'byProduct' },
    ...(isAdj ? [{ key: 'netValue', header: 'Net Value', align: 'right' as const, render: (g: Group) => <span className={g.netValue < 0 ? 'text-destructive' : 'text-emerald-600'}>{money(g.netValue)}</span>, sort: (g: Group) => g.netValue }] : []),
    { key: 'value', header: isAdj ? 'Gross Value' : 'Value', align: 'right', render: (g) => <span className="font-semibold">{money(g.value)}</span>, sort: (g) => g.value },
    {
      key: 'sharePct', header: 'Share', align: 'right', sort: (g) => g.sharePct,
      render: (g) => (
        <div className="flex items-center justify-end gap-2">
          <div className="hidden h-1.5 w-16 overflow-hidden rounded bg-muted sm:block"><div className="h-full" style={{ width: `${g.sharePct}%`, background: cfg.color }} /></div>
          {g.sharePct}%
        </div>
      ),
    },
  ];

  const lineCols: Column<RegisterLine>[] = useMemo(() => [
    { key: 'date', header: 'Date', render: (l) => <span className="whitespace-nowrap text-xs">{dateTime(l.date)}</span>, sort: (l) => l.date, csv: (l) => dateTime(l.date) },
    { key: 'docRef', header: 'Reference', render: (l) => <span className="whitespace-nowrap font-mono text-xs">{l.docRef && l.docRef.length < 30 ? l.docRef : l.ledgerCode}</span>, sort: (l) => l.docRef ?? l.ledgerCode },
    { key: 'ledgerCode', header: 'Ledger #', render: (l) => l.ledgerCode, sort: (l) => l.ledgerCode, hidden: true },
    { key: 'name', header: 'Item', className: 'whitespace-nowrap font-medium', render: (l) => <>{l.name}{l.code && <span className="ml-1 font-mono text-xs text-muted-foreground">{l.code}</span>}</>, sort: (l) => l.name },
    { key: 'category', header: 'Category', render: (l) => <span className="text-muted-foreground">{l.category}</span>, sort: (l) => l.category },
    { key: 'location', header: isTrf ? 'From' : 'Location', render: (l) => l.location, sort: (l) => l.location },
    ...(isTrf ? [{ key: 'toLocation', header: 'To', render: (l: RegisterLine) => l.toLocation ?? '—', sort: (l: RegisterLine) => l.toLocation }] : []),
    { key: 'sourceLabel', header: 'Source', render: (l) => <span className="whitespace-nowrap text-xs">{l.sourceLabel}</span>, sort: (l) => l.sourceLabel },
    { key: 'reason', header: cfg.reasonLabel, render: (l) => <span className="whitespace-nowrap text-xs">{l.reason}</span>, sort: (l) => l.reason },
    {
      key: 'qty', header: 'Qty', align: 'right', sort: (l) => l.qty,
      render: (l) => <span className={cn(isAdj && (l.qty < 0 ? 'text-destructive' : 'text-emerald-600'))}>{isAdj && l.qty > 0 ? '+' : ''}{qty(l.qty)}{l.uom ? ` ${l.uom}` : ''}</span>,
    },
    { key: 'unitCost', header: 'Unit Cost', align: 'right', render: (l) => money(l.unitCost), sort: (l) => l.unitCost },
    { key: 'value', header: 'Value', align: 'right', render: (l) => <span className={cn('font-semibold', isAdj && l.value < 0 && 'text-destructive')}>{money(l.value)}</span>, sort: (l) => l.value },
    { key: 'responsible', header: 'Responsible', render: (l) => l.responsible ?? <span className="text-muted-foreground">—</span>, sort: (l) => l.responsible },
    { key: 'approvedBy', header: 'Approved By', render: (l) => l.approvedBy ?? <span className="text-muted-foreground">—</span>, sort: (l) => l.approvedBy },
    { key: 'performedBy', header: 'Recorded By', render: (l) => l.performedBy ?? <span className="text-muted-foreground">—</span>, sort: (l) => l.performedBy },
    { key: 'notes', header: 'Notes', render: (l) => <span className="block max-w-[18rem] truncate text-xs text-muted-foreground" title={l.notes ?? ''}>{l.notes ?? ''}</span>, csv: (l) => l.notes },
  ], [isAdj, isTrf, cfg.reasonLabel]);

  const trendData = d?.trend.points.map((p) => ({ ...p, label: d.trend.bucket === 'day' ? p.key.slice(5) : p.key })) ?? [];
  const zeroCost = s ? s.grossValue === 0 && s.lines > 0 : false;

  return (
    <div className="space-y-4">
      <FilterBar ctl={ctl} show={['date', 'location', 'category', 'product', 'search']} extra={extra} />
      <ReportState query={report}>
        {d && s && (
          <>
            <KpiGrid>
              {isAdj ? (
                <>
                  <Kpi label="Net adjustment value" value={money(s.value)} tone={s.value < 0 ? 'bad' : s.value > 0 ? 'good' : undefined} hint={<Change pct={s.changePct.value} />} />
                  <Kpi label="Gains (+)" value={money(s.gainValue)} tone="good" hint={`${qty(s.gainQty)} units`} />
                  <Kpi label="Losses (−)" value={money(s.lossValue)} tone="bad" hint={`${qty(s.lossQty)} units`} />
                </>
              ) : (
                <>
                  <Kpi label={cfg.valueLabel} value={money(s.value)} tone={cfg.tone} hint={<Change pct={s.changePct.value} invert={kind === 'damages'} />} />
                  <Kpi label="Quantity" value={qty(s.qty)} hint={<Change pct={s.changePct.qty} invert={kind === 'damages'} />} />
                  <Kpi label="Daily average" value={money(s.avgValuePerDay)} hint={`over ${d.range.days} day(s)`} />
                </>
              )}
              <Kpi label="Documents / lines" value={`${s.documents} / ${s.lines}`} hint={<Change pct={s.changePct.lines} invert={kind === 'damages'} />} />
              <Kpi label="Items / locations" value={`${s.items} / ${s.locations}`} hint={s.paretoItems ? `${s.paretoItems} item(s) = 80% of value` : undefined} />
              <Kpi
                label="Control gaps"
                value={`${s.unassignedLines} / ${s.unapprovedLines}`}
                tone={s.unassignedLines || s.unapprovedLines ? 'warn' : 'good'}
                hint="No responsible / not approved"
              />
            </KpiGrid>

            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>Period {d.range.start} → {d.range.end}</span>
              <span>Compared with {d.previousRange.start} → {d.previousRange.end}: {money(s.previous.value)} · {s.previous.lines} line(s)</span>
              {s.topItem && <span>Top item: <b className="text-foreground">{s.topItem.name}</b> ({s.topItem.sharePct}% of value)</span>}
              {zeroCost && <span className="text-amber-600">⚠ All lines carry zero cost — value charts fall back to line counts. Check item cost prices.</span>}
            </div>

            <ChartCard title={`${cfg.noun} trend`} subtitle={`${d.trend.bucket === 'day' ? 'Daily' : d.trend.bucket === 'week' ? 'Weekly' : 'Monthly'} value (bars) and line count (line)`}>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={trendData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-muted" />
                    <XAxis dataKey="label" fontSize={11} minTickGap={16} />
                    <YAxis yAxisId="v" fontSize={11} width={64} tickFormatter={(v: number) => v.toLocaleString(undefined, { notation: 'compact' })} />
                    <YAxis yAxisId="l" orientation="right" fontSize={11} width={32} allowDecimals={false} />
                    <Tooltip formatter={(v: number, name: string) => (name === 'Lines' ? v : money(v))} />
                    <Legend />
                    {isAdj ? (
                      <>
                        <Bar yAxisId="v" dataKey="gain" name="Gains" stackId="a" fill="#10b981" />
                        <Bar yAxisId="v" dataKey="loss" name="Losses" stackId="a" fill="#ef4444" radius={[2, 2, 0, 0]} />
                      </>
                    ) : (
                      <Bar yAxisId="v" dataKey="value" name="Value" fill={cfg.color} radius={[2, 2, 0, 0]} />
                    )}
                    <Line yAxisId="l" dataKey="lines" name="Lines" stroke="#64748b" dot={false} strokeWidth={2} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <ChartCard title={isTrf ? 'Top items moved' : `Top items — ${cfg.noun.toLowerCase()}`}>
                <RankBars rows={d.byProduct} empty={cfg.empty} color={cfg.color} />
              </ChartCard>
              <ChartCard title={kind === 'damages' || isAdj ? `By ${cfg.reasonLabel.toLowerCase()}` : 'By source'}>
                <Donut data={kind === 'damages' || isAdj ? d.byReason : d.bySource} empty={cfg.empty} />
              </ChartCard>
              <ChartCard title="By category">
                <Donut data={d.byCategory} empty={cfg.empty} />
              </ChartCard>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <ChartCard title={isTrf ? 'By route' : `By ${cfg.locationLabel.toLowerCase()}`}>
                <RankBars rows={d.byLocation} empty={cfg.empty} color={cfg.color} />
              </ChartCard>
              <ChartCard title="By weekday" subtitle="Lines per day of week">
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={d.byWeekday}>
                      <XAxis dataKey="key" fontSize={11} />
                      <YAxis fontSize={11} width={28} allowDecimals={false} />
                      <Tooltip formatter={(v: number, name: string) => (name === 'value' ? money(v) : v)} />
                      <Bar dataKey="lines" name="Lines" fill={cfg.color} radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </ChartCard>
              <ChartCard title="By hour of day" subtitle="When movements are recorded">
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={d.byHour}>
                      <XAxis dataKey="key" fontSize={10} interval={2} />
                      <YAxis fontSize={11} width={28} allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="lines" name="Lines" fill="#64748b" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </ChartCard>
            </div>

            <Card className="space-y-3 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Breakdown by</span>
                {BREAKDOWNS.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => setBreakdown(b.key)}
                    className={cn('rounded-full border px-3 py-1 text-xs', breakdown === b.key ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}
                  >
                    {b.key === 'byLocation' && isTrf ? 'Routes' : b.label}
                  </button>
                ))}
              </div>
              <DataTable
                key={breakdown}
                rows={breakdownRows}
                columns={breakdownCols}
                rowKey={(g) => g.key}
                defaultSort={{ key: 'value', dir: 'desc' }}
                exportName={`inventory-${kind}-${breakdown}_${d.range.start}_${d.range.end}`}
                emptyText={cfg.empty}
                onRowClick={breakdown === 'byProduct' ? (g) => navigate(`/inventory/items/${g.key}`) : undefined}
              />
            </Card>

            <Card className="space-y-2 p-3">
              <div className="text-sm font-medium">{cfg.noun} register</div>
              <DataTable
                rows={d.rows}
                columns={lineCols}
                rowKey={(l) => l.id}
                defaultSort={{ key: 'date', dir: 'desc' }}
                exportName={`inventory-${kind}-register_${d.range.start}_${d.range.end}`}
                emptyText={cfg.empty}
                onRowClick={(l) => navigate(`/inventory/ledger/${l.id}`)}
                toolbar={
                  <span className="text-xs">
                    Click a line to open the ledger entry.{d.truncated && ' Showing the latest 5,000 lines — narrow the filters for the rest.'}
                  </span>
                }
              />
            </Card>
          </>
        )}
      </ReportState>
    </div>
  );
}
