// KDS — kitchen performance reports + live-ops dashboard.
import React, { useState } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { PERMISSIONS } from '@erp/shared';
import { ChefHat, Clock, AlertTriangle, RotateCcw, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useKdsReportSummary, useKdsLive } from './pos-features-api';
import { tx } from '@/lib/i18n/tx';

const Stat: React.FC<{ label: string; value: React.ReactNode; sub?: string; tone?: string }> = ({ label, value, sub, tone }) => (
  <div className="rounded-xl border p-3">
    <div className="text-xs text-muted-foreground">{label}</div>
    <div className={`text-2xl font-extrabold ${tone ?? ''}`}>{value}</div>
    {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
  </div>
);

const KdsReportsPage: React.FC = () => {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canView = hasPermission(PERMISSIONS.pos.reports);

  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 3600 * 1000);
  const [from, setFrom] = useState(weekAgo.toISOString().slice(0, 10));
  const [to, setTo] = useState(today.toISOString().slice(0, 10));

  const { data: live } = useKdsLive();
  const { data: sum, isLoading } = useKdsReportSummary(from ? `${from}T00:00:00.000Z` : undefined, to ? `${to}T23:59:59.999Z` : undefined);

  if (!canView) {
    return <div className="p-8 text-center text-muted-foreground">{tx('You need POS reports permission (pos:reports).')}</div>;
  }

  const maxHour = Math.max(1, ...(sum?.peakHours.map((h) => h.count) ?? [1]));

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-5">
      <h1 className="text-2xl font-extrabold flex items-center gap-2"><ChefHat className="h-6 w-6" /> {tx('Kitchen Reports')}</h1>

      {/* Live ops */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Clock className="h-4 w-4" /> {tx('Live now')}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label={tx('Active')} value={live?.totalActive ?? '—'} />
          <Stat label={tx('New')} value={live?.counts.new ?? '—'} tone="text-blue-600" />
          <Stat label={tx('Preparing')} value={live?.counts.preparing ?? '—'} tone="text-amber-600" />
          <Stat label={tx('Ready')} value={live?.counts.ready ?? '—'} tone="text-emerald-600" />
          <Stat label={tx('Avg age')} value={`${live?.avgAgeMin ?? 0}m`} />
          <Stat label={tx('Longest wait')} value={`${live?.longestWaitMin ?? 0}m`} tone={(live?.longestWaitMin ?? 0) >= 10 ? 'text-rose-600' : ''} />
        </CardContent>
      </Card>

      {/* Range picker */}
      <div className="flex items-end gap-3">
        <div><Label className="text-xs">{tx('From')}</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><Label className="text-xs">{tx('To')}</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>

      {isLoading && <div className="text-muted-foreground">{tx('Loading…')}</div>}
      {sum && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label={tx('Tickets')} value={sum.totals.tickets} />
            <Stat label={tx('Avg prep')} value={`${sum.prepTime.avg}m`} sub={`p50 ${sum.prepTime.p50}m · p90 ${sum.prepTime.p90}m`} />
            <Stat label={tx('Avg wait')} value={`${sum.waitTime.avg}m`} sub={`p50 ${sum.waitTime.p50}m · p90 ${sum.waitTime.p90}m`} />
            <Stat label={tx('Delayed')} value={sum.totals.delayed} tone={sum.totals.delayed ? 'text-rose-600' : ''} sub={`>10m prep`} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-base">{tx('Per station')}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {sum.perStation.length === 0 && <div className="text-sm text-muted-foreground">{tx('No data.')}</div>}
                {sum.perStation.map((s) => (
                  <div key={s.station} className="flex items-center justify-between text-sm">
                    <span className="font-semibold capitalize">{s.station}</span>
                    <span className="text-muted-foreground">{s.tickets} {tx('tickets · avg')} {s.avgPrep}m</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">{tx('Per chef')}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {sum.perChef.length === 0 && <div className="text-sm text-muted-foreground">{tx('No chef attribution yet.')}</div>}
                {sum.perChef.map((c) => (
                  <div key={c.chefUserId} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-xs truncate max-w-[60%]">{c.chefUserId}</span>
                    <span className="text-muted-foreground">{c.tickets} {tx('· avg')} {c.avgPrep}m</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><RotateCcw className="h-4 w-4" /> {tx('Recall causes')}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {sum.recallCauses.length === 0 && <div className="text-sm text-muted-foreground">{tx('No recalls 🎉')}</div>}
                {sum.recallCauses.map((r) => (
                  <div key={r.reason} className="flex items-center justify-between text-sm">
                    <span className="capitalize">{r.reason}</span><span className="text-muted-foreground">{r.count}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">{tx('Top dishes')}</CardTitle></CardHeader>
              <CardContent className="space-y-1.5">
                {sum.topDishes.slice(0, 8).map((d) => (
                  <div key={d.name} className="flex items-center justify-between text-sm">
                    <span className="truncate max-w-[70%]">{d.name}</span><span className="text-muted-foreground">{d.qty}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {tx('Peak hours (UTC)')}</CardTitle></CardHeader>
            <CardContent>
              <div className="flex items-end gap-0.5 h-24">
                {sum.peakHours.map((h) => (
                  <div key={h.hour} className="flex-1 flex flex-col items-center justify-end gap-1" title={`${h.hour}:00 — ${h.count}`}>
                    <div className="w-full rounded-t bg-sky-400" style={{ height: `${(h.count / maxHour) * 100}%` }} />
                    <span className="text-[9px] text-muted-foreground">{h.hour}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1"><XCircle className="h-4 w-4" /> {sum.totals.cancelled} {tx('cancelled')}</span>
            <span className="flex items-center gap-1"><RotateCcw className="h-4 w-4" /> {sum.totals.recalls} {tx('recalls')}</span>
          </div>
        </>
      )}
    </div>
  );
};

export default KdsReportsPage;
