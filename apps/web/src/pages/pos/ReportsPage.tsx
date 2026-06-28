/**
 * Reports page — shift reports + daily/weekly/monthly sales + analytics.
 * Manager-gated (`pos:reports`). Navigated to from the terminal Topbar.
 */
import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, Clock, TrendingUp, RefreshCw, Printer, ArrowLeft, CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/stores/auth.store';
import { useXReport, useZReport, useSalesByHour, useTopItems, useOpenSession, useSalesSummary } from './api';
import type { XReport as XReportType, SalesSummaryReport } from './types';
import './pos-pro.css';

const fmt = (n: number | string | null | undefined) =>
  `UGX ${Number(n || 0).toLocaleString()}`;

const todayIso = () => new Date().toISOString().slice(0, 10);

/** First day (Monday) of the ISO week containing the given ISO date string. */
function weekStartFromDay(isoDate: string): string {
  const d = new Date(isoDate + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return isoDate;
  const dow = d.getDay();
  const diff = d.getDate() - dow + (dow === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().slice(0, 10);
}

/** Last day (Sunday) of the ISO week containing the given ISO date string. */
function weekEndFromDay(isoDate: string): string {
  const start = weekStartFromDay(isoDate);
  const d = new Date(start + 'T12:00:00');
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD for the first of a YYYY-MM month string. */
function monthStart(ym: string): string {
  return ym + '-01';
}

/** YYYY-MM-DD for the last day of a YYYY-MM month. */
function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0);
  return last.toISOString().slice(0, 10);
}

const ReportsPage: React.FC = () => {
  const navigate = useNavigate();
  const permissions = useAuthStore((s) => s.permissions);
  const [tab, setTab] = useState<'x' | 'z' | 'daily' | 'weekly' | 'monthly' | 'hourly' | 'top'>('x');
  const [date, setDate] = useState(todayIso());
  const [fromDate, setFromDate] = useState(todayIso());
  const [toDate, setToDate] = useState(todayIso());
  const { data: openSession } = useOpenSession();

  const { data: x, isLoading: xLoading, refetch: xRefetch, error: xError } = useXReport(openSession?.id);
  const { data: z, isLoading: zLoading, refetch: zRefetch, error: zError } = useZReport(openSession?.id);
  const { data: hourly, isLoading: hLoading } = useSalesByHour(date);
  const { data: topItems, isLoading: tLoading } = useTopItems(fromDate, toDate, 20);

  // Daily / weekly / monthly sales summary
  const [dailyDate, setDailyDate] = useState(todayIso());
  const { data: daily, isLoading: dailyLoading } = useSalesSummary(dailyDate, dailyDate, 'day');

  const [weekDate, setWeekDate] = useState(todayIso());
  const weekStart = useMemo(() => weekStartFromDay(weekDate), [weekDate]);
  const weekEnd = useMemo(() => weekEndFromDay(weekDate), [weekDate]);
  const { data: weekly, isLoading: weeklyLoading } = useSalesSummary(weekStart, weekEnd, 'day');

  const todayYM = useMemo(() => todayIso().slice(0, 7), []);
  const [monthStr, setMonthStr] = useState(todayYM);
  const mStart = useMemo(() => monthStart(monthStr), [monthStr]);
  const mEnd = useMemo(() => monthEnd(monthStr), [monthStr]);
  const { data: monthly, isLoading: monthlyLoading } = useSalesSummary(mStart, mEnd, 'day');

  const denied = !permissions.includes('pos:reports');

  return (
    <div className="pos-reports-shell">
      <div className="pos-reports-header">
        <div>
          <Button variant="outline" size="sm" onClick={() => navigate('/pos/terminal')}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to terminal
          </Button>
          <h1 className="text-2xl font-bold mt-2 flex items-center gap-2">
            <BarChart3 className="h-6 w-6" /> POS Reports
          </h1>
          <p className="text-sm text-slate-600">Live X-report, frozen Z-report, hourly buckets, and top-selling items.</p>
        </div>
        <div className="flex gap-2">
          {tab === 'x' ? (
            <Button variant="outline" onClick={() => xRefetch()}><RefreshCw className="h-4 w-4 mr-1" /> Refresh</Button>
          ) : tab === 'z' ? (
            <Button variant="outline" onClick={() => zRefetch()}><RefreshCw className="h-4 w-4 mr-1" /> Refresh</Button>
          ) : null}
          <Button variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4 mr-1" /> Print</Button>
        </div>
      </div>

      {denied ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-rose-700">
          You don't have <code>pos:reports</code> permission. Ask a manager.
        </div>
      ) : (
        <>
          <div className="pos-reports-tabs pos-reports-tabs-wide">
            <button className={'pos-reports-tab' + (tab === 'x' ? ' active' : '')} onClick={() => setTab('x')}>
              X-Report
            </button>
            <button className={'pos-reports-tab' + (tab === 'z' ? ' active' : '')} onClick={() => setTab('z')}>
              Z-Report
            </button>
            <button className={'pos-reports-tab' + (tab === 'daily' ? ' active' : '')} onClick={() => setTab('daily')}>
              Daily Sales
            </button>
            <button className={'pos-reports-tab' + (tab === 'weekly' ? ' active' : '')} onClick={() => setTab('weekly')}>
              Weekly Sales
            </button>
            <button className={'pos-reports-tab' + (tab === 'monthly' ? ' active' : '')} onClick={() => setTab('monthly')}>
              Monthly Sales
            </button>
            <button className={'pos-reports-tab' + (tab === 'hourly' ? ' active' : '')} onClick={() => setTab('hourly')}>
              Sales by hour
            </button>
            <button className={'pos-reports-tab' + (tab === 'top' ? ' active' : '')} onClick={() => setTab('top')}>
              Top items
            </button>
          </div>

          {tab === 'x' ? (
            <XReportView report={x as any} loading={xLoading} error={xError as any} kind="X" />
          ) : tab === 'z' ? (
            <XReportView report={z as any} loading={zLoading} error={zError as any} kind="Z" />
          ) : tab === 'daily' ? (
            <DailySalesView
              date={dailyDate} setDate={setDailyDate}
              report={daily as SalesSummaryReport | undefined}
              loading={dailyLoading}
            />
          ) : tab === 'weekly' ? (
            <WeeklySalesView
              date={weekDate} setDate={setWeekDate}
              weekStart={weekStart} weekEnd={weekEnd}
              report={weekly as SalesSummaryReport | undefined}
              loading={weeklyLoading}
            />
          ) : tab === 'monthly' ? (
            <MonthlySalesView
              monthStr={monthStr} setMonthStr={setMonthStr}
              report={monthly as SalesSummaryReport | undefined}
              loading={monthlyLoading}
            />
          ) : tab === 'hourly' ? (
            <HourlyView date={date} setDate={setDate} buckets={(hourly as any)?.buckets ?? []} loading={hLoading} />
          ) : (
            <TopItemsView
              fromDate={fromDate} setFromDate={setFromDate}
              toDate={toDate} setToDate={setToDate}
              items={(topItems as any) ?? []} loading={tLoading}
            />
          )}
        </>
      )}
    </div>
  );
};

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
        <p className="text-xs mt-1">Open a shift to see live {kind}-report data.</p>
      </div>
    );
  }

  const t = report.totals;
  const maxCategory = Math.max(1, ...report.byCategory.map((c) => Number(c.total)));
  const maxMethod = Math.max(1, ...report.byMethod.map((m) => Number(m.total)));

  return (
    <div className="space-y-4">
      <div className="pos-shift-banner">
        <span>
          Shift opened {report.cashSession.openedAt ? new Date(report.cashSession.openedAt).toLocaleString() : '—'}
        </span>
        <span className="font-mono">Opening float: {fmt(report.cashSession.openingFloat)}</span>
      </div>

      <div className="pos-report-grid">
        <ReportCard title="Net revenue" value={fmt(t.netRevenue)} sub={`ex-tax · ${t.saleCount} sale${t.saleCount === 1 ? '' : 's'}`} accent />
        <ReportCard title="Gross sales" value={fmt(t.grossSales)} sub={`incl. tax · all tenders`} />
        <ReportCard title="Tax" value={fmt(t.taxTotal)} sub="output tax collected" />
        <ReportCard title="Discounts" value={fmt(t.discountTotal)} sub="given this shift" />
        <ReportCard title="Refunds" value={fmt(t.refundsTotal)} sub={`net sales ${fmt(t.netSales)}`} />
        <ReportCard title="Cash collected" value={fmt(t.cashCollected)} sub="cash tenders into drawer" />
        <ReportCard title="Expected cash" value={fmt(t.expectedCash)} sub={`float + cash − refunds + in − out`} accent />
        <ReportCard title="Overrides" value={fmt(t.overridesTotal)} sub="manager overrides" />
        <ReportCard title="Pay-ins" value={fmt(t.payInsTotal)} sub="cash added during shift" />
        <ReportCard title="Pay-outs" value={fmt(t.payOutsTotal)} sub="cash removed during shift" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="pos-report-card">
          <h3>By payment method <span className="text-xs font-normal text-slate-400">(all tenders, gross)</span></h3>
          {report.byMethod.length === 0 ? (
            <p className="text-sm text-slate-500">No sales yet this shift.</p>
          ) : (
            <div>
              {report.byMethod.map((m) => (
                <div key={m.method} className="pos-report-bar-row">
                  <div className="pos-report-bar-label">{m.method}</div>
                  <div className="pos-report-bar-track">
                    <div
                      className="pos-report-bar-fill"
                      style={{ width: `${(Number(m.total) / maxMethod) * 100}%` }}
                    />
                  </div>
                  <div className="pos-report-bar-value">{fmt(m.total)} ({m.count})</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="pos-report-card">
          <h3>By category</h3>
          {report.byCategory.length === 0 ? (
            <p className="text-sm text-slate-500">No sales yet this shift.</p>
          ) : (
            <div>
              {report.byCategory.map((c) => (
                <div key={c.categoryId ?? 'uncategorised'} className="pos-report-bar-row">
                  <div className="pos-report-bar-label">{c.categoryName}</div>
                  <div className="pos-report-bar-track">
                    <div
                      className="pos-report-bar-fill"
                      style={{ width: `${(Number(c.total) / maxCategory) * 100}%` }}
                    />
                  </div>
                  <div className="pos-report-bar-value">{fmt(c.total)} ({c.count})</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="text-xs text-slate-500">As of {new Date(report.asOf).toLocaleString()}</p>
    </div>
  );
};

const ReportCard: React.FC<{ title: string; value: string; sub?: string; accent?: boolean }> = ({ title, value, sub, accent }) => (
  <div className="pos-report-card">
    <h3>{title}</h3>
    <div className={'big ' + (accent ? 'text-emerald-600' : '')}>{value}</div>
    {sub ? <p className="text-xs text-slate-500 mt-1">{sub}</p> : null}
  </div>
);

/* ============== Hourly ============== */

const HourlyView: React.FC<{ date: string; setDate: (d: string) => void; buckets: Array<{ hour: number; count: number; total: string }>; loading: boolean }> = ({ date, setDate, buckets, loading }) => {
  const max = Math.max(1, ...buckets.map((b) => Number(b.total)));
  const peak = buckets.reduce((best, b) => (Number(b.total) > Number(best.total) ? b : best), buckets[0] ?? { hour: 0, total: '0', count: 0 });
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div>
          <Label>Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {peak && Number(peak.total) > 0 ? (
          <div className="pos-shift-banner" style={{ marginLeft: 'auto' }}>
            <TrendingUp className="h-3.5 w-3.5" /> Peak hour: {peak.hour}:00–{peak.hour + 1}:00 · {fmt(peak.total)} ({peak.count} sale{peak.count === 1 ? '' : 's'})
          </div>
        ) : null}
      </div>

      <div className="pos-report-card">
        <h3>Hourly sales — {date}</h3>
        {loading ? <p className="text-sm text-slate-500">Loading…</p> : null}
        <div>
          {buckets.map((b) => (
            <div key={b.hour} className="pos-report-bar-row">
              <div className="pos-report-bar-label">{String(b.hour).padStart(2, '0')}:00</div>
              <div className="pos-report-bar-track">
                <div
                  className="pos-report-bar-fill"
                  style={{ width: `${(Number(b.total) / max) * 100}%` }}
                />
              </div>
              <div className="pos-report-bar-value">{fmt(b.total)} ({b.count})</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

/* ============== Top items ============== */

const TopItemsView: React.FC<{
  fromDate: string; setFromDate: (d: string) => void;
  toDate: string; setToDate: (d: string) => void;
  items: Array<{ productId: string; name: string; sku: string | null; quantity: number; total: string }>;
  loading: boolean;
}> = ({ fromDate, setFromDate, toDate, setToDate, items, loading }) => {
  const total = items.reduce((s, i) => s + Number(i.total), 0);
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div>
          <Label>From</Label>
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div>
          <Label>To</Label>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <div className="ml-auto pos-report-card" style={{ minWidth: 220 }}>
          <h3>Period total</h3>
          <div className="big">{fmt(total)}</div>
        </div>
      </div>

      <div className="pos-report-card">
        <h3>Top 20 items — {fromDate} → {toDate}</h3>
        {loading ? <p className="text-sm text-slate-500">Loading…</p> : null}
        {items.length === 0 && !loading ? (
          <p className="text-sm text-slate-500">No sales in this date range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-slate-200 text-slate-600">
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">Item</th>
                  <th className="py-2 pr-3">SKU</th>
                  <th className="py-2 pr-3 text-right">Qty</th>
                  <th className="py-2 pr-3 text-right">Total</th>
                  <th className="py-2 pr-3 text-right">% of sales</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={it.productId || it.name} className="border-b border-slate-100">
                    <td className="py-2 pr-3 text-slate-500">{i + 1}</td>
                    <td className="py-2 pr-3 font-semibold">{it.name}</td>
                    <td className="py-2 pr-3 text-slate-500 font-mono text-xs">{it.sku ?? '—'}</td>
                    <td className="py-2 pr-3 text-right font-mono">{it.quantity}</td>
                    <td className="py-2 pr-3 text-right font-mono font-bold">{fmt(it.total)}</td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {total > 0 ? `${((Number(it.total) / total) * 100).toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

/* ============== Daily / Weekly / Monthly Sales Summary ============== */

const MethodBar: React.FC<{ byMethod: SalesSummaryReport['byMethod'] }> = ({ byMethod }) => {
  const max = Math.max(1, ...byMethod.map((m) => Number(m.total)));
  return (
    <div className="pos-report-card">
      <h3>By payment method</h3>
      {byMethod.length === 0 ? (
        <p className="text-sm text-slate-500">No sales in this period.</p>
      ) : (
        <div>
          {byMethod.map((m) => (
            <div key={m.method} className="pos-report-bar-row">
              <div className="pos-report-bar-label">{m.method}</div>
              <div className="pos-report-bar-track">
                <div className="pos-report-bar-fill" style={{ width: `${(Number(m.total) / max) * 100}%` }} />
              </div>
              <div className="pos-report-bar-value">{fmt(m.total)} ({m.count})</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const PeriodTable: React.FC<{
  periods: SalesSummaryReport['periods'];
  periodLabel?: string;
}> = ({ periods, periodLabel = 'Period' }) => {
  const grandTotal = periods.reduce((s, p) => s + Number(p.revenue), 0);
  return (
    <div className="pos-report-card">
      <h3>{periodLabel} breakdown</h3>
      {periods.length === 0 ? (
        <p className="text-sm text-slate-500">No sales in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-slate-200 text-slate-600">
                <th className="py-2 pr-3">{periodLabel}</th>
                <th className="py-2 pr-3 text-right">Orders</th>
                <th className="py-2 pr-3 text-right">Revenue</th>
                <th className="py-2 pr-3 text-right">Avg</th>
                <th className="py-2 pr-3 text-right">Discounts</th>
                <th className="py-2 pr-3 text-right">%</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.periodKey} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-semibold">{p.periodKey}</td>
                  <td className="py-2 pr-3 text-right font-mono">{p.orders}</td>
                  <td className="py-2 pr-3 text-right font-mono font-bold">{fmt(p.revenue)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmt(p.avgOrderValue)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmt(p.discounts)}</td>
                  <td className="py-2 pr-3 text-right font-mono">
                    {grandTotal > 0 ? `${((Number(p.revenue) / grandTotal) * 100).toFixed(1)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const DailySalesView: React.FC<{
  date: string;
  setDate: (d: string) => void;
  report: SalesSummaryReport | undefined;
  loading: boolean;
}> = ({ date, setDate, report, loading }) => {
  const t = report?.totals;
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div>
          <Label>Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {t && (
          <>
            <div className="pos-shift-banner">
              <BarChart3 className="h-3.5 w-3.5" /> {t.orders} order{t.orders === 1 ? '' : 's'} · {fmt(t.revenue)}
            </div>
          </>
        )}
      </div>
      {loading ? (
        <div className="text-slate-500 p-4">Loading daily sales…</div>
      ) : !report ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500">
          <CalendarDays className="h-10 w-10 mx-auto mb-2 opacity-50" />
          <p className="font-semibold">No data for {date}</p>
        </div>
      ) : (
        <>
          <div className="pos-report-grid">
            <ReportCard title="Net revenue" value={fmt(t!.revenue)} sub={`ex-tax · ${t!.orders} order${t!.orders === 1 ? '' : 's'}`} accent />
            <ReportCard title="Gross sales" value={fmt(t!.grossSales)} sub="incl. tax" />
            <ReportCard title="Avg order value" value={fmt(t!.avgOrderValue)} />
            <ReportCard title="Discounts" value={fmt(t!.discounts)} />
            <ReportCard title="Taxes" value={fmt(t!.taxes)} />
            <ReportCard title="Refunds" value={fmt(t!.refunds)} sub={`net sales ${fmt(t!.netSales)}`} />
          </div>
          <MethodBar byMethod={report.byMethod} />
        </>
      )}
    </div>
  );
};

const WeeklySalesView: React.FC<{
  date: string;
  setDate: (d: string) => void;
  weekStart: string;
  weekEnd: string;
  report: SalesSummaryReport | undefined;
  loading: boolean;
}> = ({ date, setDate, weekStart, weekEnd, report, loading }) => {
  const t = report?.totals;
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div>
          <Label>Week containing</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {t && (
          <div className="pos-shift-banner">
            <BarChart3 className="h-3.5 w-3.5" /> {weekStart} → {weekEnd} · {t.orders} order{t.orders === 1 ? '' : 's'} · {fmt(t.revenue)}
          </div>
        )}
      </div>
      {loading ? (
        <div className="text-slate-500 p-4">Loading weekly sales…</div>
      ) : !report ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500">
          <CalendarDays className="h-10 w-10 mx-auto mb-2 opacity-50" />
          <p className="font-semibold">No data for {weekStart} – {weekEnd}</p>
        </div>
      ) : (
        <>
          <div className="pos-report-grid">
            <ReportCard title="Net revenue" value={fmt(t!.revenue)} sub={`ex-tax · ${t!.orders} order${t!.orders === 1 ? '' : 's'}`} accent />
            <ReportCard title="Gross sales" value={fmt(t!.grossSales)} sub="incl. tax" />
            <ReportCard title="Avg order value" value={fmt(t!.avgOrderValue)} />
            <ReportCard title="Discounts" value={fmt(t!.discounts)} />
            <ReportCard title="Taxes" value={fmt(t!.taxes)} />
            <ReportCard title="Refunds" value={fmt(t!.refunds)} sub={`net sales ${fmt(t!.netSales)}`} />
          </div>
          <PeriodTable periods={report.periods} periodLabel="Day" />
          <MethodBar byMethod={report.byMethod} />
        </>
      )}
    </div>
  );
};

const MonthlySalesView: React.FC<{
  monthStr: string;
  setMonthStr: (m: string) => void;
  report: SalesSummaryReport | undefined;
  loading: boolean;
}> = ({ monthStr, setMonthStr, report, loading }) => {
  const t = report?.totals;
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div>
          <Label>Month</Label>
          <Input type="month" value={monthStr} onChange={(e) => setMonthStr(e.target.value)} />
        </div>
        {t && (
          <div className="pos-shift-banner">
            <BarChart3 className="h-3.5 w-3.5" /> {monthStr} · {t.orders} order{t.orders === 1 ? '' : 's'} · {fmt(t.revenue)}
          </div>
        )}
      </div>
      {loading ? (
        <div className="text-slate-500 p-4">Loading monthly sales…</div>
      ) : !report ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500">
          <CalendarDays className="h-10 w-10 mx-auto mb-2 opacity-50" />
          <p className="font-semibold">No data for {monthStr}</p>
        </div>
      ) : (
        <>
          <div className="pos-report-grid">
            <ReportCard title="Net revenue" value={fmt(t!.revenue)} sub={`ex-tax · ${t!.orders} order${t!.orders === 1 ? '' : 's'}`} accent />
            <ReportCard title="Gross sales" value={fmt(t!.grossSales)} sub="incl. tax" />
            <ReportCard title="Avg order value" value={fmt(t!.avgOrderValue)} />
            <ReportCard title="Discounts" value={fmt(t!.discounts)} />
            <ReportCard title="Taxes" value={fmt(t!.taxes)} />
            <ReportCard title="Refunds" value={fmt(t!.refunds)} sub={`net sales ${fmt(t!.netSales)}`} />
          </div>
          <PeriodTable periods={report.periods} periodLabel="Day" />
          <MethodBar byMethod={report.byMethod} />
        </>
      )}
    </div>
  );
};

export default ReportsPage;