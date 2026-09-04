import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight, ArrowDownRight, Receipt, AlertCircle, Wallet, TrendingUp,
  Users, Package, Plus, FileText, HandCoins, ShoppingCart, RefreshCw,
  Coffee, Sparkles, ArrowRight, Activity as ActivityIcon, ChevronRight,
  Utensils, CreditCard, Boxes, Flame, Clock,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from 'recharts';
import { PERMISSIONS } from '@erp/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usePartnerStats } from '@/features/partners/api';
import { useProducts } from '@/features/products/api';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useSalesByHour, useSalesSummary, useTopItems, useItemsByGroup } from '@/pages/pos/api';

/* ──────────────────────────────────────────────────────────────────────────
   Local styles — sheen + entrance, scoped to this page.
   ────────────────────────────────────────────────────────────────────────── */
const styles = `
  .dash-kpi { position: relative; overflow: hidden; }
  .dash-kpi::after {
    content: ''; position: absolute; top: 0; left: -140%; width: 60%; height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent);
    transform: skewX(-18deg); transition: left .7s ease;
  }
  .dash-kpi:hover::after { left: 160%; }
  .dash-in { animation: dash-in .45s cubic-bezier(.2,.8,.2,1) both; }
  @keyframes dash-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  .dash-scroll { scrollbar-width: thin; }
`;

/* ── Date helpers — local-time ISO so "today" means the operator's today ── */
const localIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const c = new Date(d); c.setDate(c.getDate() + n); return c; };

type RangeId = 'today' | '7d' | '30d' | 'mtd';
const RANGES: { id: RangeId; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'mtd', label: 'Month' },
];

function resolveRange(id: RangeId) {
  const today = new Date();
  switch (id) {
    case 'today': return { from: localIso(today), to: localIso(today), days: 1 };
    case '7d': return { from: localIso(addDays(today, -6)), to: localIso(today), days: 7 };
    case '30d': return { from: localIso(addDays(today, -29)), to: localIso(today), days: 30 };
    case 'mtd': {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const days = Math.round((today.getTime() - first.getTime()) / 86_400_000) + 1;
      return { from: localIso(first), to: localIso(today), days };
    }
  }
}

/** Window of the same length immediately before `from` — the delta baseline. */
function previousRange(from: string, days: number) {
  const start = new Date(`${from}T00:00:00`);
  return { from: localIso(addDays(start, -days)), to: localIso(addDays(start, -1)) };
}

const num = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Compact money for KPI tiles — "UGX 1.25M" beats a number that wraps. */
function compactMoney(value: number, currency?: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: currency ? 'currency' : 'decimal',
      currency: currency || undefined,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return formatMoney(value, currency);
  }
}

/** Percent change vs the previous window. null when the baseline is zero. */
function delta(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

const CHART_COLORS = ['#0ea5e9', '#f59e0b', '#8b5cf6', '#10b981', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];

interface KPIData {
  openInvoices: number;
  overdueInvoices: number;
  cashPosition: number;
  revenueMonth: number;
  netIncomeMonth: number;
  arAging: { current: number; b30: number; b60: number; b90: number; over90: number };
}

interface ActivityItem {
  id: string;
  type: string;
  description: string;
  amount?: number;
  at: string;
  href: string;
}

interface ReorderRow {
  productId: string;
  code: string;
  name: string;
  onHand: number;
  par: number;
  belowPar: boolean;
  suggestedOrderQty: number;
}

export function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const org = useAuthStore((s) => s.organization);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const qc = useQueryClient();

  const canPosReports = hasPermission(PERMISSIONS.pos.reports);
  const canInventory = hasPermission(PERMISSIONS.inventory.read);

  const [range, setRange] = useState<RangeId>('today');
  const { from, to, days } = resolveRange(range);
  const prev = useMemo(() => previousRange(from, days), [from, days]);
  const currency = org?.currencyCode;

  /* ── Sales analytics (POS) — gated on pos:reports so a waiter's dashboard
        does not fire five 403s on load. ── */
  const groupBy = days > 45 ? 'week' : 'day';
  const summary = useSalesSummary(from, to, groupBy, {}, canPosReports);
  const prevSummary = useSalesSummary(prev.from, prev.to, groupBy, {}, canPosReports);
  const hourly = useSalesByHour(from, to, undefined, {}, canPosReports && range === 'today');
  const topItems = useTopItems(from, to, 6, {}, canPosReports);
  const byGroup = useItemsByGroup(from, to, {}, canPosReports);

  /* ── Accounting KPIs + activity (always) ── */
  const kpi = useQuery<KPIData>({
    queryKey: ['dashboard-kpi'],
    queryFn: async () => (await api.get<KPIData>('/reports/dashboard-kpi')).data,
    refetchInterval: 60_000,
  });
  const activity = useQuery<ActivityItem[]>({
    queryKey: ['dashboard-activity'],
    queryFn: async () => (await api.get<{ data: ActivityItem[] }>('/reports/dashboard-activity?limit=10')).data.data,
    refetchInterval: 30_000,
  });
  const reorder = useQuery<ReorderRow[]>({
    queryKey: ['dashboard-reorder'],
    queryFn: async () => (await api.get<ReorderRow[]>('/inventory/reports/reorder')).data,
    enabled: canInventory,
    staleTime: 5 * 60_000,
  });

  const partners = usePartnerStats();
  const products = useProducts({ page: 1, pageSize: 1 });

  const totals = summary.data?.totals;
  const prevTotals = prevSummary.data?.totals;

  /* ── Trend series: hour buckets for a single day, periods otherwise ── */
  const series = useMemo(() => {
    if (range === 'today') {
      const buckets: { hour: number; count: number; total: string }[] = hourly.data?.buckets ?? [];
      return buckets.map((b) => ({
        label: `${String(b.hour).padStart(2, '0')}:00`,
        value: num(b.total),
        orders: b.count,
      }));
    }
    const periods: any[] = summary.data?.periods ?? [];
    return periods.map((p) => ({
      label: p.periodKey?.length === 10 ? p.periodKey.slice(5) : p.periodKey,
      value: num(p.grossSales),
      orders: p.orders ?? 0,
    }));
  }, [range, hourly.data, summary.data]);

  const spark = useMemo(() => {
    const periods: any[] = summary.data?.periods ?? [];
    if (periods.length > 1) return periods.map((p) => ({ v: num(p.grossSales), o: p.orders ?? 0 }));
    return series.map((s) => ({ v: s.value, o: s.orders }));
  }, [summary.data, series]);

  const categories = useMemo(() => {
    const rows: any[] = Array.isArray(byGroup.data) ? byGroup.data : [];
    const top = rows.slice(0, 5).map((g) => ({ name: g.groupName || 'Uncategorised', value: num(g.totalAmount) }));
    const rest = rows.slice(5).reduce((s, g) => s + num(g.totalAmount), 0);
    return rest > 0 ? [...top, { name: 'Others', value: rest }] : top;
  }, [byGroup.data]);
  const categoryTotal = categories.reduce((s, c) => s + c.value, 0);

  const lowStock = useMemo(
    () => (reorder.data ?? []).filter((r) => r.belowPar).slice(0, 5),
    [reorder.data],
  );

  const salesLoading = summary.isLoading || (range === 'today' && hourly.isLoading);

  const kpiCards = canPosReports
    ? [
        {
          title: 'Total Sales',
          value: totals ? compactMoney(num(totals.grossSales), currency) : undefined,
          change: totals && prevTotals ? delta(num(totals.grossSales), num(prevTotals.grossSales)) : null,
          icon: Wallet,
          tone: 'from-sky-500 to-blue-600',
          spark: spark.map((s) => s.v),
          href: '/pos/reports',
        },
        {
          title: 'Orders',
          value: totals ? String(totals.orders ?? 0) : undefined,
          change: totals && prevTotals ? delta(num(totals.orders), num(prevTotals.orders)) : null,
          icon: ShoppingCart,
          tone: 'from-emerald-500 to-teal-600',
          spark: spark.map((s) => s.o),
          href: '/pos/reports',
        },
        {
          title: 'Avg Order',
          value: totals ? compactMoney(num(totals.avgOrderValue), currency) : undefined,
          change: totals && prevTotals ? delta(num(totals.avgOrderValue), num(prevTotals.avgOrderValue)) : null,
          icon: Receipt,
          tone: 'from-violet-500 to-purple-600',
          spark: spark.map((s) => s.v),
          href: '/pos/reports',
        },
        {
          title: 'Refunds',
          value: totals ? compactMoney(num(totals.refunds), currency) : undefined,
          change: totals && prevTotals ? delta(num(totals.refunds), num(prevTotals.refunds)) : null,
          invertChange: true,
          icon: ArrowDownRight,
          tone: 'from-amber-500 to-orange-600',
          spark: spark.map((s) => s.v),
          href: '/pos/reports',
        },
        {
          title: 'Cash Position',
          value: kpi.data?.cashPosition != null ? compactMoney(kpi.data.cashPosition, currency) : undefined,
          change: null,
          icon: CreditCard,
          tone: 'from-rose-500 to-pink-600',
          spark: spark.map((s) => s.v),
          href: '/trial-balance',
        },
      ]
    : [
        {
          title: 'Open Invoices',
          value: kpi.data?.openInvoices != null ? String(kpi.data.openInvoices) : undefined,
          change: null, icon: Receipt, tone: 'from-sky-500 to-blue-600', spark: [] as number[], href: '/invoices',
        },
        {
          title: 'Overdue',
          value: kpi.data?.overdueInvoices != null ? String(kpi.data.overdueInvoices) : undefined,
          change: null, icon: AlertCircle, tone: 'from-rose-500 to-red-600', spark: [] as number[], href: '/ar-aging',
        },
        {
          title: 'Cash Position',
          value: kpi.data?.cashPosition != null ? compactMoney(kpi.data.cashPosition, currency) : undefined,
          change: null, icon: Wallet, tone: 'from-cyan-500 to-teal-600', spark: [] as number[], href: '/trial-balance',
        },
        {
          title: 'Revenue (Month)',
          value: kpi.data?.revenueMonth != null ? compactMoney(kpi.data.revenueMonth, currency) : undefined,
          change: null, icon: TrendingUp, tone: 'from-blue-500 to-indigo-600', spark: [] as number[], href: '/trial-balance',
        },
        {
          title: 'Net Income (Month)',
          value: kpi.data?.netIncomeMonth != null ? compactMoney(kpi.data.netIncomeMonth, currency) : undefined,
          change: null,
          icon: kpi.data && kpi.data.netIncomeMonth >= 0 ? ArrowUpRight : ArrowDownRight,
          tone: kpi.data && kpi.data.netIncomeMonth >= 0 ? 'from-emerald-500 to-green-600' : 'from-orange-500 to-rose-600',
          spark: [] as number[], href: '/trial-balance',
        },
      ];

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  })();

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['dashboard-kpi'] });
    qc.invalidateQueries({ queryKey: ['dashboard-activity'] });
    qc.invalidateQueries({ queryKey: ['dashboard-reorder'] });
    qc.invalidateQueries({ queryKey: ['pos-reports'] });
  };
  const refreshing = summary.isFetching || kpi.isFetching || activity.isFetching;

  return (
    <>
      <style>{styles}</style>
      <div className="page-wrap space-y-4">
        {/* ── Hero ── */}
        <div className="page-hero hero-sky dash-in">
          <div className="page-hero-inner">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-md border border-white/30 text-2xl">
                ☕
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-white/80">
                  {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
                </div>
                <div className="text-2xl md:text-3xl font-extrabold tracking-tight">
                  {greeting}, {user?.firstName}
                </div>
                <div className="text-sm text-white/90 mt-0.5">{org?.name}</div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Range switcher */}
              <div className="flex items-center rounded-xl border border-white/30 bg-white/10 p-1 backdrop-blur-md">
                {RANGES.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setRange(r.id)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
                      range === r.id ? 'bg-white text-sky-700 shadow' : 'text-white/85 hover:bg-white/15'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <Button
                variant="outline"
                onClick={refreshAll}
                className="border-white/40 bg-white/10 text-white hover:bg-white/20"
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
              </Button>
              <Button asChild className="bg-white text-sky-700 hover:bg-white/90 shadow-lg">
                <Link to="/pos/terminal">
                  <Coffee className="mr-2 h-4 w-4" /> Terminal
                </Link>
              </Button>
              <Button asChild variant="outline" className="border-white/40 bg-white/10 text-white hover:bg-white/20">
                <Link to="/tables">
                  <Utensils className="mr-2 h-4 w-4" /> Tables
                </Link>
              </Button>
            </div>
          </div>
        </div>

        {/* ── KPI strip ── */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {kpiCards.map((card, i) => (
            <KpiCard
              key={card.title}
              {...card}
              loading={canPosReports ? salesLoading : kpi.isLoading}
              index={i}
            />
          ))}
        </div>

        {/* ── Trend + category mix ── */}
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="box-sky lg:col-span-2 dash-in" style={{ animationDelay: '80ms' }}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-sky-600" /> Sales Overview
                </CardTitle>
                <CardDescription>
                  {range === 'today' ? 'Gross sales by hour' : `Gross sales by ${groupBy}`}
                </CardDescription>
              </div>
              {totals && (
                <div className="text-right">
                  <div className="text-xl font-extrabold tabular-nums">{formatMoney(num(totals.grossSales), currency)}</div>
                  <div className="text-[11px] font-semibold text-muted-foreground">{totals.orders ?? 0} orders</div>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {!canPosReports ? (
                <NoAccess label="Sales analytics require the pos:reports permission." />
              ) : salesLoading ? (
                <Skeleton className="h-64 w-full shimmer" />
              ) : series.every((s) => s.value === 0) ? (
                <EmptyState icon={TrendingUp} label="No sales in this period yet." />
              ) : (
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="dashSales" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.45} />
                          <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={16} />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={56}
                        tickFormatter={(v: number) => compactMoney(v)}
                      />
                      <RTooltip
                        formatter={(v: any, key: any) =>
                          key === 'value' ? [formatMoney(Number(v), currency), 'Sales'] : [v, 'Orders']
                        }
                        contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', fontSize: 12 }}
                      />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke="#0ea5e9"
                        strokeWidth={2.5}
                        fill="url(#dashSales)"
                        dot={false}
                        activeDot={{ r: 5 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="box-sky dash-in" style={{ animationDelay: '120ms' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Boxes className="h-4 w-4 text-violet-600" /> Sales by Category
              </CardTitle>
              <CardDescription>Share of gross sales</CardDescription>
            </CardHeader>
            <CardContent>
              {!canPosReports ? (
                <NoAccess label="Requires the pos:reports permission." />
              ) : byGroup.isLoading ? (
                <Skeleton className="h-64 w-full shimmer" />
              ) : categories.length === 0 ? (
                <EmptyState icon={Boxes} label="No category sales yet." />
              ) : (
                <>
                  <div className="relative h-44 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={categories}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={54}
                          outerRadius={80}
                          paddingAngle={2}
                          stroke="none"
                        >
                          {categories.map((_, i) => (
                            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                          ))}
                        </Pie>
                        <RTooltip
                          formatter={(v: any, n: any) => [formatMoney(Number(v), currency), n]}
                          contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', fontSize: 12 }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Total</div>
                      <div className="text-base font-extrabold tabular-nums">{compactMoney(categoryTotal, currency)}</div>
                    </div>
                  </div>
                  <ul className="mt-3 space-y-1.5">
                    {categories.map((c, i) => (
                      <li key={c.name} className="flex items-center gap-2 text-sm">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
                        />
                        <span className="flex-1 truncate">{c.name}</span>
                        <span className="text-xs font-bold text-muted-foreground tabular-nums">
                          {categoryTotal ? Math.round((c.value / categoryTotal) * 100) : 0}%
                        </span>
                        <span className="w-24 shrink-0 text-right text-xs font-semibold tabular-nums">
                          {compactMoney(c.value, currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Top items + activity + stock alerts ── */}
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="box-sky dash-in" style={{ animationDelay: '160ms' }}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Flame className="h-4 w-4 text-orange-500" /> Top Selling Items
                </CardTitle>
                <CardDescription>Best sellers this period</CardDescription>
              </div>
              <Link to="/pos/reports" className="text-xs font-bold text-sky-600 hover:underline">View all</Link>
            </CardHeader>
            <CardContent>
              {!canPosReports ? (
                <NoAccess label="Requires the pos:reports permission." />
              ) : topItems.isLoading ? (
                <Skeleton className="h-48 w-full shimmer" />
              ) : !Array.isArray(topItems.data) || topItems.data.length === 0 ? (
                <EmptyState icon={Flame} label="No items sold yet." />
              ) : (
                <ol className="space-y-2.5">
                  {(topItems.data as any[]).map((it, i, arr) => {
                    const max = num(arr[0]?.total) || 1;
                    const pct = Math.max(4, Math.round((num(it.total) / max) * 100));
                    return (
                      <li key={it.productId} className="flex items-center gap-3">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-sky-100 text-[11px] font-extrabold text-sky-700">
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm font-semibold">{it.name}</span>
                            <span className="shrink-0 text-xs font-bold tabular-nums">
                              {formatMoney(num(it.total), currency)}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-sky-500 to-cyan-400 transition-all duration-700"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                              {num(it.quantity)} sold
                            </span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>

          <Card className="box-sky dash-in" style={{ animationDelay: '200ms' }}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <ActivityIcon className="h-4 w-4 text-sky-600" /> Recent Activity
                </CardTitle>
                <CardDescription>Latest events in your org</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {activity.isLoading && <Skeleton className="h-48 w-full shimmer" />}
              {activity.data && activity.data.length === 0 && (
                <EmptyState icon={ActivityIcon} label="No activity yet." />
              )}
              {activity.data && activity.data.length > 0 && (
                <ul className="dash-scroll max-h-72 space-y-1 overflow-y-auto pr-1 text-sm">
                  {activity.data.map((a) => (
                    <li key={a.id} className="flex items-start gap-2 rounded-lg p-2 -mx-2 transition-colors hover:bg-sky-50">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-100 text-sky-700">
                        <FileText className="h-3.5 w-3.5" />
                      </div>
                      <Link to={a.href} className="min-w-0 flex-1 truncate hover:underline">
                        {a.description}
                        <span className="block text-[11px] text-muted-foreground">
                          {new Date(a.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </Link>
                      {a.amount != null && (
                        <span className="shrink-0 text-xs font-bold tabular-nums text-foreground">
                          {formatMoney(a.amount, currency)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="box-sky dash-in" style={{ animationDelay: '240ms' }}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-rose-500" /> Inventory Alerts
                </CardTitle>
                <CardDescription>Items at or below par</CardDescription>
              </div>
              {canInventory && (
                <Link to="/inventory" className="text-xs font-bold text-sky-600 hover:underline">View all</Link>
              )}
            </CardHeader>
            <CardContent>
              {!canInventory ? (
                <NoAccess label="Requires the inventory:read permission." />
              ) : reorder.isLoading ? (
                <Skeleton className="h-48 w-full shimmer" />
              ) : lowStock.length === 0 ? (
                <EmptyState icon={Package} label="All items above par." />
              ) : (
                <ul className="space-y-2">
                  {lowStock.map((r) => (
                    <li key={r.productId} className="flex items-center gap-3 rounded-lg border border-border/60 p-2">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-50 text-rose-600">
                        <Package className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">{r.name}</div>
                        <div className="text-[11px] text-muted-foreground tabular-nums">
                          {r.onHand} on hand · par {r.par}
                        </div>
                      </div>
                      <span className="pill shrink-0 bg-rose-100 text-rose-700">Low stock</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── AR aging + quick actions ── */}
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="box-sky lg:col-span-2 dash-in" style={{ animationDelay: '280ms' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-500" /> AR Aging Snapshot
              </CardTitle>
              <CardDescription>Open receivables by age</CardDescription>
            </CardHeader>
            <CardContent>
              {kpi.data ? (
                <div className="space-y-2 text-sm">
                  {[
                    ['Current', kpi.data.arAging.current, 'bg-sky-500'],
                    ['1–30', kpi.data.arAging.b30, 'bg-cyan-500'],
                    ['31–60', kpi.data.arAging.b60, 'bg-amber-500'],
                    ['61–90', kpi.data.arAging.b90, 'bg-orange-500'],
                    ['90+', kpi.data.arAging.over90, 'bg-red-600'],
                  ].map(([label, value, color]) => (
                    <AgingBar
                      key={label as string}
                      label={label as string}
                      value={value as number}
                      color={color as string}
                      currency={currency}
                    />
                  ))}
                </div>
              ) : (
                <Skeleton className="h-24 w-full shimmer" />
              )}
            </CardContent>
          </Card>

          <Card className="box-sky dash-in" style={{ animationDelay: '320ms' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-sky-600" /> Quick Actions
              </CardTitle>
              <CardDescription>Common tasks</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2">
              <Button asChild variant="outline" className="h-11 justify-start lift-on-hover">
                <Link to="/invoices/new"><Plus className="mr-2 h-4 w-4 text-sky-600" />New Invoice</Link>
              </Button>
              <Button asChild variant="outline" className="h-11 justify-start lift-on-hover">
                <Link to="/payments"><HandCoins className="mr-2 h-4 w-4 text-teal-600" />Record Payment</Link>
              </Button>
              <Button asChild variant="outline" className="h-11 justify-start lift-on-hover">
                <Link to="/products"><Package className="mr-2 h-4 w-4 text-cyan-600" />Add Product</Link>
              </Button>
              <Button asChild variant="outline" className="h-11 justify-start lift-on-hover">
                <Link to="/partners"><Users className="mr-2 h-4 w-4 text-blue-600" />Add Partner</Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* ── Master data counts ── */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SmallStat label="Partners" value={partners.data?.total} href="/partners" icon={Users} tone="from-sky-500 to-cyan-500" />
          <SmallStat label="Products" value={products.data?.meta.total} href="/products" icon={Package} tone="from-cyan-500 to-teal-500" />
          <SmallStat label="Open Invoices" value={kpi.data?.openInvoices} href="/invoices" icon={Receipt} tone="from-blue-500 to-sky-500" />
          <SmallStat label="Overdue" value={kpi.data?.overdueInvoices} href="/ar-aging" icon={AlertCircle} tone="from-rose-500 to-red-500" />
        </div>

        {/* ── Status bar ── */}
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border/60 bg-card px-4 py-3 text-sm shadow-sm">
          <span className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-sky-600" />
            <span className="text-muted-foreground">Business date</span>
            <strong>{new Date().toLocaleDateString()}</strong>
          </span>
          <span className="hidden h-4 w-px bg-border sm:block" />
          <span className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${kpi.isError ? 'bg-rose-500' : 'bg-emerald-500 animate-pulse'}`} />
            <span className="text-muted-foreground">API</span>
            <strong>{kpi.isError ? 'Unreachable' : 'Online'}</strong>
          </span>
          <span className="hidden h-4 w-px bg-border sm:block" />
          <span className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-sky-600" />
            <span className="text-muted-foreground">Updated</span>
            <strong>
              {kpi.dataUpdatedAt
                ? new Date(kpi.dataUpdatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                : '—'}
            </strong>
          </span>
          <Button asChild size="sm" className="ml-auto">
            <Link to="/pos/reports"><ArrowRight className="mr-2 h-4 w-4" />Full reports</Link>
          </Button>
        </div>
      </div>
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function KpiCard({
  title, value, change, invertChange, icon: Icon, tone, spark, href, loading, index,
}: {
  title: string;
  value?: string;
  change: number | null;
  invertChange?: boolean;
  icon: typeof Users;
  tone: string;
  spark: number[];
  href: string;
  loading: boolean;
  index: number;
}) {
  const gradientId = `spark-${title.replace(/\W/g, '')}`;
  const good = change == null ? null : invertChange ? change <= 0 : change >= 0;
  return (
    <Link to={href} className="dash-in block" style={{ animationDelay: `${index * 40}ms` }}>
      <div className={`dash-kpi rounded-2xl bg-gradient-to-br ${tone} p-4 text-white shadow-[0_10px_30px_-12px_rgba(2,132,199,0.55)] transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_20px_44px_-12px_rgba(2,132,199,0.65)]`}>
        <div className="relative z-10 flex items-start justify-between">
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/85">{title}</div>
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/20 backdrop-blur-md">
            <Icon className="h-4 w-4" />
          </div>
        </div>
        <div className="relative z-10 mt-2 text-2xl font-extrabold tracking-tight tabular-nums">
          {loading ? <Skeleton className="h-7 w-24 bg-white/30" /> : value ?? '—'}
        </div>
        <div className="relative z-10 mt-1 h-4">
          {change != null && (
            <span className={`inline-flex items-center gap-1 text-[11px] font-bold ${good ? 'text-emerald-100' : 'text-rose-100'}`}>
              {good ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
              {Math.abs(change).toFixed(1)}% vs previous
            </span>
          )}
        </div>
        {spark.length > 1 && (
          <div className="relative z-10 mt-2 h-10 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={spark.map((v, i) => ({ i, v }))} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#fff" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#fff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke="#fff"
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </Link>
  );
}

function AgingBar({ label, value, color, currency }: { label: string; value: number; color: string; currency?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs font-semibold text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="w-24 shrink-0 text-right text-xs font-semibold tabular-nums">{formatMoney(value, currency)}</span>
    </div>
  );
}

function SmallStat({ label, value, href, icon: Icon, tone }: { label: string; value?: number; href: string; icon: typeof Users; tone: string }) {
  return (
    <Link to={href} className="group">
      <div className="info-box h-full">
        <div className={`info-box-icon bg-gradient-to-br ${tone}`}>
          <Icon className="h-6 w-6 transition-transform group-hover:scale-110" />
        </div>
        <div className="info-box-content flex items-center">
          <div className="flex-1">
            <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
            <div className="text-xl font-extrabold">{value ?? '—'}</div>
          </div>
          <ChevronRight className="h-4 w-4 text-sky-500 opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      </div>
    </Link>
  );
}

function EmptyState({ icon: Icon, label }: { icon: typeof Users; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
      <Icon className="h-8 w-8 opacity-40" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

function NoAccess({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
      <AlertCircle className="h-7 w-7 opacity-40" />
      <p className="text-center text-xs">{label}</p>
    </div>
  );
}
