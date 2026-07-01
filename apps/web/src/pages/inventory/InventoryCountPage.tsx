import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, History, Play, Save, CheckCircle2, XCircle, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { dateTime } from '@/lib/format';

interface Location { id: string; code: string; name: string }
interface ProductLite { id: string; category?: { name?: string } | null }
interface CountLine {
  id: string;
  productId: string;
  productName: string;
  unit?: string | null;
  systemQty: string;
  countedQty: string | null;
  variance: string;
  reason?: string | null;
}
interface CountSession {
  id: string;
  countCode: string;
  locationId: string;
  countType: 'opening' | 'closing';
  status: 'draft' | 'submitted' | 'cancelled';
  startedAt: string;
  submittedAt?: string | null;
  adjustmentId?: string | null;
  location?: Location;
  lines: CountLine[];
  _count?: { lines: number };
}

type Edit = { countedQty: string; reason: string };

const num = (v: string | number | null | undefined) => Number(v ?? 0);

export function InventoryCountPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'count' | 'history'>('count');
  const [locationId, setLocationId] = useState('');
  const [countType, setCountType] = useState<'opening' | 'closing'>('opening');

  const [session, setSession] = useState<CountSession | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [onlyVariance, setOnlyVariance] = useState(false);

  const locations = useQuery<Location[]>({
    queryKey: ['inventory-locations'],
    queryFn: async () => (await api.get<{ data: Location[] }>('/inventory/locations')).data.data ?? [],
  });

  // Product → category name, used only for the category filter dropdown.
  const products = useQuery<ProductLite[]>({
    queryKey: ['products-lite'],
    queryFn: async () => (await api.get<{ data: ProductLite[] }>('/products?pageSize=500')).data.data ?? [],
  });
  const categoryOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of products.data ?? []) m.set(p.id, p.category?.name ?? 'Uncategorised');
    return m;
  }, [products.data]);
  const categories = useMemo(
    () => Array.from(new Set([...categoryOf.values()])).sort(),
    [categoryOf],
  );

  const history = useQuery<CountSession[]>({
    queryKey: ['inventory-counts'],
    queryFn: async () => (await api.get<CountSession[]>('/inventory/counts')).data ?? [],
    enabled: tab === 'history',
  });

  const loadSession = (s: CountSession) => {
    setSession(s);
    const e: Record<string, Edit> = {};
    for (const ln of s.lines) {
      e[ln.id] = { countedQty: ln.countedQty ?? '', reason: ln.reason ?? '' };
    }
    setEdits(e);
  };

  const start = useMutation({
    mutationFn: async () =>
      (await api.post<CountSession>('/inventory/counts/start', { locationId, countType })).data,
    onSuccess: (s) => {
      loadSession(s);
      notify.success(`Count ${s.countCode} ready — ${s.lines.length} items`);
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Could not start count'),
  });

  const buildPayload = () => ({
    lines: (session?.lines ?? []).map((ln) => {
      const ed = edits[ln.id] ?? { countedQty: '', reason: '' };
      const raw = ed.countedQty.trim();
      return {
        lineId: ln.id,
        countedQty: raw === '' ? null : Number(raw),
        reason: ed.reason.trim() || undefined,
      };
    }),
  });

  const saveDraft = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('No session');
      return (await api.patch<CountSession>(`/inventory/counts/${session.id}/draft`, buildPayload())).data;
    },
    onSuccess: (s) => { loadSession(s); notify.success('Draft saved'); },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Save failed'),
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('No session');
      // Persist the latest edits, then finalise.
      await api.patch(`/inventory/counts/${session.id}/draft`, buildPayload());
      return (await api.post<CountSession>(`/inventory/counts/${session.id}/submit`)).data;
    },
    onSuccess: (s) => {
      notify.success(s.adjustmentId ? 'Count submitted — stock adjusted' : 'Count submitted — no variances');
      setSession(null);
      setEdits({});
      qc.invalidateQueries({ queryKey: ['inventory-counts'] });
      qc.invalidateQueries({ queryKey: ['inventory-items'] });
      qc.invalidateQueries({ queryKey: ['inventory-ledger'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Submit failed'),
  });

  const cancel = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('No session');
      return (await api.post(`/inventory/counts/${session.id}/cancel`)).data;
    },
    onSuccess: () => { setSession(null); setEdits({}); notify.success('Count cancelled'); },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Cancel failed'),
  });

  const setEdit = (id: string, patch: Partial<Edit>) =>
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { countedQty: '', reason: '' }), ...patch } }));

  // Derived per-line view (variance from live edits).
  const rows = useMemo(() => {
    const lines = session?.lines ?? [];
    return lines.map((ln) => {
      const ed = edits[ln.id] ?? { countedQty: '', reason: '' };
      const counted = ed.countedQty.trim() === '' ? null : Number(ed.countedQty);
      const variance = counted === null ? null : counted - num(ln.systemQty);
      return { ln, ed, counted, variance };
    });
  }, [session, edits]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(({ ln, variance }) => {
      if (q && !ln.productName.toLowerCase().includes(q)) return false;
      if (category !== 'all' && (categoryOf.get(ln.productId) ?? 'Uncategorised') !== category) return false;
      if (onlyVariance && !(variance !== null && variance !== 0)) return false;
      return true;
    });
  }, [rows, search, category, onlyVariance, categoryOf]);

  const countedTotal = rows.filter((r) => r.counted !== null).length;
  const varianceCount = rows.filter((r) => r.variance !== null && r.variance !== 0).length;
  const missingReasons = rows.filter((r) => r.variance !== null && r.variance !== 0 && !r.ed.reason.trim()).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ClipboardList className="h-6 w-6" /> Inventory Count
          </h1>
          <p className="text-sm text-muted-foreground">
            Physically count stock. Variances post an audited adjustment — stock is never overwritten directly.
          </p>
        </div>
      </div>

      <div className="flex gap-1 border-b pb-2">
        <Button size="sm" variant={tab === 'count' ? 'default' : 'outline'} onClick={() => setTab('count')}>
          <ClipboardList className="mr-1 h-3 w-3" /> Count
        </Button>
        <Button size="sm" variant={tab === 'history' ? 'default' : 'outline'} onClick={() => setTab('history')}>
          <History className="mr-1 h-3 w-3" /> History
        </Button>
      </div>

      {tab === 'count' && !session && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="text-sm font-medium">Location</label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger><SelectValue placeholder="Store / Kitchen / Warehouse" /></SelectTrigger>
                  <SelectContent>
                    {locations.data?.map((l) => (
                      <SelectItem key={l.id} value={l.id}>{l.code} — {l.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">Count Type</label>
                <Select value={countType} onValueChange={(v) => setCountType(v as 'opening' | 'closing')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="opening">Morning (Opening)</SelectItem>
                    <SelectItem value="closing">Evening (Closing)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button className="w-full" disabled={!locationId || start.isPending} onClick={() => start.mutate()}>
                  <Play className="mr-2 h-4 w-4" /> {start.isPending ? 'Loading…' : 'Start / Resume Count'}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              An unfinished draft for the same location + type is resumed automatically.
            </p>
          </CardContent>
        </Card>
      )}

      {tab === 'count' && session && (
        <div className="space-y-3">
          {/* Session bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3">
            <div className="flex items-center gap-3">
              <Badge variant="outline">{session.countCode}</Badge>
              <span className="text-sm font-medium">
                {session.location?.code ?? ''} · {session.countType === 'opening' ? 'Morning' : 'Evening'}
              </span>
              <span className="text-sm text-muted-foreground">
                {countedTotal} of {rows.length} counted · {varianceCount} variance
              </span>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                <XCircle className="mr-1 h-4 w-4" /> Cancel
              </Button>
              <Button size="sm" variant="outline" onClick={() => saveDraft.mutate()} disabled={saveDraft.isPending}>
                <Save className="mr-1 h-4 w-4" /> {saveDraft.isPending ? 'Saving…' : 'Save Draft'}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  if (missingReasons > 0) { notify.error(`${missingReasons} variance line(s) need a reason`); return; }
                  submit.mutate();
                }}
                disabled={submit.isPending || countedTotal === 0}
              >
                <CheckCircle2 className="mr-1 h-4 w-4" /> {submit.isPending ? 'Submitting…' : 'Submit Count'}
              </Button>
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="w-56 pl-8" placeholder="Search product…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-48"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
              </SelectContent>
            </Select>
            <Button size="sm" variant={onlyVariance ? 'default' : 'outline'} onClick={() => setOnlyVariance((v) => !v)}>
              Only variances
            </Button>
          </div>

          {/* Count table */}
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-right">System</th>
                  <th className="px-3 py-2 text-right w-28">Actual</th>
                  <th className="px-3 py-2 text-right">Variance</th>
                  <th className="px-3 py-2 text-left">Reason</th>
                  <th className="px-3 py-2 text-center w-10"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ ln, ed, counted, variance }) => {
                  const hasVar = variance !== null && variance !== 0;
                  const needReason = hasVar && !ed.reason.trim();
                  return (
                    <tr key={ln.id} className="border-b hover:bg-muted/20">
                      <td className="px-3 py-1.5">
                        {ln.productName}
                        {ln.unit && <span className="ml-1 text-xs text-muted-foreground">({ln.unit})</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">{num(ln.systemQty)}</td>
                      <td className="px-3 py-1.5">
                        <Input
                          type="number" inputMode="decimal" className="h-8 text-right"
                          placeholder="—"
                          value={ed.countedQty}
                          onChange={(e) => setEdit(ln.id, { countedQty: e.target.value })}
                        />
                      </td>
                      <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${
                        variance === null ? 'text-muted-foreground'
                          : variance === 0 ? 'text-muted-foreground'
                          : variance > 0 ? 'text-emerald-600' : 'text-destructive'
                      }`}>
                        {variance === null ? '—' : `${variance > 0 ? '+' : ''}${variance}`}
                      </td>
                      <td className="px-3 py-1.5">
                        {hasVar ? (
                          <Input
                            className={`h-8 ${needReason ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                            placeholder="Reason required…"
                            value={ed.reason}
                            onChange={(e) => setEdit(ln.id, { reason: e.target.value })}
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {counted !== null && variance === 0 && <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-600" />}
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No items match the filter</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="space-y-2">
          {history.isLoading && <Skeleton className="h-48 w-full" />}
          {history.data && history.data.length > 0 && (
            <div className="rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left">Code</th>
                    <th className="px-3 py-2 text-left">Location</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-right">Items</th>
                    <th className="px-3 py-2 text-left">Started</th>
                    <th className="px-3 py-2 text-left">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.map((s) => (
                    <tr key={s.id} className="border-b hover:bg-muted/20">
                      <td className="px-3 py-2 font-mono">{s.countCode}</td>
                      <td className="px-3 py-2">{s.location?.code ?? '—'}</td>
                      <td className="px-3 py-2">{s.countType === 'opening' ? 'Morning' : 'Evening'}</td>
                      <td className="px-3 py-2">
                        <Badge variant={s.status === 'submitted' ? 'default' : s.status === 'cancelled' ? 'destructive' : 'outline'}>
                          {s.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right">{s._count?.lines ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{dateTime(s.startedAt)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{s.submittedAt ? dateTime(s.submittedAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {history.data && history.data.length === 0 && (
            <Card><CardContent className="p-8 text-center text-muted-foreground">No counts yet</CardContent></Card>
          )}
        </div>
      )}
    </div>
  );
}
