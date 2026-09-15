import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Fragment } from 'react';
import { ClipboardList, History, Play, Save, CheckCircle2, XCircle, Search, Eye, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { dateTime } from '@/lib/format';
import { useAuthStore } from '@/stores/auth.store';
import { useLookups } from './inventory-reports/filters';

type CountType = 'opening' | 'closing' | 'cycle' | 'spot';
const COUNT_TYPE_LABEL: Record<CountType, string> = {
  opening: 'Morning',
  closing: 'Evening',
  cycle: 'Cycle',
  spot: 'Spot check',
};

interface Location { id: string; code: string; name: string }
interface ProductLite { id: string; category?: { name?: string } | null }
interface CountLine {
  id: string;
  productId: string;
  variantId?: string | null;
  productName: string;
  parentProductId?: string | null;
  parentProductName?: string | null;
  unit?: string | null;
  /** null while a blind count is a draft (hidden from counters). */
  systemQty: string | null;
  countedQty: string | null;
  variance: string | null;
  reason?: string | null;
}
interface CountSession {
  id: string;
  countCode: string;
  name?: string | null;
  locationId: string;
  countType: CountType;
  blind?: boolean;
  /** Server masked system quantities (blind draft). */
  systemHidden?: boolean;
  scopeCategoryIds?: string[];
  scopeProductIds?: string[];
  /** `preview` is a sheet the server built but did NOT persist — see GET /inventory/counts/preview. */
  status: 'draft' | 'submitted' | 'cancelled' | 'preview';
  notes?: string | null;
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
  const [countType, setCountType] = useState<CountType>('opening');
  const [blind, setBlind] = useState(false);
  const [scopeCategoryId, setScopeCategoryId] = useState('');
  const [scopeProductIds, setScopeProductIds] = useState<string[]>([]);
  const canReview = useAuthStore((st) => st.hasPermission)('inventory_count:submit');
  const lookups = useLookups();
  const partial = countType === 'cycle' || countType === 'spot';
  const scopeParams = partial
    ? {
        ...(scopeCategoryId && countType === 'cycle' ? { scopeCategoryIds: scopeCategoryId } : {}),
        ...(scopeProductIds.length ? { scopeProductIds: scopeProductIds.join(',') } : {}),
      }
    : {};

  const [session, setSession] = useState<CountSession | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [onlyVariance, setOnlyVariance] = useState(false);
  const [viewSessionId, setViewSessionId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [saveDraftOpen, setSaveDraftOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftNotes, setDraftNotes] = useState('');

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const viewSession = useQuery<CountSession>({
    queryKey: ['inventory-count', viewSessionId],
    queryFn: async () => {
      if (!viewSessionId) throw new Error('No session');
      return (await api.get<CountSession>(`/inventory/counts/${viewSessionId}`)).data;
    },
    enabled: !!viewSessionId,
  });

  const locations = useQuery<Location[]>({
    queryKey: ['inventory-locations'],
    queryFn: async () => (await api.get<{ data: Location[] }>('/inventory/locations')).data.data ?? [],
  });

  // Pick a location as soon as we know one. The page used to open with no
  // location selected, which left "Start Count" disabled and the sheet empty —
  // a supervisor arriving for the morning count saw a blank screen and a dead
  // button, with nothing saying a dropdown had to be touched first.
  useEffect(() => {
    if (locationId) return;
    const first = locations.data?.[0];
    if (first) setLocationId(first.id);
  }, [locations.data, locationId]);


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
    setDraftName(s.name ?? '');
    setDraftNotes(s.notes ?? '');
  };

  /**
   * Pick an unfinished draft up from the History tab. A partial unique index
   * allows only ONE draft per (org, location, countType), so pointing the
   * location + type selectors at the draft is enough — the sheet query below
   * resolves to that very session and the Count tab becomes editable again,
   * with Save Draft and Submit Count both available.
   */
  const resumeDraft = (s: CountSession) => {
    setLocationId(s.locationId);
    setCountType(s.countType);
    setTab('count');
    setSearch('');
    setCategory('all');
    setOnlyVariance(false);
    // Drop whatever sheet was loaded so the adopt-effect takes the draft.
    if (session?.id !== s.id) {
      setSession(null);
      setEdits({});
    }
  };

  /**
   * The sheet for the chosen location + type, WITHOUT creating anything: the
   * open draft if one exists (real line ids — the count resumes itself), else a
   * server-built preview of exactly what Start would create. This is what makes
   * the product list visible before a session exists.
   */
  const sheet = useQuery<CountSession>({
    queryKey: ['inventory-count-sheet', locationId, countType, scopeParams],
    queryFn: async () =>
      (await api.get<CountSession>('/inventory/counts/preview', { params: { locationId, countType, ...scopeParams } })).data,
    enabled: !!locationId,
  });

  // Adopt whatever the sheet says, unless the user is mid-count on that exact
  // session (their unsaved keystrokes must survive a background refetch).
  useEffect(() => {
    const s = sheet.data;
    if (!s) return;
    if (session && session.id === s.id && session.status === s.status) return;
    loadSession(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.data]);

  const start = useMutation({
    // restart=true discards an open draft that already has counts; without it
    // the API resumes that draft instead of wiping a colleague's work.
    mutationFn: async (restart: boolean = false) =>
      (await api.post<CountSession>('/inventory/counts/start', {
        locationId,
        countType,
        blind,
        ...(partial && countType === 'cycle' && scopeCategoryId ? { scopeCategoryIds: [scopeCategoryId] } : {}),
        ...(partial && scopeProductIds.length ? { scopeProductIds } : {}),
        ...(restart ? { restart: true } : {}),
      })).data,
    onSuccess: (s) => {
      loadSession(s);
      qc.invalidateQueries({ queryKey: ['inventory-count-sheet'] });
      notify.success(`Count ${s.countCode} ready — ${s.lines.length} items`);
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Could not start count'),
  });

  const buildPayload = () => ({
    name: draftName.trim() || undefined,
    notes: draftNotes.trim() || undefined,
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
      // Drop back to a fresh preview of the (now adjusted) stock.
      qc.invalidateQueries({ queryKey: ['inventory-count-sheet'] });
      qc.invalidateQueries({ queryKey: ['inventory-items'] });
      qc.invalidateQueries({ queryKey: ['inventory-ledger'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Submit failed'),
  });

  /** Blind count: a submitter saves the counts, then loads the unmasked sheet to reconcile. */
  const review = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('No session');
      await api.patch(`/inventory/counts/${session.id}/draft`, buildPayload());
      return (await api.get<CountSession>(`/inventory/counts/${session.id}/review`)).data;
    },
    onSuccess: (s) => { loadSession(s); notify.success('System quantities revealed for review'); },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Could not load the review sheet'),
  });

  const cancel = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('No session');
      return (await api.post(`/inventory/counts/${session.id}/cancel`)).data;
    },
    onSuccess: () => {
      setSession(null);
      setEdits({});
      qc.invalidateQueries({ queryKey: ['inventory-count-sheet'] });
      notify.success('Count cancelled');
    },
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
      const variance = counted === null || ln.systemQty === null ? null : counted - num(ln.systemQty);
      return { ln, ed, counted, variance };
    });
  }, [session, edits]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(({ ln, variance }) => {
      if (q) {
        const matches = ln.productName.toLowerCase().includes(q)
          || (ln.parentProductName ?? '').toLowerCase().includes(q);
        if (!matches) return false;
      }
      if (category !== 'all' && (categoryOf.get(ln.productId) ?? 'Uncategorised') !== category) return false;
      if (onlyVariance && !(variance !== null && variance !== 0)) return false;
      return true;
    });
  }, [rows, search, category, onlyVariance, categoryOf]);

  // A preview sheet is real data (system on-hand right now) but nothing is
  // persisted yet, so it is read-only until the count is actually started.
  const isDraft = session?.status === 'draft';
  const isPreview = session?.status === 'preview';
  const blindView = !!session?.systemHidden;

  const countedTotal = rows.filter((r) => r.counted !== null).length;
  const varianceCount = rows.filter((r) => r.variance !== null && r.variance !== 0).length;
  const missingReasons = rows.filter((r) => r.variance !== null && r.variance !== 0 && !r.ed.reason.trim()).length;

  const grouped = useMemo(() => {
    const groups: Array<{
      key: string;
      parentProductId: string | null;
      parentProductName: string | null;
      isVariantGroup: boolean;
      items: typeof filtered;
    }> = [];

    const variantMap = new Map<string, typeof filtered>();
    const standalone: typeof filtered = [];

    for (const row of filtered) {
      if (row.ln.parentProductId) {
        const pid = row.ln.parentProductId;
        if (!variantMap.has(pid)) variantMap.set(pid, []);
        variantMap.get(pid)!.push(row);
      } else {
        standalone.push(row);
      }
    }

    for (const row of standalone) {
      groups.push({ key: row.ln.id, parentProductId: null, parentProductName: null, isVariantGroup: false, items: [row] });
    }

    const sorted = [...variantMap.entries()].sort((a, b) => {
      const an = a[1][0]?.ln.parentProductName ?? '';
      const bn = b[1][0]?.ln.parentProductName ?? '';
      return an.localeCompare(bn);
    });

    for (const [pid, items] of sorted) {
      groups.push({
        key: `vgrp-${pid}`,
        parentProductId: pid,
        parentProductName: items[0]?.ln.parentProductName ?? null,
        isVariantGroup: true,
        items,
      });
    }

    return groups;
  }, [filtered]);

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

      {tab === 'count' && (
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
                <Select value={countType} onValueChange={(v) => setCountType(v as CountType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="opening">Morning (Opening)</SelectItem>
                    <SelectItem value="closing">Evening (Closing)</SelectItem>
                    <SelectItem value="cycle">Cycle count (by category)</SelectItem>
                    <SelectItem value="spot">Spot check (chosen items)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                {isDraft ? (
                  <div className="flex w-full items-center justify-between gap-2 rounded-md border border-emerald-600/30 bg-emerald-600/10 px-3 py-2 text-sm">
                    <span>Counting <span className="font-medium">{session?.countCode}</span> — enter actual quantities below.</span>
                    <Button
                      size="sm" variant="ghost" className="h-7 shrink-0 text-xs"
                      disabled={start.isPending}
                      onClick={() => {
                        if (window.confirm(`Discard ${session?.countCode ?? 'this count'} and every quantity entered so far, and start a fresh sheet?`)) start.mutate(true);
                      }}
                    >
                      Start over
                    </Button>
                  </div>
                ) : (
                  <Button className="w-full" disabled={!locationId || start.isPending || locations.isLoading} onClick={() => start.mutate(false)}>
                    <Play className="mr-2 h-4 w-4" />
                    {start.isPending ? 'Starting…' : locations.isLoading ? 'Loading locations…' : 'Start Count'}
                  </Button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={blind} disabled={isDraft} onChange={(e) => setBlind(e.target.checked)} />
                Blind count <span className="text-xs text-muted-foreground">(hide system quantities from counters)</span>
              </label>
              {countType === 'cycle' && (
                <div className="min-w-[220px]">
                  <label className="text-sm font-medium" htmlFor="count-scope-category">Category</label>
                  <select
                    id="count-scope-category"
                    className="block h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={scopeCategoryId}
                    disabled={isDraft}
                    onChange={(e) => setScopeCategoryId(e.target.value)}
                  >
                    <option value="">Choose a category…</option>
                    {(lookups.categories.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}
              {countType === 'spot' && (
                <div className="min-w-[260px] flex-1">
                  <label className="text-sm font-medium" htmlFor="count-scope-products">Items (Ctrl/⌘-click for several)</label>
                  <select
                    id="count-scope-products"
                    multiple
                    className="block h-24 w-full rounded-md border bg-background px-2 text-sm"
                    value={scopeProductIds}
                    disabled={isDraft}
                    onChange={(e) => setScopeProductIds(Array.from(e.target.selectedOptions).map((o) => o.value))}
                  >
                    {(lookups.products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.code ? `${p.code} — ` : ''}{p.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            {locations.isError ? (
              <div className="flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
                <span>Could not load stock locations, so no count can be started.</span>
                <Button size="sm" variant="outline" onClick={() => locations.refetch()}>Retry</Button>
              </div>
            ) : !locations.isLoading && (locations.data?.length ?? 0) === 0 ? (
              <p className="text-xs text-destructive">
                No stock locations exist yet. Create one under Inventory → Locations before counting.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {isDraft
                  ? 'An unfinished draft for this location and type was resumed. Save it and come back any time before submitting.'
                  : 'The sheet below is what will be counted. Start the count to enter actual quantities.'}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {tab === 'count' && sheet.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}

      {tab === 'count' && sheet.isError && (
        <Card>
          <CardContent className="flex items-center gap-3 p-6 text-sm">
            <span>{(sheet.error as any)?.response?.data?.message ?? 'Could not load the count sheet.'}</span>
            <Button size="sm" variant="outline" onClick={() => sheet.refetch()}>Retry</Button>
          </CardContent>
        </Card>
      )}

      {tab === 'count' && session && (
        <div className="space-y-3">
          {/* Session bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-sm font-medium truncate max-w-[280px]" title={session.name ?? ''}>{session.name ?? session.countCode}</span>
              <Badge variant={isPreview ? 'secondary' : 'outline'} className="shrink-0">
                {isPreview ? 'Not started' : session.countCode}
              </Badge>
              <span className="text-sm text-muted-foreground hidden sm:inline">
                {session.location?.code ?? ''} · {COUNT_TYPE_LABEL[session.countType] ?? session.countType}{session.blind ? ' · blind' : ''}
              </span>
              <span className="text-sm text-muted-foreground">
                {isPreview
                  ? `${rows.length} items to count`
                  : blindView ? `${countedTotal} of ${rows.length} counted · variances hidden` : `${countedTotal} of ${rows.length} · ${varianceCount} variance`}
              </span>
            </div>
            <div className={`flex gap-2 ${isDraft ? '' : 'hidden'}`}>
              <Button size="sm" variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                <XCircle className="mr-1 h-4 w-4" /> Cancel
              </Button>
              {blindView && canReview && (
                <Button size="sm" variant="outline" onClick={() => review.mutate()} disabled={review.isPending}>
                  <Eye className="mr-1 h-4 w-4" /> {review.isPending ? 'Loading…' : 'Review variances'}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setSaveDraftOpen(true)} disabled={saveDraft.isPending}>
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
                {grouped.map((group) => {
                  if (!group.isVariantGroup) {
                    const { ln, ed, counted, variance } = group.items[0];
                    const hasVar = variance !== null && variance !== 0;
                    const needReason = hasVar && !ed.reason.trim();
                    return (
                      <tr key={ln.id} className="border-b hover:bg-muted/20">
                        <td className="px-3 py-1.5">
                          {ln.productName}
                          {ln.unit && <span className="ml-1 text-xs text-muted-foreground">({ln.unit})</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{blindView ? <span className="text-xs text-muted-foreground">Hidden</span> : num(ln.systemQty)}</td>
                        <td className="px-3 py-1.5">
                          <Input type="number" inputMode="decimal" className="h-8 text-right" placeholder={isDraft ? '—' : 'Start count'} disabled={!isDraft} value={ed.countedQty} onChange={(e) => setEdit(ln.id, { countedQty: e.target.value })} />
                        </td>
                        <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${variance === null ? 'text-muted-foreground' : variance === 0 ? 'text-muted-foreground' : variance > 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                          {variance === null ? '—' : `${variance > 0 ? '+' : ''}${variance}`}
                        </td>
                        <td className="px-3 py-1.5">
                          {hasVar || blindView ? (
                            <Input className={`h-8 ${needReason ? 'border-destructive focus-visible:ring-destructive' : ''}`} placeholder={hasVar ? 'Reason required…' : 'Note (optional)'} disabled={!isDraft} value={ed.reason} onChange={(e) => setEdit(ln.id, { reason: e.target.value })} />
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          {counted !== null && variance === 0 && <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-600" />}
                        </td>
                      </tr>
                    );
                  }

                  const expanded = expandedGroups.has(group.key);
                  return (
                    <Fragment key={group.key}>
                      <tr className="border-b bg-muted/40 cursor-pointer hover:bg-muted/60 select-none" onClick={() => toggleGroup(group.key)}>
                        <td className="px-3 py-2" colSpan={6}>
                          <div className="flex items-center gap-2">
                            <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
                            <span className="font-medium">{group.parentProductName}</span>
                            <Badge variant="secondary" className="ml-1 text-xs">{group.items.length} variants</Badge>
                          </div>
                        </td>
                      </tr>
                      {expanded && group.items.map(({ ln, ed, counted, variance }) => {
                        const hasVar = variance !== null && variance !== 0;
                        const needReason = hasVar && !ed.reason.trim();
                        return (
                          <tr key={ln.id} className="border-b hover:bg-muted/20">
                            <td className="px-3 py-1.5 pl-10">
                              {ln.productName}
                              {ln.unit && <span className="ml-1 text-xs text-muted-foreground">({ln.unit})</span>}
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono tabular-nums">{blindView ? <span className="text-xs text-muted-foreground">Hidden</span> : num(ln.systemQty)}</td>
                            <td className="px-3 py-1.5">
                              <Input type="number" inputMode="decimal" className="h-8 text-right" placeholder={isDraft ? '—' : 'Start count'} disabled={!isDraft} value={ed.countedQty} onChange={(e) => setEdit(ln.id, { countedQty: e.target.value })} />
                            </td>
                            <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${variance === null ? 'text-muted-foreground' : variance === 0 ? 'text-muted-foreground' : variance > 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                              {variance === null ? '—' : `${variance > 0 ? '+' : ''}${variance}`}
                            </td>
                            <td className="px-3 py-1.5">
                              {hasVar || blindView ? (
                                <Input className={`h-8 ${needReason ? 'border-destructive focus-visible:ring-destructive' : ''}`} placeholder={hasVar ? 'Reason required…' : 'Note (optional)'} disabled={!isDraft} value={ed.reason} onChange={(e) => setEdit(ln.id, { reason: e.target.value })} />
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
                      {expanded && group.items.length === 0 && (
                        <tr><td colSpan={6} className="px-3 py-4 pl-10 text-center text-muted-foreground">No variants</td></tr>
                      )}
                    </Fragment>
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
          {history.isError && (
            <Card><CardContent className="p-8 text-center text-destructive">Failed to load count history</CardContent></Card>
          )}
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
                    <th className="px-3 py-2 text-center w-40">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.map((s) => (
                    <tr key={s.id} className="border-b hover:bg-muted/20">
                      <td className="px-3 py-2 font-mono">{s.countCode}</td>
                      <td className="px-3 py-2">{s.location?.code ?? '—'}</td>
                      <td className="px-3 py-2">{COUNT_TYPE_LABEL[s.countType] ?? s.countType}</td>
                      <td className="px-3 py-2">
                        <Badge variant={s.status === 'submitted' ? 'default' : s.status === 'cancelled' ? 'destructive' : 'outline'}>
                          {s.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right">{s._count?.lines ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{dateTime(s.startedAt)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{s.submittedAt ? dateTime(s.submittedAt) : '—'}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-center gap-1">
                          {s.status === 'draft' && (
                            <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => resumeDraft(s)}>
                              <Play className="h-3 w-3" /> Continue
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => setViewSessionId(s.id)} title="View count">
                            <Eye className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
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

      {/* Save Draft Dialog */}
      <Dialog open={saveDraftOpen} onOpenChange={(o) => { if (!o) setSaveDraftOpen(false); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Save Count Draft</DialogTitle></DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <label className="text-sm font-medium">Name</label>
              <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="e.g. Inventory Count Jul 01" />
            </div>
            <div>
              <label className="text-sm font-medium">Description <span className="text-muted-foreground font-normal">(optional)</span></label>
              <textarea
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                value={draftNotes} onChange={(e) => setDraftNotes(e.target.value)}
                placeholder="Any notes about this count…"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setSaveDraftOpen(false)}>Cancel</Button>
              <Button onClick={() => { saveDraft.mutate(); setSaveDraftOpen(false); }} disabled={saveDraft.isPending || !draftName.trim()}>
                <Save className="mr-1 h-4 w-4" /> {saveDraft.isPending ? 'Saving…' : 'Save Draft'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* View Count Detail Dialog */}
      <Dialog open={!!viewSessionId} onOpenChange={(o) => { if (!o) setViewSessionId(null); }}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto p-0 gap-0">
          {viewSession.isLoading && (
            <div className="p-6"><Skeleton className="h-64 w-full" /></div>
          )}
          {viewSession.isError && (
            <div className="p-6 text-center text-destructive">Failed to load count details</div>
          )}
          {viewSession.data && (
            <>
              <div className="bg-sky-600 px-6 py-4 text-white">
                <DialogHeader>
                  <DialogTitle className="text-white text-lg flex items-center gap-2">
                    <ClipboardList className="h-5 w-5" />
                    {viewSession.data.countCode}
                  </DialogTitle>
                </DialogHeader>
                <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-white/80">
                  <span>{viewSession.data.location?.name ?? viewSession.data.location?.code ?? '—'}</span>
                  <span className="text-white/50">|</span>
                  <span>{`${COUNT_TYPE_LABEL[viewSession.data.countType] ?? viewSession.data.countType} Count`}</span>
                  <span className="text-white/50">|</span>
                  <Badge variant="secondary" className="bg-white/20 text-white border-0">
                    {viewSession.data.status}
                  </Badge>
                  <span className="text-white/50">|</span>
                  <span>{viewSession.data.lines.length} items</span>
                  <span className="text-white/50">|</span>
                  <span>Started {dateTime(viewSession.data.startedAt)}</span>
                  {viewSession.data.submittedAt && (
                    <>
                      <span className="text-white/50">|</span>
                      <span>Submitted {dateTime(viewSession.data.submittedAt)}</span>
                    </>
                  )}
                </div>
                {viewSession.data.status === 'draft' && (
                  <div className="mt-3">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="gap-1"
                      onClick={() => {
                        const d = viewSession.data!;
                        setViewSessionId(null);
                        resumeDraft(d);
                      }}
                    >
                      <Play className="h-3.5 w-3.5" /> Continue counting
                    </Button>
                  </div>
                )}
              </div>
              <div className="p-4">
                <div className="rounded-md border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-slate-50">
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Product</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-600 uppercase tracking-wider">System</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-600 uppercase tracking-wider">Actual</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-600 uppercase tracking-wider">Variance</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const lines = viewSession.data.lines;
                        const vg = new Map<string, typeof lines>();
                        const sg: typeof lines = [];
                        for (const ln of lines) {
                          if (ln.parentProductId) {
                            const pid = ln.parentProductId;
                            if (!vg.has(pid)) vg.set(pid, []);
                            vg.get(pid)!.push(ln);
                          } else {
                            sg.push(ln);
                          }
                        }
                        const sortedVg = [...vg.entries()].sort((a, b) => (a[1][0]?.parentProductName ?? '').localeCompare(b[1][0]?.parentProductName ?? ''));
                        const allRows: Array<{ type: 'parent' | 'variant'; parentName?: string; ln: typeof lines[0] }> = [];
                        for (const ln of sg) allRows.push({ type: 'variant', ln });
                        for (const [, vlines] of sortedVg) {
                          allRows.push({ type: 'parent', parentName: vlines[0]?.parentProductName ?? undefined, ln: vlines[0] });
                          for (const ln of vlines) allRows.push({ type: 'variant', ln });
                        }
                        return allRows.map((row) => {
                          if (row.type === 'parent') {
                            return (
                              <tr key={`p-${row.ln.parentProductId}`} className="border-b bg-sky-100/60">
                                <td className="px-4 py-2.5" colSpan={5}>
                                  <span className="font-semibold text-slate-700">{row.parentName}</span>
                                </td>
                              </tr>
                            );
                          }
                          const ln = row.ln;
                          const sys = Number(ln.systemQty);
                          const act = ln.countedQty !== null ? Number(ln.countedQty) : null;
                          const varVal = act !== null ? act - sys : null;
                          return (
                            <tr key={ln.id} className={`border-b last:border-0 hover:bg-sky-50/50 transition-colors ${ln.parentProductId ? 'bg-white' : ''}`}>
                              <td className={`px-4 py-2.5 ${ln.parentProductId ? 'pl-10' : ''}`}>
                                <span className={`${ln.parentProductId ? '' : 'font-medium'} text-slate-800`}>{ln.productName}</span>
                                {ln.unit && <span className="ml-1.5 text-xs text-slate-400">({ln.unit})</span>}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">{sys}</td>
                              <td className="px-4 py-2.5 text-right font-mono tabular-nums font-medium">{act !== null ? act : <span className="text-slate-300">—</span>}</td>
                              <td className={`px-4 py-2.5 text-right font-mono tabular-nums font-semibold ${varVal === null ? 'text-slate-300' : varVal === 0 ? 'text-slate-400' : varVal > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                                {varVal === null ? '—' : `${varVal > 0 ? '+' : ''}${varVal}`}
                              </td>
                              <td className="px-4 py-2.5 text-sm text-slate-500">{ln.reason ?? '—'}</td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
