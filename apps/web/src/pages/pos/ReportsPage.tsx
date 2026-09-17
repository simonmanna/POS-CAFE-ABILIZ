/**
 * POS Reports — shift reports, sales summaries and operational analytics.
 * Manager-gated (`pos:reports`). Navigated to from the terminal Topbar.
 *
 * Two rules hold this page together:
 *
 *  1. ONE filter state for the whole suite. The date range and the filters carry
 *     across tabs, and each tab declares which filters it supports — a control
 *     that appears is a control that reaches the API. Previously each tab kept
 *     its own dates and passed `undefined` for every non-date filter the API
 *     supported, which is why the reports "did not show the filtered ones".
 *  2. Money is summed in whole cents (`sumMoney`), and dates/times are formatted
 *     from the ISO instant in the VIEWER's timezone — never from the
 *     pre-formatted string the API host produced in its own locale.
 */
import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, Clock, TrendingUp, RefreshCw, Printer, CalendarDays, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/stores/auth.store';

import {
  useXReport, useZReport, useSalesByHour, useTopItems, useOpenSession, useSalesSummary,
  useSoldItems, useSalesReport, useOrderReport, useCashierReport, useCashierShiftSummary,
  useWaiterReport, useItemsByGroup, useItemsByServer, useItemSales, useReportFilterOptions,
} from './api';
import type {
  XReport as XReportType, SalesSummaryReport, SoldItem, SalesReportRow, OrderReportRow,
  CashierReportRow, CashierShiftSummaryRow, WaiterReportRow, ItemsByGroupRow, ItemSalesReport,
  ItemsByServerReport, ItemsByServerRow, ReportFilterOptions,
} from './types';
import ReportFilterBar, { emptyFilters, scopedFilters } from './ReportFilterBar';
import type { ReportFilterField, ReportFilterState } from './ReportFilterBar';
import ReportTable from './ReportTable';
import type { ReportColumn } from './ReportTable';
import { sumMoney, fmtDate, fmtTime, humanise } from './report-utils';
import './pos-pro.css';

const orgCur = () => useAuthStore.getState().organization?.currencyCode ?? 'IDR';

/** Money for display. Kept as a function so a currency switch re-reads the org. */
const fmt = (n: number | string | null | undefined) =>
  `${orgCur()} ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Plain 2-dp number for CSV — no currency prefix, no thousands separators. */
const num = (n: number | string | null | undefined) => Number(n || 0).toFixed(2);

type TabId =
  | 'sales' | 'items' | 'item-sales' | 'items-by-group' | 'items-by-server' | 'orders' | 'cashier'
  | 'cashier-summary' | 'waiter' | 'daily' | 'weekly' | 'monthly' | 'hourly'
  | 'top' | 'x' | 'z';

/**
 * Which filters each tab supports. This is the contract: a field listed here is
 * rendered AND sent; anything else is dropped before the request so a leftover
 * selection from another tab cannot silently narrow this one.
 */
const TAB_FIELDS: Record<TabId, readonly ReportFilterField[]> = {
  sales: ['waiter', 'payment', 'orderType', 'search'],
  items: ['category', 'waiter', 'orderType', 'search', 'itemSearch'],
  'item-sales': ['category', 'waiter', 'orderType', 'item', 'itemSearch'],
  'items-by-group': ['category', 'waiter', 'payment', 'orderType'],
  'items-by-server': ['category', 'waiter', 'payment', 'orderType', 'itemSearch'],
  orders: ['waiter', 'orderType', 'orderStatus', 'search', 'includeCancelled'],
  cashier: ['cashier', 'payment', 'orderType', 'search'],
  'cashier-summary': ['cashier', 'register', 'sessionStatus'],
  waiter: ['waiter', 'payment', 'orderType', 'search'],
  daily: ['waiter', 'payment', 'orderType'],
  weekly: ['waiter', 'payment', 'orderType'],
  monthly: ['waiter', 'payment', 'orderType'],
  hourly: ['waiter', 'payment', 'orderType'],
  top: ['category', 'waiter', 'payment', 'orderType'],
  x: [],
  z: [],
};

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'sales', label: 'Sales Report' },
  { id: 'items', label: 'Items Report' },
  { id: 'item-sales', label: 'Item Sales' },
  { id: 'items-by-group', label: 'Items by Group' },
  { id: 'items-by-server', label: 'Item Sales by Server' },
  { id: 'orders', label: 'Order Reports' },
  { id: 'cashier', label: 'Cashier Reports' },
  { id: 'cashier-summary', label: 'Cashier Shift Summary' },
  { id: 'waiter', label: 'Waiter Report' },
  { id: 'daily', label: 'Daily Sales' },
  { id: 'weekly', label: 'Weekly Sales' },
  { id: 'monthly', label: 'Monthly Sales' },
  { id: 'hourly', label: 'Sales by hour' },
  { id: 'top', label: 'Top items' },
  { id: 'x', label: 'X-Report' },
  { id: 'z', label: 'Z-Report' },
];

const ReportsPage: React.FC = () => {
  const permissions = useAuthStore((s) => s.permissions);
  const [tab, setTab] = useState<TabId>('sales');
  const [filters, setFilters] = useState<ReportFilterState>(emptyFilters());
  const [hourFilter, setHourFilter] = useState<string | undefined>();
  /* Item Sales by Server: daily is the shift-lead's view, shift (cash session)
   * is the supervisor's. Local to the tab — it is a grouping, not a filter. */
  const [serverGroupBy, setServerGroupBy] = useState<'day' | 'shift' | 'none'>('day');
  const { data: openSession } = useOpenSession();

  const { fromDate, toDate } = filters;
  const fields = TAB_FIELDS[tab];
  const scoped = useMemo(() => scopedFilters(filters, fields), [filters, fields]);
  const isDateTab = tab !== 'x' && tab !== 'z';

  const { data: options } = useReportFilterOptions(fromDate, toDate, isDateTab);

  // Each query is gated on its tab so a page load fires ONE request, not fifteen.
  const x = useXReport(openSession?.id, tab === 'x');
  const z = useZReport(openSession?.id, tab === 'z');
  const hourly = useSalesByHour(fromDate, toDate, hourFilter, scoped, tab === 'hourly');
  const top = useTopItems(fromDate, toDate, 20, scoped, tab === 'top');
  const sales = useSalesReport(fromDate, toDate, scoped, tab === 'sales');
  const items = useSoldItems(fromDate, toDate, scoped, tab === 'items');
  const itemSales = useItemSales(fromDate, toDate, filters.itemKey, scoped, tab === 'item-sales');
  const itemsByGroup = useItemsByGroup(fromDate, toDate, scoped, tab === 'items-by-group');
  const itemsByServer = useItemsByServer(fromDate, toDate, serverGroupBy, scoped, tab === 'items-by-server');
  const orders = useOrderReport(fromDate, toDate, scoped, Boolean(filters.includeCancelled), tab === 'orders');
  const cashier = useCashierReport(fromDate, toDate, scoped, tab === 'cashier');
  const shifts = useCashierShiftSummary(fromDate, toDate, scoped, tab === 'cashier-summary');
  const waiter = useWaiterReport(fromDate, toDate, scoped, tab === 'waiter');
  const daily = useSalesSummary(fromDate, toDate, 'day', scoped, tab === 'daily');
  const weekly = useSalesSummary(fromDate, toDate, 'week', scoped, tab === 'weekly');
  const monthly = useSalesSummary(fromDate, toDate, 'month', scoped, tab === 'monthly');

  const active: Record<TabId, { data?: any; isLoading: boolean; isFetching: boolean; refetch: () => void; error?: unknown }> = {
    x, z, hourly, top, sales, items, 'item-sales': itemSales, 'items-by-group': itemsByGroup,
    'items-by-server': itemsByServer,
    orders, cashier, 'cashier-summary': shifts, waiter, daily, weekly, monthly,
  } as any;
  const current = active[tab];

  const rowCount = (() => {
    const d = current?.data;
    if (Array.isArray(d)) return d.length;
    if (d && Array.isArray(d.rows)) return d.rows.length;
    if (d && Array.isArray(d.periods)) return d.periods.length;
    return undefined;
  })();

  const denied = !permissions.includes('pos:reports');

  return (
    <div className="pos-reports-shell">
      <div className="pos-reports-header">
        <div>
          <h1 className="text-2xl font-bold flex items-center">
            <BarChart3 className="h-6 w-6" /> POS Reports
          </h1>
        </div>
        <div className="flex gap-2 no-print">
          {(tab === 'x' || tab === 'z') && (
            <Button variant="outline" onClick={() => current.refetch()}>
              <RefreshCw className="h-4 w-4 mr-1" /> Refresh
            </Button>
          )}
          <Button variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4 mr-1" /> Print</Button>
        </div>
      </div>

      {denied ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-rose-700">
          You don't have <code>pos:reports</code> permission. Ask a manager.
        </div>
      ) : (
        <>
          <div className="pos-reports-tabs pos-reports-tabs-wide no-print">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={'pos-reports-tab' + (tab === t.id ? ' active' : '')}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {isDateTab && (
            <div className="mb-4">
              <ReportFilterBar
                state={filters}
                onChange={setFilters}
                fields={fields}
                options={options as ReportFilterOptions | undefined}
                itemOptions={(itemSales.data as ItemSalesReport | undefined)?.filters?.items}
                onRefresh={() => current.refetch()}
                isFetching={current?.isFetching}
                resultCount={rowCount}
              />
            </div>
          )}

          {(current as any)?.error && isDateTab ? (
            <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-700 text-sm">
              {((current as any).error?.response?.data?.message as string) || 'Could not load this report.'}
            </div>
          ) : null}

          {tab === 'x' ? (
            <XReportView report={x.data as any} loading={x.isLoading} error={x.error} kind="X" />
          ) : tab === 'z' ? (
            <XReportView report={z.data as any} loading={z.isLoading} error={z.error} kind="Z" />
          ) : tab === 'daily' ? (
            <SalesSummaryView report={daily.data as SalesSummaryReport | undefined} loading={daily.isLoading} periodLabel="Day" range={filters} />
          ) : tab === 'weekly' ? (
            <SalesSummaryView report={weekly.data as SalesSummaryReport | undefined} loading={weekly.isLoading} periodLabel="Week" range={filters} />
          ) : tab === 'monthly' ? (
            <SalesSummaryView report={monthly.data as SalesSummaryReport | undefined} loading={monthly.isLoading} periodLabel="Month" range={filters} />
          ) : tab === 'hourly' ? (
            <HourlyView data={hourly.data} loading={hourly.isLoading} hFilter={hourFilter} setHFilter={setHourFilter} range={filters} />
          ) : tab === 'sales' ? (
            <SalesReportView rows={(sales.data as SalesReportRow[]) ?? []} loading={sales.isLoading} range={filters} />
          ) : tab === 'cashier' ? (
            <CashierReportView rows={(cashier.data as CashierReportRow[]) ?? []} loading={cashier.isLoading} range={filters} />
          ) : tab === 'cashier-summary' ? (
            <CashierShiftSummaryView rows={(shifts.data as CashierShiftSummaryRow[]) ?? []} loading={shifts.isLoading} range={filters} />
          ) : tab === 'waiter' ? (
            <WaiterReportView rows={(waiter.data as WaiterReportRow[]) ?? []} loading={waiter.isLoading} range={filters} />
          ) : tab === 'items-by-group' ? (
            <ItemsByGroupView rows={(itemsByGroup.data as ItemsByGroupRow[]) ?? []} loading={itemsByGroup.isLoading} range={filters} />
          ) : tab === 'orders' ? (
            <OrderReportView rows={(orders.data as OrderReportRow[]) ?? []} loading={orders.isLoading} range={filters} />
          ) : tab === 'item-sales' ? (
            <ItemSalesView report={itemSales.data as ItemSalesReport | undefined} loading={itemSales.isLoading} range={filters} />
          ) : tab === 'items-by-server' ? (
            <ItemsByServerView
              report={itemsByServer.data as ItemsByServerReport | undefined}
              loading={itemsByServer.isLoading}
              range={filters}
              groupBy={serverGroupBy}
              onGroupBy={setServerGroupBy}
            />
          ) : tab === 'items' ? (
            <ItemsReportView items={(items.data as SoldItem[]) ?? []} loading={items.isLoading} range={filters} />
          ) : (
            <TopItemsView items={(top.data as any) ?? []} loading={top.isLoading} range={filters} />
          )}
        </>
      )}
    </div>
  );
};

/* ============== shared bits ============== */

type Range = { fromDate: string; toDate: string };
const suffix = (r: Range) => `${r.fromDate}-${r.toDate}`;
const heading = (label: string, r: Range) => `${label} — ${r.fromDate} → ${r.toDate}`;

const ReportCard: React.FC<{ title: string; value: string; sub?: string; accent?: boolean }> = ({ title, value, sub, accent }) => (
  <div className="pos-report-card">
    <h3>{title}</h3>
    <div className={'big ' + (accent ? 'text-emerald-600' : '')}>{value}</div>
    {sub ? <p className="text-sm text-slate-500 mt-1">{sub}</p> : null}
  </div>
);

const money = (v: unknown) => <span className="font-mono">{fmt(v as string)}</span>;
const moneyBold = (v: unknown) => <span className="font-mono font-bold">{fmt(v as string)}</span>;

/** Footer cell that totals a money column in whole cents. */
const totalOf = <T,>(pick: (r: T) => string | number | null | undefined) =>
  (rows: T[]) => <span className="font-mono">{fmt(sumMoney(rows, pick))}</span>;

/* ============== X / Z ============== */

const XReportView: React.FC<{ report: XReportType | null; loading: boolean; error: any; kind: 'X' | 'Z' }> = ({ report, loading, error, kind }) => {
  if (loading) return <div className="text-slate-500 p-4">Loading {kind}-report…</div>;
  if (error) {
    const msg = error?.response?.data?.message || error?.message || 'Failed to load report';
    return <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-rose-700">{msg}</div>;
  }
  if (!report || !report.cashSession) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500">
        <Clock className="h-10 w-10 mx-auto mb-2 opacity-50" />
        <p className="font-semibold">No active cash session</p>
        <p className="text-sm mt-1">Open a shift to see live {kind}-report data.</p>
      </div>
    );
  }

  const t = report.totals;
  const maxCategory = Math.max(1, ...report.byCategory.map((c) => Number(c.total)));
  const maxMethod = Math.max(1, ...report.byMethod.map((m) => Number(m.total)));

  return (
    <div className="space-y-4">
      <div className="pos-shift-banner">
        <span>Shift opened {report.cashSession.openedAt ? new Date(report.cashSession.openedAt).toLocaleString() : '—'}</span>
        <span className="font-mono">Opening float: {fmt(report.cashSession.openingFloat)}</span>
      </div>

      <div className="pos-report-grid">
        <ReportCard title="Gross sales" value={fmt(t.grossSales)} sub={`incl. tax · ${t.saleCount} sale${t.saleCount === 1 ? '' : 's'}`} />
        <ReportCard title="Net revenue" value={fmt(t.netRevenueAfterRefunds ?? t.netRevenue)} sub={t.refundedRevenue && Number(t.refundedRevenue) ? `ex-tax · after ${fmt(t.refundedRevenue)} refunded` : 'ex-tax'} />
        <ReportCard title="Discounts" value={fmt(t.discountTotal)} sub="given this shift" />
        <ReportCard title="Cash collected" value={fmt(t.cashCollected)} sub="cash tenders into drawer" />
        <ReportCard title="Expected cash" value={fmt(t.expectedCash)} sub="float + cash − refunds + ins − outs" accent />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="pos-report-card">
          <h3>By payment method <span className="text-sm font-normal text-slate-400">(all tenders, gross)</span></h3>
          {report.byMethod.length === 0 ? (
            <p className="text-sm text-slate-500">No sales yet this shift.</p>
          ) : (
            report.byMethod.map((m) => (
              <div key={m.method} className="pos-report-bar-row">
                <div className="pos-report-bar-label">{humanise(m.method)}</div>
                <div className="pos-report-bar-track">
                  <div className="pos-report-bar-fill" style={{ width: `${(Number(m.total) / maxMethod) * 100}%` }} />
                </div>
                <div className="pos-report-bar-value">{fmt(m.total)} ({m.count})</div>
              </div>
            ))
          )}
        </div>

        <div className="pos-report-card">
          <h3>By category</h3>
          {report.byCategory.length === 0 ? (
            <p className="text-sm text-slate-500">No sales yet this shift.</p>
          ) : (
            report.byCategory.map((c) => (
              <div key={c.categoryId ?? 'uncategorised'} className="pos-report-bar-row">
                <div className="pos-report-bar-label">{c.categoryName}</div>
                <div className="pos-report-bar-track">
                  <div className="pos-report-bar-fill" style={{ width: `${(Number(c.total) / maxCategory) * 100}%` }} />
                </div>
                <div className="pos-report-bar-value">{fmt(c.total)} ({c.count})</div>
              </div>
            ))
          )}
        </div>
      </div>

      <p className="text-sm text-slate-500">As of {new Date(report.asOf).toLocaleString()}</p>
    </div>
  );
};

/* ============== Hourly ============== */

const HourlyView: React.FC<{
  data: any; loading: boolean; range: Range;
  hFilter: string | undefined; setHFilter: (h: string | undefined) => void;
}> = ({ data, loading, range, hFilter, setHFilter }) => {
  const buckets: Array<{ hour: number; count: number; total: string }> = data?.buckets ?? [];
  const selectedHours = hFilter ? new Set(hFilter.split(',').map(Number)) : null;
  const visible = buckets.filter((b) => !selectedHours || selectedHours.has(b.hour));
  const max = Math.max(1, ...visible.map((b) => Number(b.total)));
  const peak = visible.reduce(
    (best, b) => (Number(b.total) > Number(best.total) ? b : best),
    visible[0] ?? { hour: 0, total: '0', count: 0 },
  );
  const total = sumMoney(visible, (b) => b.total);
  const count = visible.reduce((s, b) => s + b.count, 0);

  const toggleHour = (hour: number) => {
    const current = hFilter ? hFilter.split(',').map(Number) : [];
    const idx = current.indexOf(hour);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(hour);
    setHFilter(current.length > 0 && current.length < 24 ? current.join(',') : undefined);
  };

  return (
    <div className="space-y-4">
      <div className="pos-report-grid">
        <ReportCard title="Gross sales" value={fmt(total)} sub={`${count} sale${count === 1 ? '' : 's'}`} accent />
        <ReportCard
          title="Peak hour"
          value={peak && Number(peak.total) > 0 ? `${String(peak.hour).padStart(2, '0')}:00–${String(peak.hour + 1).padStart(2, '0')}:00` : '—'}
          sub={peak && Number(peak.total) > 0 ? `${fmt(peak.total)} · ${peak.count} sale${peak.count === 1 ? '' : 's'}` : 'No sales in range'}
        />
        <ReportCard title="Avg per active hour" value={fmt(visible.filter((b) => b.count > 0).length ? total / visible.filter((b) => b.count > 0).length : 0)} />
      </div>

      <div className="flex flex-wrap gap-1 no-print">
        <Label className="w-full text-sm text-slate-500 mb-1">
          Filter by hour {hFilter ? <button className="underline" onClick={() => setHFilter(undefined)}>(show all)</button> : null}
        </Label>
        {Array.from({ length: 24 }, (_, h) => h).map((h) => {
          const on = !selectedHours || selectedHours.has(h);
          return (
            <button
              key={h}
              className={'pos-reports-tab ' + (on ? 'active' : '')}
              style={{ fontSize: 13, padding: '1px 6px' }}
              onClick={() => toggleHour(h)}
            >
              {String(h).padStart(2, '0')}:00
            </button>
          );
        })}
      </div>

      <ReportTable<{ hour: number; count: number; total: string }>
        title={heading('Hourly sales', range)}
        note={<><TrendingUp className="inline h-3.5 w-3.5 mr-1" />Gross sales incl. tax, bucketed by the hour the sale was rung up.</>}
        rows={visible}
        loading={loading}
        exportName={`sales-by-hour-${suffix(range)}`}
        emptyMessage="No sales in this date range."
        initialSortKey="hour"
        initialSortDir="asc"
        rowKey={(b) => String(b.hour)}
        columns={[
          {
            key: 'hour', header: 'Hour', sort: (b) => b.hour,
            cell: (b) => <span className="font-mono">{String(b.hour).padStart(2, '0')}:00</span>,
            text: (b) => `${String(b.hour).padStart(2, '0')}:00`,
            footer: () => 'Total',
          },
          {
            key: 'bar', header: '', cell: (b) => (
              <div className="pos-report-bar-track" style={{ minWidth: 120 }}>
                <div className="pos-report-bar-fill" style={{ width: `${(Number(b.total) / max) * 100}%` }} />
              </div>
            ),
          },
          {
            key: 'count', header: 'Sales', align: 'right', sort: (b) => b.count,
            cell: (b) => <span className="font-mono">{b.count}</span>, text: (b) => String(b.count),
            footer: (rows) => <span className="font-mono">{rows.reduce((s, b) => s + b.count, 0)}</span>,
          },
          {
            key: 'total', header: 'Total', align: 'right', sort: (b) => Number(b.total),
            cell: (b) => moneyBold(b.total), text: (b) => num(b.total), pdf: (b) => fmt(b.total),
            footer: totalOf((b: { total: string }) => b.total),
          },
          {
            key: 'share', header: '% of range', align: 'right', sort: (b) => Number(b.total),
            cell: (b) => <span className="font-mono">{total > 0 ? `${((Number(b.total) / total) * 100).toFixed(1)}%` : '—'}</span>,
            text: (b) => (total > 0 ? `${((Number(b.total) / total) * 100).toFixed(1)}%` : '—'),
          },
        ]}
      />
    </div>
  );
};

/* ============== Top items ============== */

const TopItemsView: React.FC<{
  items: Array<{ productId: string; name: string; sku: string | null; quantity: number; total: string }>;
  loading: boolean; range: Range;
}> = ({ items, loading, range }) => {
  const total = sumMoney(items, (i) => i.total);
  return (
    <div className="space-y-4">
      <div className="pos-report-grid">
        <ReportCard title="Period total" value={fmt(total)} sub={`${items.length} item${items.length === 1 ? '' : 's'} ranked`} accent />
      </div>
      <ReportTable<typeof items[number]>
        title={heading('Top items', range)}
        note="Ranked by gross line total (incl. tax). Menu items and catalogue products are both counted."
        rows={items}
        loading={loading}
        exportName={`top-items-${suffix(range)}`}
        emptyMessage="No sales in this date range."
        initialSortKey="total"
        rowKey={(it) => it.productId || it.name}
        columns={[
          { key: 'name', header: 'Item', sort: (i) => i.name, cell: (i) => <span className="font-semibold">{i.name}</span>, text: (i) => i.name, footer: () => 'Total' },
          { key: 'sku', header: 'SKU', sort: (i) => i.sku ?? '', cell: (i) => <span className="text-slate-500 font-mono text-sm">{i.sku ?? '—'}</span>, text: (i) => i.sku ?? '—' },
          {
            key: 'qty', header: 'Qty', align: 'right', sort: (i) => i.quantity,
            cell: (i) => <span className="font-mono">{i.quantity}</span>, text: (i) => String(i.quantity),
            footer: (rows) => <span className="font-mono">{rows.reduce((s, i) => s + Number(i.quantity), 0)}</span>,
          },
          {
            key: 'total', header: 'Total', align: 'right', sort: (i) => Number(i.total),
            cell: (i) => moneyBold(i.total), text: (i) => num(i.total), pdf: (i) => fmt(i.total),
            footer: totalOf((i: { total: string }) => i.total),
          },
          {
            key: 'share', header: '% of sales', align: 'right', sort: (i) => Number(i.total),
            cell: (i) => <span className="font-mono">{total > 0 ? `${((Number(i.total) / total) * 100).toFixed(1)}%` : '—'}</span>,
            text: (i) => (total > 0 ? `${((Number(i.total) / total) * 100).toFixed(1)}%` : '—'),
          },
        ]}
      />
    </div>
  );
};

/* ============== Sales Report ============== */

const SalesReportView: React.FC<{ rows: SalesReportRow[]; loading: boolean; range: Range }> = ({ rows, loading, range }) => {
  const navigate = useNavigate();
  const gross = sumMoney(rows, (r) => r.totalAmount);
  const refunded = sumMoney(rows, (r) => r.amountRefunded ?? 0);
  const net = sumMoney(rows, (r) => r.subtotal);

  const columns: Array<ReportColumn<SalesReportRow>> = [
    { key: 'order', header: 'Order #', sort: (r) => r.orderNumber, cell: (r) => <span className="font-mono text-sm">{r.orderNumber}</span>, text: (r) => r.orderNumber, footer: () => `Total (${rows.length})` },
    { key: 'invoice', header: 'Invoice #', sort: (r) => r.invoiceNumber, cell: (r) => <span className="font-mono text-sm">{r.invoiceNumber}</span>, text: (r) => r.invoiceNumber },
    { key: 'date', header: 'Sale Date', sort: (r) => r.saleDate, cell: (r) => <span className="text-sm">{fmtDate(r.saleDate)}</span>, text: (r) => fmtDate(r.saleDate) },
    { key: 'time', header: 'Time', sort: (r) => r.saleDate, cell: (r) => <span className="text-sm">{fmtTime(r.saleDate)}</span>, text: (r) => fmtTime(r.saleDate) },
    { key: 'type', header: 'Type', sort: (r) => r.orderType ?? '', cell: (r) => <span className="text-sm">{humanise(r.orderType)}</span>, text: (r) => humanise(r.orderType) },
    { key: 'tender', header: 'Tender', sort: (r) => r.paymentMethod ?? '', cell: (r) => <span className="text-sm">{humanise(r.paymentMethod)}</span>, text: (r) => humanise(r.paymentMethod) },
    { key: 'subtotal', header: 'Subtotal', align: 'right', sort: (r) => Number(r.subtotal), cell: (r) => money(r.subtotal), text: (r) => num(r.subtotal), pdf: (r) => fmt(r.subtotal), footer: totalOf((r: SalesReportRow) => r.subtotal) },
    { key: 'discount', header: 'Discount', align: 'right', sort: (r) => Number(r.discount), cell: (r) => money(r.discount), text: (r) => num(r.discount), pdf: (r) => fmt(r.discount), footer: totalOf((r: SalesReportRow) => r.discount) },
    { key: 'tax', header: 'Tax', align: 'right', sort: (r) => Number(r.tax ?? 0), cell: (r) => money(r.tax ?? 0), text: (r) => num(r.tax ?? 0), pdf: (r) => fmt(r.tax ?? 0), footer: totalOf((r: SalesReportRow) => r.tax ?? 0) },
    { key: 'total', header: 'Total', align: 'right', sort: (r) => Number(r.totalAmount), cell: (r) => moneyBold(r.totalAmount), text: (r) => num(r.totalAmount), pdf: (r) => fmt(r.totalAmount), footer: totalOf((r: SalesReportRow) => r.totalAmount) },
    {
      // A fully-refunded sale still appears (it happened); this column is what
      // makes the gross figure reconcile against the bank on the same row.
      key: 'refunded', header: 'Refunded', align: 'right', sort: (r) => Number(r.amountRefunded ?? 0),
      cell: (r) => (Number(r.amountRefunded ?? 0) > 0 ? <span className="font-mono text-rose-600">{fmt(r.amountRefunded)}</span> : <span className="text-slate-400">—</span>),
      text: (r) => num(r.amountRefunded ?? 0), pdf: (r) => fmt(r.amountRefunded ?? 0),
      footer: totalOf((r: SalesReportRow) => r.amountRefunded ?? 0),
    },
    { key: 'waiter', header: 'Waiter', sort: (r) => r.waiterName ?? '', cell: (r) => <span className="text-sm">{r.waiterName ?? '—'}</span>, text: (r) => r.waiterName ?? '—' },
    {
      key: 'action', header: '', align: 'center',
      cell: (r) => (
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 no-print" onClick={() => navigate(`/invoices/${r.id}`)} title="Open invoice">
          <Eye className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="pos-report-grid">
        <ReportCard title="Gross sales" value={fmt(gross)} sub={`incl. tax · ${rows.length} sale${rows.length === 1 ? '' : 's'}`} accent />
        <ReportCard title="Net revenue" value={fmt(net)} sub="ex-tax (invoice subtotal)" />
        <ReportCard title="Refunded" value={fmt(refunded)} sub={`net of refunds ${fmt(gross - refunded)}`} />
        <ReportCard title="Avg sale" value={fmt(rows.length ? gross / rows.length : 0)} />
      </div>
      <ReportTable
        title={heading('Sales Report', range)}
        note="One row per POS invoice. Refunded sales stay listed with the amount returned shown separately."
        rows={rows} loading={loading} columns={columns}
        exportName={`sales-report-${suffix(range)}`}
        emptyMessage="No sales in this date range."
        initialSortKey="date" initialSortDir="asc"
        rowKey={(r) => r.id}
      />
    </div>
  );
};

/* ============== Cashier Reports ============== */

const CashierReportView: React.FC<{ rows: CashierReportRow[]; loading: boolean; range: Range }> = ({ rows, loading, range }) => {
  const salesTotal = sumMoney(rows, (r) => r.salesAmount);
  const received = sumMoney(rows, (r) => r.received);
  return (
    <div className="space-y-4">
      <div className="pos-report-grid">
        <ReportCard title="Sales" value={fmt(salesTotal)} sub={`${rows.length} sale${rows.length === 1 ? '' : 's'}`} accent />
        <ReportCard title="Received" value={fmt(received)} sub={received < salesTotal ? `${fmt(salesTotal - received)} outstanding` : 'fully settled'} />
      </div>
      <ReportTable<CashierReportRow>
        title={heading('Cashier Reports', range)}
        note="Per-sale detail for the cashier who rang it up. 'Received' is the amount settled — a credit sale shows less than its total."
        rows={rows} loading={loading}
        exportName={`cashier-report-${suffix(range)}`}
        emptyMessage="No sales in this date range."
        initialSortKey="date"
        rowKey={(r, i) => `${r.invoiceNumber}-${i}`}
        columns={[
          { key: 'cashier', header: 'Cashier', sort: (r) => r.cashierName ?? '', cell: (r) => <span className="text-sm">{r.cashierName ?? '—'}</span>, text: (r) => r.cashierName ?? '—', footer: () => `Total (${rows.length})` },
          { key: 'order', header: 'Order', sort: (r) => r.orderNumber, cell: (r) => <span className="font-mono text-sm">{r.orderNumber}</span>, text: (r) => r.orderNumber },
          { key: 'invoice', header: 'Invoice', sort: (r) => r.invoiceNumber, cell: (r) => <span className="font-mono text-sm">{r.invoiceNumber}</span>, text: (r) => r.invoiceNumber },
          { key: 'date', header: 'Date', sort: (r) => r.saleDate ?? '', cell: (r) => <span className="text-sm">{fmtDate(r.saleDate)}</span>, text: (r) => fmtDate(r.saleDate) },
          { key: 'time', header: 'Time', sort: (r) => r.saleDate ?? '', cell: (r) => <span className="text-sm">{r.saleDate ? fmtTime(r.saleDate) : (r.time ?? '—')}</span>, text: (r) => (r.saleDate ? fmtTime(r.saleDate) : (r.time ?? '—')) },
          { key: 'type', header: 'Type', sort: (r) => r.orderType ?? '', cell: (r) => <span className="text-sm">{humanise(r.orderType)}</span>, text: (r) => humanise(r.orderType) },
          { key: 'method', header: 'Payment Method', sort: (r) => r.paymentMethod ?? '', cell: (r) => <span className="text-sm">{humanise(r.paymentMethod)}</span>, text: (r) => humanise(r.paymentMethod) },
          { key: 'sales', header: 'Sales Amount', align: 'right', sort: (r) => Number(r.salesAmount), cell: (r) => money(r.salesAmount), text: (r) => num(r.salesAmount), pdf: (r) => fmt(r.salesAmount), footer: totalOf((r: CashierReportRow) => r.salesAmount) },
          { key: 'received', header: 'Received', align: 'right', sort: (r) => Number(r.received), cell: (r) => moneyBold(r.received), text: (r) => num(r.received), pdf: (r) => fmt(r.received), footer: totalOf((r: CashierReportRow) => r.received) },
          {
            key: 'refunded', header: 'Refunded', align: 'right', sort: (r) => Number(r.amountRefunded ?? 0),
            cell: (r) => (Number(r.amountRefunded ?? 0) > 0 ? <span className="font-mono text-rose-600">{fmt(r.amountRefunded)}</span> : <span className="text-slate-400">—</span>),
            text: (r) => num(r.amountRefunded ?? 0), pdf: (r) => fmt(r.amountRefunded ?? 0),
            footer: totalOf((r: CashierReportRow) => r.amountRefunded ?? 0),
          },
        ]}
      />
    </div>
  );
};

/* ============== Cashier Shift Summary ============== */

const CashierShiftSummaryView: React.FC<{ rows: CashierShiftSummaryRow[]; loading: boolean; range: Range }> = ({ rows, loading, range }) => {
  const variance = sumMoney(rows, (r) => r.difference ?? 0);
  const counted = rows.filter((r) => r.actualCash != null);
  const short = rows.filter((r) => Number(r.difference ?? 0) < 0).length;
  const over = rows.filter((r) => Number(r.difference ?? 0) > 0).length;

  const diffCell = (v: string | null | undefined) => {
    if (v == null) return <span className="text-slate-400">—</span>;
    const n = Number(v);
    return <span className={'font-mono ' + (n < 0 ? 'text-rose-600' : n > 0 ? 'text-emerald-600' : '')}>{fmt(v)}</span>;
  };

  return (
    <div className="space-y-4">
      <div className="pos-report-grid">
        <ReportCard title="Shifts" value={String(rows.length)} sub={`${counted.length} counted · ${rows.length - counted.length} still open`} />
        <ReportCard title="Total sales" value={fmt(sumMoney(rows, (r) => r.totalSales ?? 0))} sub="all tenders" accent />
        <ReportCard title="Cash into drawer" value={fmt(sumMoney(rows, (r) => r.cashSales ?? r.sales))} sub="cash tenders only" />
        <ReportCard title="Cash variance" value={fmt(variance)} sub={`${short} short · ${over} over`} />
      </div>
      <ReportTable<CashierShiftSummaryRow>
        title={heading('Cashier Shift Summary', range)}
        note="'Cash sales' is what hit the drawer; 'Total sales' is every tender rung up on the shift. Variance compares the counted cash against the expected drawer balance."
        rows={rows} loading={loading}
        exportName={`cashier-shift-summary-${suffix(range)}`}
        emptyMessage="No shifts in this date range."
        initialSortKey="opened"
        rowKey={(r, i) => r.sessionId ?? String(i)}
        columns={[
          { key: 'shift', header: 'Shift', sort: (r) => r.openedAt ?? r.shift, cell: (r) => <span className="text-sm font-mono">{r.shift}</span>, text: (r) => r.shift, footer: () => `Total (${rows.length})` },
          { key: 'opened', header: 'Opened', sort: (r) => r.openedAt ?? '', cell: (r) => <span className="text-sm">{r.openedAt ? `${fmtDate(r.openedAt)} ${fmtTime(r.openedAt)}` : '—'}</span>, text: (r) => (r.openedAt ? `${fmtDate(r.openedAt)} ${fmtTime(r.openedAt)}` : '—') },
          { key: 'closed', header: 'Closed', sort: (r) => r.closedAt ?? '', cell: (r) => <span className="text-sm">{r.closedAt ? `${fmtDate(r.closedAt)} ${fmtTime(r.closedAt)}` : <span className="text-amber-600">open</span>}</span>, text: (r) => (r.closedAt ? `${fmtDate(r.closedAt)} ${fmtTime(r.closedAt)}` : 'open') },
          { key: 'cashier', header: 'Cashier', sort: (r) => r.cashierName ?? '', cell: (r) => <span className="text-sm">{r.cashierName ?? '—'}</span>, text: (r) => r.cashierName ?? '—' },
          { key: 'opening', header: 'Opening Cash', align: 'right', sort: (r) => Number(r.openingCash), cell: (r) => money(r.openingCash), text: (r) => num(r.openingCash), pdf: (r) => fmt(r.openingCash), footer: totalOf((r: CashierShiftSummaryRow) => r.openingCash) },
          { key: 'cashSales', header: 'Cash Sales', align: 'right', sort: (r) => Number(r.cashSales ?? r.sales), cell: (r) => money(r.cashSales ?? r.sales), text: (r) => num(r.cashSales ?? r.sales), pdf: (r) => fmt(r.cashSales ?? r.sales), footer: totalOf((r: CashierShiftSummaryRow) => r.cashSales ?? r.sales) },
          { key: 'totalSales', header: 'Total Sales', align: 'right', sort: (r) => Number(r.totalSales ?? 0), cell: (r) => moneyBold(r.totalSales ?? 0), text: (r) => num(r.totalSales ?? 0), pdf: (r) => fmt(r.totalSales ?? 0), footer: totalOf((r: CashierShiftSummaryRow) => r.totalSales ?? 0) },
          { key: 'expected', header: 'Expected Cash', align: 'right', sort: (r) => Number(r.expectedCash), cell: (r) => money(r.expectedCash), text: (r) => num(r.expectedCash), pdf: (r) => fmt(r.expectedCash), footer: totalOf((r: CashierShiftSummaryRow) => r.expectedCash) },
          {
            key: 'actual', header: 'Actual Cash', align: 'right', sort: (r) => (r.actualCash == null ? null : Number(r.actualCash)),
            cell: (r) => (r.actualCash == null ? <span className="text-slate-400">not counted</span> : money(r.actualCash)),
            text: (r) => (r.actualCash == null ? '—' : num(r.actualCash)), pdf: (r) => (r.actualCash == null ? '—' : fmt(r.actualCash)),
            // Only counted shifts contribute — summing an uncounted shift as 0
            // made the total read like a huge shortage.
            footer: totalOf((r: CashierShiftSummaryRow) => r.actualCash ?? 0),
          },
          {
            key: 'difference', header: 'Difference', align: 'right', sort: (r) => (r.difference == null ? null : Number(r.difference)),
            cell: (r) => diffCell(r.difference), text: (r) => (r.difference == null ? '—' : num(r.difference)), pdf: (r) => (r.difference == null ? '—' : fmt(r.difference)),
            footer: () => diffCell(String(variance)),
          },
        ]}
      />
    </div>
  );
};

/* ============== Waiter Report ============== */

const WaiterReportView: React.FC<{ rows: WaiterReportRow[]; loading: boolean; range: Range }> = ({ rows, loading, range }) => {
  return (
    <div className="space-y-4">
      <ReportTable<WaiterReportRow>
        title={heading('Waiter Report', range)}
        note="One row per sold line, attributed to the waiter on the invoice. Totals include tax and any line discount."
        rows={rows} loading={loading}
        exportName={`waiter-report-${suffix(range)}`}
        emptyMessage="No sales in this date range."
        initialSortKey="date"
        rowKey={(r, i) => `${r.orderNumber}-${r.item}-${i}`}
        columns={[
          { key: 'waiter', header: 'Waiter', sort: (r) => r.waiterName ?? '', cell: (r) => <span className="text-sm">{r.waiterName ?? '—'}</span>, text: (r) => r.waiterName ?? '—', footer: () => `Total (${rows.length})` },
          { key: 'order', header: 'Order #', sort: (r) => r.orderNumber, cell: (r) => <span className="font-mono text-sm">{r.orderNumber}</span>, text: (r) => r.orderNumber },
          { key: 'table', header: 'Table', sort: (r) => r.tableName ?? '', cell: (r) => <span className="text-sm">{r.tableName ?? '—'}</span>, text: (r) => r.tableName ?? '—' },
          { key: 'item', header: 'Item', sort: (r) => r.item, cell: (r) => <span className="font-semibold">{r.item}</span>, text: (r) => r.item },
          {
            key: 'qty', header: 'Qty', align: 'right', sort: (r) => Number(r.quantity),
            cell: (r) => <span className="font-mono">{Number(r.quantity).toFixed(2)}</span>, text: (r) => num(r.quantity),
            footer: (rs) => <span className="font-mono">{sumMoney(rs, (r) => r.quantity).toFixed(2)}</span>,
          },
          { key: 'unit', header: 'Unit Price', align: 'right', sort: (r) => Number(r.unitPrice), cell: (r) => money(r.unitPrice), text: (r) => num(r.unitPrice), pdf: (r) => fmt(r.unitPrice) },
          { key: 'disc', header: 'Discount %', align: 'right', sort: (r) => Number(r.discountPercent), cell: (r) => <span className="font-mono">{Number(r.discountPercent).toFixed(2)}%</span>, text: (r) => `${Number(r.discountPercent).toFixed(2)}%` },
          { key: 'total', header: 'Total', align: 'right', sort: (r) => Number(r.total), cell: (r) => moneyBold(r.total), text: (r) => num(r.total), pdf: (r) => fmt(r.total), footer: totalOf((r: WaiterReportRow) => r.total) },
          { key: 'date', header: 'Date', sort: (r) => r.date, cell: (r) => <span className="text-sm">{fmtDate(r.date)}</span>, text: (r) => fmtDate(r.date) },
          { key: 'time', header: 'Time', sort: (r) => r.date, cell: (r) => <span className="text-sm">{fmtTime(r.date)}</span>, text: (r) => fmtTime(r.date) },
        ]}
      />
    </div>
  );
};

/* ============== Item Sales (grouped by item) ============== */

const ItemSalesView: React.FC<{
  report: ItemSalesReport | undefined; loading: boolean; range: Range;
}> = ({ report, loading, range }) => {
  const rows = report?.rows ?? [];
  const totalAmt = sumMoney(rows, (r) => r.totalAmount);

  return (
    <div className="space-y-4">
      <ReportTable<ItemSalesReport['rows'][number]>
        title={heading('Item Sales', range)}
        note="One row per item across the whole range. Unit price is the effective average (total ÷ qty), so the three money columns always reconcile."
        rows={rows} loading={loading}
        exportName={`item-sales-${suffix(range)}`}
        emptyMessage="No items sold for these filters."
        initialSortKey="total"
        rowKey={(r) => r.itemKey}
        columns={[
          {
            key: 'item', header: 'Item', sort: (r) => r.item,
            cell: (r) => (
              <div>
                <span className="font-semibold">{r.item}</span>
                {/* Two catalogue items can share a name — the category is what
                    keeps those rows tellable apart. */}
                <span className="block text-xs font-normal text-slate-500">{r.categoryName}</span>
              </div>
            ),
            text: (r) => r.item,
            footer: () => `Total (${rows.length})`,
          },
          { key: 'category', header: 'Category', sort: (r) => r.categoryName, cell: (r) => <span className="text-sm text-slate-500">{r.categoryName}</span>, text: (r) => r.categoryName },
          {
            key: 'qty', header: 'Qty Sold', align: 'right', sort: (r) => Number(r.quantity),
            cell: (r) => <span className="font-mono">{Number(r.quantity).toFixed(2)}</span>, text: (r) => num(r.quantity),
            footer: (rs) => <span className="font-mono">{sumMoney(rs, (r) => r.quantity).toFixed(2)}</span>,
          },
          { key: 'unit', header: 'Unit Price', align: 'right', sort: (r) => Number(r.unitPrice), cell: (r) => money(r.unitPrice), text: (r) => num(r.unitPrice), pdf: (r) => fmt(r.unitPrice), footer: () => <span className="text-slate-400">—</span> },
          { key: 'total', header: 'Total Price', align: 'right', sort: (r) => Number(r.totalAmount), cell: (r) => moneyBold(r.totalAmount), text: (r) => num(r.totalAmount), pdf: (r) => fmt(r.totalAmount), footer: totalOf((r: { totalAmount: string }) => r.totalAmount) },
          {
            key: 'share', header: '% of sales', align: 'right', sort: (r) => Number(r.totalAmount),
            cell: (r) => <span className="font-mono">{totalAmt > 0 ? `${((Number(r.totalAmount) / totalAmt) * 100).toFixed(1)}%` : '—'}</span>,
            text: (r) => (totalAmt > 0 ? `${((Number(r.totalAmount) / totalAmt) * 100).toFixed(1)}%` : '—'),
          },
        ]}
      />
    </div>
  );
};

/* ============== Items by Group ============== */

const ItemsByGroupView: React.FC<{ rows: ItemsByGroupRow[]; loading: boolean; range: Range }> = ({ rows, loading, range }) => {
  const grandTotal = sumMoney(rows, (r) => r.totalAmount);
  return (
    <div className="space-y-4">
      <div className="pos-report-grid">
        <ReportCard title="Group revenue" value={fmt(grandTotal)} sub={`${rows.length} group${rows.length === 1 ? '' : 's'}`} accent />
      </div>
      <ReportTable<ItemsByGroupRow>
        title={heading('Items by Group', range)}
        note="Sold lines rolled up by the item's category. Lines whose item has no category land in 'Uncategorised'."
        rows={rows} loading={loading}
        exportName={`items-by-group-${suffix(range)}`}
        emptyMessage="No sales in this date range."
        initialSortKey="total"
        rowKey={(r, i) => r.groupId ?? `uncat-${i}`}
        columns={[
          { key: 'group', header: 'Item Group', sort: (r) => r.groupName, cell: (r) => <span className="font-semibold">{r.groupName}</span>, text: (r) => r.groupName, footer: () => 'Total' },
          {
            key: 'lines', header: 'Lines', align: 'right', sort: (r) => r.itemCount,
            cell: (r) => <span className="font-mono">{r.itemCount}</span>, text: (r) => String(r.itemCount),
            footer: (rs) => <span className="font-mono">{rs.reduce((s, r) => s + r.itemCount, 0)}</span>,
          },
          {
            key: 'qty', header: 'Total Quantity', align: 'right', sort: (r) => Number(r.totalQuantity),
            cell: (r) => <span className="font-mono">{Number(r.totalQuantity).toFixed(2)}</span>, text: (r) => num(r.totalQuantity),
            footer: (rs) => <span className="font-mono">{sumMoney(rs, (r) => r.totalQuantity).toFixed(2)}</span>,
          },
          { key: 'total', header: 'Total Amount', align: 'right', sort: (r) => Number(r.totalAmount), cell: (r) => moneyBold(r.totalAmount), text: (r) => num(r.totalAmount), pdf: (r) => fmt(r.totalAmount), footer: totalOf((r: ItemsByGroupRow) => r.totalAmount) },
          {
            key: 'share', header: '% of sales', align: 'right', sort: (r) => Number(r.totalAmount),
            cell: (r) => <span className="font-mono">{grandTotal > 0 ? `${((Number(r.totalAmount) / grandTotal) * 100).toFixed(1)}%` : '—'}</span>,
            text: (r) => (grandTotal > 0 ? `${((Number(r.totalAmount) / grandTotal) * 100).toFixed(1)}%` : '—'),
          },
        ]}
      />
    </div>
  );
};

/* ============== Order Reports ============== */

const ORDER_STATUS_TONE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  confirmed: 'bg-sky-100 text-sky-700',
  in_progress: 'bg-amber-100 text-amber-700',
  completed: 'bg-emerald-100 text-emerald-700',
  closed: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-rose-100 text-rose-700',
};

const OrderReportView: React.FC<{ rows: OrderReportRow[]; loading: boolean; range: Range }> = ({ rows, loading, range }) => {
  const total = sumMoney(rows, (r) => r.totalAmount);
  const openOrders = rows.filter((r) => r.status === 'draft' || r.status === 'confirmed' || r.status === 'in_progress');
  return (
    <div className="space-y-4">
      <div className="pos-report-grid">
        <ReportCard title="Order value" value={fmt(total)} sub={`${rows.length} order${rows.length === 1 ? '' : 's'}`} accent />
        <ReportCard title="Still open" value={String(openOrders.length)} sub={`${fmt(sumMoney(openOrders, (r) => r.totalAmount))} unbilled`} />
        <ReportCard title="Avg order" value={fmt(rows.length ? total / rows.length : 0)} />
      </div>
      <ReportTable<OrderReportRow>
        title={heading('Order Reports', range)}
        note="Operational orders, including drafts that were never billed — so this total is expected to exceed the Sales Report. Cancelled orders are hidden unless you tick 'Include cancelled'."
        rows={rows} loading={loading}
        exportName={`order-report-${suffix(range)}`}
        emptyMessage="No orders in this date range."
        initialSortKey="date"
        rowKey={(r, i) => `${r.orderNumber}-${i}`}
        columns={[
          { key: 'order', header: 'Order No', sort: (r) => r.orderNumber, cell: (r) => <span className="font-mono text-sm">{r.orderNumber}</span>, text: (r) => r.orderNumber, footer: () => `Total (${rows.length})` },
          { key: 'date', header: 'Date', sort: (r) => r.date, cell: (r) => <span className="text-sm">{fmtDate(r.date)}</span>, text: (r) => fmtDate(r.date) },
          { key: 'time', header: 'Time', sort: (r) => r.date, cell: (r) => <span className="text-sm">{fmtTime(r.date)}</span>, text: (r) => fmtTime(r.date) },
          { key: 'type', header: 'Type', sort: (r) => r.orderType ?? '', cell: (r) => <span className="text-sm">{humanise(r.orderType)}</span>, text: (r) => humanise(r.orderType) },
          { key: 'table', header: 'Table', sort: (r) => r.tableName ?? '', cell: (r) => <span className="text-sm">{r.tableName ?? '—'}</span>, text: (r) => r.tableName ?? '—' },
          { key: 'waiter', header: 'Waiter', sort: (r) => r.waiterName ?? '', cell: (r) => <span className="text-sm">{r.waiterName ?? '—'}</span>, text: (r) => r.waiterName ?? '—' },
          { key: 'customer', header: 'Customer', sort: (r) => r.customerName ?? '', cell: (r) => <span className="text-sm">{r.customerName ?? '—'}</span>, text: (r) => r.customerName ?? '—' },
          {
            key: 'status', header: 'Status', sort: (r) => r.status,
            cell: (r) => (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_TONE[r.status] ?? 'bg-slate-100 text-slate-600'}`}>
                {humanise(r.status)}
              </span>
            ),
            text: (r) => humanise(r.status),
          },
          { key: 'total', header: 'Total', align: 'right', sort: (r) => Number(r.totalAmount), cell: (r) => moneyBold(r.totalAmount), text: (r) => num(r.totalAmount), pdf: (r) => fmt(r.totalAmount), footer: totalOf((r: OrderReportRow) => r.totalAmount) },
        ]}
      />
    </div>
  );
};

/* ============== Items Report ============== */

const ItemsReportView: React.FC<{ items: SoldItem[]; loading: boolean; range: Range }> = ({ items, loading, range }) => {
  return (
    <div className="space-y-4">
      <ReportTable<SoldItem>
        title={heading('Items Report', range)}
        note="Every sold line in the range. Total amount includes tax and the line discount. Served By is who punched the line; Order Waiter is who owns the order — on a busy floor they differ."
        rows={items} loading={loading}
        exportName={`items-report-${suffix(range)}`}
        emptyMessage="No sales in this date range."
        initialSortKey="date"
        rowKey={(it, i) => `${it.invoiceNumber}-${it.item}-${i}`}
        columns={[
          { key: 'order', header: 'Order #', sort: (i) => i.orderNumber, cell: (i) => <span className="font-mono text-sm">{i.orderNumber}</span>, text: (i) => i.orderNumber, footer: () => `Total (${items.length})` },
          { key: 'invoice', header: 'Invoice #', sort: (i) => i.invoiceNumber, cell: (i) => <span className="font-mono text-sm">{i.invoiceNumber}</span>, text: (i) => i.invoiceNumber },
          { key: 'date', header: 'Sale Date', sort: (i) => i.saleDate, cell: (i) => <span className="text-sm">{fmtDate(i.saleDate)}</span>, text: (i) => fmtDate(i.saleDate) },
          { key: 'time', header: 'Time', sort: (i) => i.saleDate, cell: (i) => <span className="text-sm">{fmtTime(i.saleDate)}</span>, text: (i) => fmtTime(i.saleDate) },
          { key: 'item', header: 'Item', sort: (i) => i.item, cell: (i) => <span className="font-semibold">{i.item}</span>, text: (i) => i.item },
          { key: 'category', header: 'Category', sort: (i) => i.categoryName ?? '', cell: (i) => <span className="text-sm text-slate-500">{i.categoryName ?? '—'}</span>, text: (i) => i.categoryName ?? '—' },
          { key: 'unit', header: 'Unit Price', align: 'right', sort: (i) => Number(i.unitPrice), cell: (i) => money(i.unitPrice), text: (i) => num(i.unitPrice), pdf: (i) => fmt(i.unitPrice) },
          { key: 'disc', header: 'Discount %', align: 'right', sort: (i) => Number(i.discountPercent), cell: (i) => <span className="font-mono">{Number(i.discountPercent).toFixed(2)}%</span>, text: (i) => `${Number(i.discountPercent).toFixed(2)}%` },
          {
            key: 'qty', header: 'Qty', align: 'right', sort: (i) => Number(i.quantity),
            cell: (i) => <span className="font-mono">{Number(i.quantity).toFixed(2)}</span>, text: (i) => num(i.quantity),
            footer: (rs) => <span className="font-mono">{sumMoney(rs, (i) => i.quantity).toFixed(2)}</span>,
          },
          { key: 'total', header: 'Total Amount', align: 'right', sort: (i) => Number(i.totalAmount), cell: (i) => moneyBold(i.totalAmount), text: (i) => num(i.totalAmount), pdf: (i) => fmt(i.totalAmount), footer: totalOf((i: SoldItem) => i.totalAmount) },
          { key: 'servedBy', header: 'Served By', sort: (i) => i.servedBy ?? '', cell: (i) => <span className="text-sm font-semibold">{i.servedBy ?? '—'}</span>, text: (i) => i.servedBy ?? '—' },
          { key: 'waiter', header: 'Order Waiter', sort: (i) => i.waiterName ?? '', cell: (i) => <span className="text-sm text-slate-500">{i.waiterName ?? '—'}</span>, text: (i) => i.waiterName ?? '—' },
        ]}
      />
    </div>
  );
};

/* ============== Item Sales by Server ============== */

/**
 * Who sold what, per ITEM.
 *
 * The Waiter Report groups whole ORDERS by the waiter who owns them; on a busy
 * floor a table is rung up by whoever is nearest, so that answer is wrong at the
 * item level. This reads the per-line stamp taken when the item was punched.
 * Lines billed before per-item stamping existed fall back to the order's waiter,
 * so a range spanning that change still totals to the same money.
 */
const ItemsByServerView: React.FC<{
  report?: ItemsByServerReport;
  loading: boolean;
  range: Range;
  groupBy: 'day' | 'shift' | 'none';
  onGroupBy: (g: 'day' | 'shift' | 'none') => void;
}> = ({ report, loading, range, groupBy, onGroupBy }) => {
  const rows = report?.rows ?? [];
  const servers = report?.servers ?? [];
  const GROUPS: Array<{ key: 'day' | 'shift' | 'none'; label: string }> = [
    { key: 'day', label: 'By day' },
    { key: 'shift', label: 'By shift' },
    { key: 'none', label: 'Whole range' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 no-print">
        <Label className="text-xs font-semibold text-slate-500">Group by</Label>
        {GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => onGroupBy(g.key)}
            className={
              'h-8 px-3 rounded-lg text-xs font-semibold border transition-colors ' +
              (groupBy === g.key
                ? 'bg-slate-800 text-white border-slate-800'
                : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400')
            }
          >
            {g.label}
          </button>
        ))}
      </div>

      {servers.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {servers.slice(0, 4).map((sv) => (
            <ReportCard
              key={sv.serverId ?? sv.serverName}
              title={sv.serverName}
              value={fmt(sv.totalAmount)}
              sub={`${Number(sv.quantity).toFixed(2)} items · ${sv.distinctItems} products · ${sv.orderCount} orders`}
            />
          ))}
        </div>
      )}

      <ReportTable<ItemsByServerRow>
        title={heading('Item Sales by Server', range)}
        note="Who punched each item, not who owns the order. Total includes tax and the line discount."
        rows={rows}
        loading={loading}
        exportName={`item-sales-by-server-${groupBy}-${suffix(range)}`}
        emptyMessage="No sales in this date range."
        initialSortKey="period"
        rowKey={(r, i) => `${r.periodKey}-${r.serverId ?? 'x'}-${r.item}-${i}`}
        columns={[
          {
            key: 'period',
            header: groupBy === 'shift' ? 'Shift' : groupBy === 'day' ? 'Day' : 'Range',
            sort: (r) => r.periodKey,
            cell: (r) => <span className="text-sm">{r.periodLabel}</span>,
            text: (r) => r.periodLabel,
            footer: () => `Total (${rows.length})`,
          },
          { key: 'server', header: 'Served By', sort: (r) => r.serverName, cell: (r) => <span className="font-semibold">{r.serverName}</span>, text: (r) => r.serverName },
          { key: 'item', header: 'Item', sort: (r) => r.item, cell: (r) => <span className="text-sm">{r.item}</span>, text: (r) => r.item },
          { key: 'category', header: 'Category', sort: (r) => r.categoryName ?? '', cell: (r) => <span className="text-sm text-slate-500">{r.categoryName ?? '—'}</span>, text: (r) => r.categoryName ?? '—' },
          {
            key: 'qty', header: 'Qty', align: 'right', sort: (r) => Number(r.quantity),
            cell: (r) => <span className="font-mono">{Number(r.quantity).toFixed(2)}</span>, text: (r) => num(r.quantity),
            footer: (rs) => <span className="font-mono">{sumMoney(rs, (r) => r.quantity).toFixed(2)}</span>,
          },
          { key: 'discount', header: 'Discount', align: 'right', sort: (r) => Number(r.discountAmount), cell: (r) => money(r.discountAmount), text: (r) => num(r.discountAmount), pdf: (r) => fmt(r.discountAmount), footer: totalOf((r: ItemsByServerRow) => r.discountAmount) },
          { key: 'total', header: 'Total', align: 'right', sort: (r) => Number(r.totalAmount), cell: (r) => moneyBold(r.totalAmount), text: (r) => num(r.totalAmount), pdf: (r) => fmt(r.totalAmount), footer: totalOf((r: ItemsByServerRow) => r.totalAmount) },
          { key: 'orders', header: 'Orders', align: 'right', sort: (r) => r.orderCount, cell: (r) => <span className="font-mono">{r.orderCount}</span>, text: (r) => String(r.orderCount) },
        ]}
      />
    </div>
  );
};

/* ============== Daily / Weekly / Monthly Sales Summary ============== */

const MethodBar: React.FC<{ byMethod: SalesSummaryReport['byMethod'] }> = ({ byMethod }) => {
  const max = Math.max(1, ...byMethod.map((m) => Number(m.total)));
  return (
    <div className="pos-report-card">
      <h3>By payment method</h3>
      <p className="text-sm text-slate-500 mb-2">
        Money actually allocated to these invoices. A credit sale settled later shows under the tender that eventually paid it.
      </p>
      {byMethod.length === 0 ? (
        <p className="text-sm text-slate-500">No payments allocated in this period.</p>
      ) : (
        byMethod.map((m) => (
          <div key={m.method} className="pos-report-bar-row">
            <div className="pos-report-bar-label">{humanise(m.method)}</div>
            <div className="pos-report-bar-track">
              <div className="pos-report-bar-fill" style={{ width: `${(Number(m.total) / max) * 100}%` }} />
            </div>
            <div className="pos-report-bar-value">{fmt(m.total)} ({m.count})</div>
          </div>
        ))
      )}
    </div>
  );
};

const SalesSummaryView: React.FC<{
  report: SalesSummaryReport | undefined; loading: boolean; periodLabel: 'Day' | 'Week' | 'Month'; range: Range;
}> = ({ report, loading, periodLabel, range }) => {
  if (loading) return <div className="text-slate-500 p-4">Loading {periodLabel.toLowerCase()} sales…</div>;
  if (!report) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500">
        <CalendarDays className="h-10 w-10 mx-auto mb-2 opacity-50" />
        <p className="font-semibold">No data for {range.fromDate} → {range.toDate}</p>
      </div>
    );
  }

  const t = report.totals;
  const periods = report.periods;
  const grandRevenue = sumMoney(periods, (p) => p.revenue);

  return (
    <div className="space-y-4">
      <div className="pos-report-grid">
        <ReportCard title="Net revenue" value={fmt(t.revenue)} sub={`ex-tax · ${t.orders} order${t.orders === 1 ? '' : 's'}`} accent />
        <ReportCard title="Gross sales" value={fmt(t.grossSales)} sub="incl. tax" />
        <ReportCard title="Avg order value" value={fmt(t.avgOrderValue)} />
        <ReportCard title="Discounts" value={fmt(t.discounts)} />
        <ReportCard title="Refunds" value={fmt(t.refunds)} sub={`net sales ${fmt(t.netSales)}`} />
      </div>

      <ReportTable<SalesSummaryReport['periods'][number]>
        title={`${periodLabel} breakdown — ${range.fromDate} → ${range.toDate}`}
        note="Revenue is NET of tax. Periods with no sales are shown as explicit zeros so a quiet day cannot be mistaken for a missing one."
        rows={periods}
        exportName={`${periodLabel.toLowerCase()}-breakdown-${suffix(range)}`}
        exportTitle={`${periodLabel} breakdown — ${range.fromDate} → ${range.toDate}`}
        emptyMessage="No sales in this period."
        initialSortKey="period" initialSortDir="asc"
        rowKey={(p) => p.periodKey}
        columns={[
          { key: 'period', header: periodLabel, sort: (p) => p.periodKey, cell: (p) => <span className="font-semibold">{p.periodKey}</span>, text: (p) => p.periodKey, footer: () => 'Total' },
          {
            key: 'orders', header: 'Orders', align: 'right', sort: (p) => p.orders,
            cell: (p) => <span className="font-mono">{p.orders}</span>, text: (p) => String(p.orders),
            footer: (rs) => <span className="font-mono">{rs.reduce((s, p) => s + p.orders, 0)}</span>,
          },
          { key: 'revenue', header: 'Revenue', align: 'right', sort: (p) => Number(p.revenue), cell: (p) => moneyBold(p.revenue), text: (p) => num(p.revenue), pdf: (p) => fmt(p.revenue), footer: totalOf((p: { revenue: string }) => p.revenue) },
          { key: 'gross', header: 'Gross', align: 'right', sort: (p) => Number(p.grossSales), cell: (p) => money(p.grossSales), text: (p) => num(p.grossSales), pdf: (p) => fmt(p.grossSales), footer: totalOf((p: { grossSales: string }) => p.grossSales) },
          { key: 'avg', header: 'Avg', align: 'right', sort: (p) => Number(p.avgOrderValue), cell: (p) => money(p.avgOrderValue), text: (p) => num(p.avgOrderValue), pdf: (p) => fmt(p.avgOrderValue) },
          { key: 'discounts', header: 'Discounts', align: 'right', sort: (p) => Number(p.discounts), cell: (p) => money(p.discounts), text: (p) => num(p.discounts), pdf: (p) => fmt(p.discounts), footer: totalOf((p: { discounts: string }) => p.discounts) },
          {
            key: 'refunds', header: 'Refunds', align: 'right', sort: (p) => Number(p.refunds),
            cell: (p) => (Number(p.refunds) > 0 ? <span className="font-mono text-rose-600">{fmt(p.refunds)}</span> : <span className="text-slate-400">—</span>),
            text: (p) => num(p.refunds), pdf: (p) => fmt(p.refunds),
            footer: totalOf((p: { refunds: string }) => p.refunds),
          },
          {
            key: 'share', header: '%', align: 'right', sort: (p) => Number(p.revenue),
            cell: (p) => <span className="font-mono">{grandRevenue > 0 ? `${((Number(p.revenue) / grandRevenue) * 100).toFixed(1)}%` : '—'}</span>,
            text: (p) => (grandRevenue > 0 ? `${((Number(p.revenue) / grandRevenue) * 100).toFixed(1)}%` : '—'),
          },
        ]}
      />

      <MethodBar byMethod={report.byMethod} />
    </div>
  );
};

export default ReportsPage;
