import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Plus, Trash2, Save, CheckCircle2, XCircle, Eye, AlertTriangle, PackageX, Clock, CalendarX, BookOpen,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useStaffOptions } from '@/features/inventory/staff-options';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { dateTime, formatMoney } from '@/lib/format';
import { useAuthStore } from '@/stores/auth.store';
import {
  type StockLevel, fetchAllStockLevels, fmtQty, apiErrorMessage as errMsg,
} from '@/features/inventory/stock-levels';

interface Location { id: string; code: string; name: string }

interface WasteItem {
  id: string; productId: string; productName: string; unit: string | null;
  qty: string | number; unitCost: string | number; totalCost: string | number;
  batchNumber: string | null; isExpiry: boolean;
}
interface WasteRow {
  id: string; wasteCode: string; createdAt: string; category: string; status: string; notes: string | null;
  totalValue: string | number; postedAt: string | null; approvedAt: string | null;
  location: { id: string; code: string; name: string } | null;
  items: WasteItem[];
}
interface WasteDetail extends WasteRow {
  journalEntries: {
    id: string; entryNumber: string; postingDate: string; status: string; description: string | null;
    lines: { debit: string | number; credit: string | number; account: { code: string; name: string } }[];
  }[];
  ledger: { id: string; ledgerCode: string; quantityChange: string | number; totalValue: string | number }[];
}
interface WasteSummary {
  postedRecords: number; totalValue: number; expiryValue: number;
  pendingRecords: number; pendingValue: number;
  byCategory: { category: string; records: number; value: number }[];
  byLocation: { locationId: string; code: string; name: string; records: number; value: number }[];
  topProducts: { productId: string; productName: string; unit: string | null; qty: number; value: number; lines: number }[];
}

interface DraftLine {
  key: number;
  productId: string;
  qty: string;
  batchNumber: string;
  isExpiry: boolean;
}

// Must match WASTE_CATEGORIES in @erp/shared.
const CATEGORIES = [
  { value: 'breakage', label: 'Damaged / Breakage' },
  { value: 'spoiled', label: 'Spoiled' },
  { value: 'expired', label: 'Expired' },
  { value: 'burnt', label: 'Burnt / Kitchen Error' },
  { value: 'contaminated', label: 'Contaminated' },
  { value: 'overmixed', label: 'Production: Overmixed' },
  { value: 'packaging_defect', label: 'Production: Packaging Defect' },
  { value: 'qc_rejection', label: 'Production: QC Rejection' },
  { value: 'other', label: 'Other' },
];
const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-sky-100 text-sky-700',
  completed: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-red-100 text-red-700',
};
const STATUS_LABELS: Record<string, string> = { completed: 'posted' };
const isPending = (s: string) => s === 'pending' || s === 'draft';

const toIsoDate = (d: Date) => {
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
};
const monthStart = () => { const d = new Date(); return toIsoDate(new Date(d.getFullYear(), d.getMonth(), 1)); };

let lineSeq = 0;
const blankLine = (): DraftLine => ({ key: ++lineSeq, productId: '', qty: '', batchNumber: '', isExpiry: false });

export function WastePage() {
  const qc = useQueryClient();
  const has = useAuthStore((s) => s.hasPermission);
  const canCreate = has('inventory_doc:create');
  const canApprove = has('inventory_doc:approve');
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState<'records' | 'summary'>('records');
  const [status, setStatus] = useState('all');
  const [category, setCategory] = useState('all');
  const [filterLoc, setFilterLoc] = useState('all');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(toIsoDate(new Date()));

  const [showForm, setShowForm] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState('');
  const [formCategory, setFormCategory] = useState('breakage');
  const [notes, setNotes] = useState('');
  const [responsibleId, setResponsibleId] = useState('');
  const [approvedId, setApprovedId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);

  const staffOptionsQuery = useStaffOptions();
  const staffOptions = staffOptionsQuery.data ?? [];

  const filterParams = useMemo(() => {
    const p = new URLSearchParams();
    if (category !== 'all') p.set('category', category);
    if (filterLoc !== 'all') p.set('locationId', filterLoc);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p;
  }, [category, filterLoc, from, to]);

  const records = useQuery<WasteRow[]>({
    queryKey: ['inventory-waste', status, filterParams.toString()],
    queryFn: async () => {
      const p = new URLSearchParams(filterParams);
      if (status !== 'all') p.set('status', status);
      return (await api.get<WasteRow[]>(`/inventory/waste?${p.toString()}`)).data;
    },
  });

  const summary = useQuery<WasteSummary>({
    queryKey: ['inventory-waste-summary', filterParams.toString()],
    queryFn: async () => (await api.get<WasteSummary>(`/inventory/waste/summary?${filterParams.toString()}`)).data,
  });

  const locations = useQuery<Location[]>({
    queryKey: ['inventory-locations'],
    queryFn: async () => (await api.get<{ data: Location[] }>('/inventory/locations')).data.data ?? [],
  });

  const stockLevels = useQuery<StockLevel[]>({
    queryKey: ['inventory-product-stock-levels', 'waste', locationId],
    queryFn: () => fetchAllStockLevels(locationId),
    enabled: showForm && !!locationId,
    staleTime: 0,
  });
  const levelById = useMemo(() => new Map((stockLevels.data ?? []).map((s) => [s.id, s])), [stockLevels.data]);
  const productOptions = useMemo(
    () => (stockLevels.data ?? []).map((s) => ({
      value: s.id, label: s.name, code: s.code,
      hint: `On hand: ${fmtQty(s.totalQuantity)}${s.uom ? ` ${s.uom}` : ''}`,
    })),
    [stockLevels.data],
  );

  const detail = useQuery<WasteDetail>({
    queryKey: ['inventory-waste', 'detail', viewingId],
    queryFn: async () => (await api.get<WasteDetail>(`/inventory/waste/${viewingId}`)).data,
    enabled: !!viewingId,
  });

  // Deep link from the GL / stock ledger: /inventory/waste?code=WST-00012
  const codeParam = searchParams.get('code');
  useEffect(() => {
    if (!codeParam) return;
    let cancelled = false;
    (async () => {
      const list = (await api.get<WasteRow[]>('/inventory/waste')).data;
      const hit = list.find((r) => r.wasteCode === codeParam);
      if (cancelled) return;
      if (hit) setViewingId(hit.id); else notify.error(`${codeParam} not found`);
      setSearchParams((p) => { p.delete('code'); return p; }, { replace: true });
    })().catch((e) => notify.error(errMsg(e, 'Could not open record')));
    return () => { cancelled = true; };
  }, [codeParam, setSearchParams]);

  const invalidate = () => {
    for (const key of ['inventory-waste', 'inventory-waste-summary', 'inventory-product-stock-levels', 'inventory-items', 'inventory-stats', 'inventory-ledger']) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const resetForm = () => { setLines([blankLine()]); setNotes(''); setFormCategory('breakage'); setResponsibleId(''); setApprovedId(''); };

  const filled = lines.filter((l) => l.productId);
  const badQty = filled.some((l) => !(Number(l.qty) > 0));
  const missingBatch = filled.some((l) => levelById.get(l.productId)?.batchTracking && !l.batchNumber.trim());
  const canSubmit = !!locationId && !!responsibleId && !!approvedId && filled.length > 0 && !badQty && !stockLevels.isFetching;
  const estTotal = filled.reduce((s, l) => s + (Number(l.qty) || 0) * (levelById.get(l.productId)?.averageCost ?? 0), 0);

  const create = useMutation({
    mutationFn: async (post: boolean) => {
      const doc = (await api.post<WasteRow>('/inventory/waste', {
        locationId,
        responsibleById: responsibleId,
        approvedById: approvedId,
        category: formCategory,
        notes: notes.trim() || undefined,
        items: filled.map((l) => ({
          productId: l.productId,
          qty: Number(l.qty),
          unit: levelById.get(l.productId)?.uom ?? undefined,
          ...(l.batchNumber.trim() ? { batchNumber: l.batchNumber.trim() } : {}),
          isExpiry: l.isExpiry,
        })),
      })).data;
      if (!post) return { doc, posted: false as const };
      try {
        return { doc: (await api.post<WasteRow>(`/inventory/waste/${doc.id}/approve`)).data, posted: true as const };
      } catch (e) {
        return { doc, posted: false as const, postError: errMsg(e, 'Posting failed') };
      }
    },
    onSuccess: (r) => {
      if (r.posted) notify.success(`${r.doc.wasteCode} posted — stock written off (${formatMoney(Number(r.doc.totalValue))})`);
      else if ('postError' in r && r.postError) notify.error(`${r.doc.wasteCode} saved as pending: ${r.postError}`);
      else notify.success(`${r.doc.wasteCode} saved as pending`);
      setShowForm(false);
      resetForm();
      invalidate();
    },
    onError: (e: any) => notify.error(errMsg(e, 'Could not save record')),
  });

  const approve = useMutation({
    mutationFn: async (id: string) => (await api.post<WasteRow>(`/inventory/waste/${id}/approve`)).data,
    onSuccess: (d) => { notify.success(`${d.wasteCode} posted — stock written off`); invalidate(); },
    onError: (e: any) => notify.error(errMsg(e, 'Posting failed')),
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => (await api.post<WasteRow>(`/inventory/waste/${id}/cancel`)).data,
    onSuccess: (d) => { notify.success(`${d.wasteCode} cancelled`); invalidate(); },
    onError: (e: any) => notify.error(errMsg(e, 'Cancel failed')),
  });

  const updateLine = (key: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const changeFormCategory = (v: string) => {
    setFormCategory(v);
    // Expired goods post EXPIRY_WRITE_OFF; keep line flags in step with the category.
    setLines((prev) => prev.map((l) => ({ ...l, isExpiry: v === 'expired' })));
  };

  const confirmCancel = (id: string, code: string) => {
    if (window.confirm(`Cancel ${code}? Stock will not be affected.`)) cancel.mutate(id);
  };

  const maxCategoryValue = Math.max(1, ...(summary.data?.byCategory.map((c) => c.value) ?? [1]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Damages &amp; Waste</h1>
          <p className="text-sm text-muted-foreground">
            Register damaged, spoiled and expired stock. Posting removes it from inventory and books the loss to the ledger.
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => { resetForm(); setShowForm(true); }}>
            <Plus className="mr-2 h-4 w-4" />Register Damage / Waste
          </Button>
        )}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { icon: PackageX, label: 'Posted loss', value: summary.data ? formatMoney(summary.data.totalValue) : null, tone: 'text-destructive' },
          { icon: CheckCircle2, label: 'Posted records', value: summary.data ? String(summary.data.postedRecords) : null, tone: '' },
          { icon: Clock, label: 'Pending approval', value: summary.data ? `${summary.data.pendingRecords} · ${formatMoney(summary.data.pendingValue)}` : null, tone: 'text-amber-600' },
          { icon: CalendarX, label: 'Expiry write-offs', value: summary.data ? formatMoney(summary.data.expiryValue) : null, tone: '' },
        ].map((k) => (
          <Card key={k.label}>
            <CardContent className="flex items-center gap-3 p-4">
              <k.icon className="h-8 w-8 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{k.label}</p>
                {k.value === null ? <Skeleton className="mt-1 h-6 w-20" /> : <p className={`truncate text-lg font-semibold tabular-nums ${k.tone}`}>{k.value}</p>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex rounded-md border p-0.5">
          {(['records', 'summary'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={`rounded px-3 py-1.5 text-sm capitalize ${tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>
              {t}
            </button>
          ))}
        </div>
        {tab === 'records' && (
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="completed">Posted</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterLoc} onValueChange={setFilterLoc}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All locations</SelectItem>
            {locations.data?.map((l) => <SelectItem key={l.id} value={l.id}>{l.code} — {l.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" className="w-40" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <Input type="date" className="w-40" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To" />
      </div>

      {tab === 'records' && (
        <>
          {records.isLoading && <Skeleton className="h-48 w-full" />}
          {records.isError && (
            <Card><CardContent className="p-8 text-center text-destructive">{errMsg(records.error, 'Failed to load records')}</CardContent></Card>
          )}
          {records.data && records.data.length === 0 && (
            <Card><CardContent className="p-8 text-center text-muted-foreground">No damages or waste recorded for these filters.</CardContent></Card>
          )}
          {records.data && records.data.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left">Ref #</th>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Location</th>
                    <th className="px-3 py-2 text-left">Category</th>
                    <th className="px-3 py-2 text-left">Items</th>
                    <th className="px-3 py-2 text-right">Value</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {records.data.map((r) => (
                    <tr key={r.id} className="border-b hover:bg-muted/30">
                      <td className="px-3 py-2 font-mono text-xs font-medium">{r.wasteCode}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{dateTime(r.createdAt)}</td>
                      <td className="px-3 py-2">{r.location ? `${r.location.code} — ${r.location.name}` : '—'}</td>
                      <td className="px-3 py-2"><Badge variant="outline" className="text-xs">{CATEGORY_LABELS[r.category] ?? r.category}</Badge></td>
                      <td className="px-3 py-2 max-w-64 truncate text-muted-foreground" title={r.items.map((i) => i.productName).join(', ')}>
                        {r.items.length === 1 ? `${r.items[0].productName} × ${fmtQty(Number(r.items[0].qty))}` : `${r.items.length} items`}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {formatMoney(Number(r.totalValue))}
                        {isPending(r.status) && <span className="ml-1 text-[10px] text-muted-foreground">est.</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex rounded px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLORS[r.status] ?? 'bg-gray-100 text-gray-700'}`}>
                          {STATUS_LABELS[r.status] ?? r.status}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" className="h-7 w-7" title="View" onClick={() => setViewingId(r.id)}>
                            <Eye className="h-4 w-4" />
                          </Button>
                          {canApprove && isPending(r.status) && (
                            <>
                              <Button size="icon" variant="ghost" className="h-7 w-7" title="Approve & post"
                                disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>
                                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-7 w-7" title="Cancel"
                                disabled={cancel.isPending} onClick={() => confirmCancel(r.id, r.wasteCode)}>
                                <XCircle className="h-4 w-4 text-destructive" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'summary' && (
        summary.isLoading ? <Skeleton className="h-64 w-full" /> : summary.data && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="space-y-3 p-4">
                <h2 className="font-semibold">Loss by category</h2>
                {summary.data.byCategory.length === 0 && <p className="text-sm text-muted-foreground">No posted records in this period.</p>}
                {summary.data.byCategory.map((c) => (
                  <div key={c.category} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span>{CATEGORY_LABELS[c.category] ?? c.category} <span className="text-muted-foreground">({c.records})</span></span>
                      <span className="font-mono tabular-nums">{formatMoney(c.value)}</span>
                    </div>
                    <div className="h-2 rounded bg-muted">
                      <div className="h-2 rounded bg-destructive/70" style={{ width: `${(c.value / maxCategoryValue) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-3 p-4">
                <h2 className="font-semibold">Loss by location</h2>
                {summary.data.byLocation.length === 0 && <p className="text-sm text-muted-foreground">No posted records in this period.</p>}
                <table className="w-full text-sm">
                  <tbody>
                    {summary.data.byLocation.map((l) => (
                      <tr key={l.locationId} className="border-b last:border-0">
                        <td className="py-1.5">{l.code} — {l.name}</td>
                        <td className="py-1.5 text-right text-muted-foreground">{l.records}</td>
                        <td className="py-1.5 text-right font-mono tabular-nums">{formatMoney(l.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardContent className="space-y-3 p-4">
                <h2 className="font-semibold">Top wasted products</h2>
                {summary.data.topProducts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No posted records in this period.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="py-1.5">Product</th>
                          <th className="py-1.5 text-right">Times</th>
                          <th className="py-1.5 text-right">Qty</th>
                          <th className="py-1.5 text-right">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.data.topProducts.map((p) => (
                          <tr key={p.productId} className="border-b last:border-0">
                            <td className="py-1.5">{p.productName}</td>
                            <td className="py-1.5 text-right tabular-nums">{p.lines}</td>
                            <td className="py-1.5 text-right font-mono tabular-nums">{fmtQty(p.qty)}{p.unit ? ` ${p.unit}` : ''}</td>
                            <td className="py-1.5 text-right font-mono tabular-nums">{formatMoney(p.value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )
      )}

      {/* Register dialog */}
      <Dialog open={showForm} onOpenChange={(o) => { if (!create.isPending) setShowForm(o); }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Register Damage / Waste</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Location <span className="text-destructive">*</span></label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger>
                  <SelectContent>
                    {locations.data?.map((l) => <SelectItem key={l.id} value={l.id}>{l.code} — {l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">Category</label>
                <Select value={formCategory} onValueChange={changeFormCategory}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Responsible Person <span className="text-destructive">*</span></label>
                <SearchableSelect
                  value={responsibleId}
                  onValueChange={setResponsibleId}
                  options={staffOptions}
                  placeholder="Select staff…"
                  searchPlaceholder="Search staff…"
                  emptyText="No staff match"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Approved By <span className="text-destructive">*</span></label>
                <SearchableSelect
                  value={approvedId}
                  onValueChange={setApprovedId}
                  options={staffOptions}
                  placeholder="Select staff…"
                  searchPlaceholder="Search staff…"
                  emptyText="No staff match"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Items</label>
                <Button size="sm" variant="outline" disabled={!locationId} onClick={() => setLines((p) => [...p, { ...blankLine(), isExpiry: formCategory === 'expired' }])}>
                  <Plus className="mr-1 h-3 w-3" />Add Item
                </Button>
              </div>
              {!locationId ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  Select the location the stock is written off from.
                </div>
              ) : stockLevels.isError ? (
                <div className="rounded-md border p-6 text-center text-sm text-destructive">{errMsg(stockLevels.error, 'Failed to load stock levels')}</div>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-2 py-1.5 text-left">Product</th>
                        <th className="w-24 px-2 py-1.5 text-right">On hand</th>
                        <th className="w-28 px-2 py-1.5 text-right">Qty lost</th>
                        <th className="w-32 px-2 py-1.5 text-left">Batch #</th>
                        <th className="w-20 px-2 py-1.5 text-center" title="Post as expiry write-off">Expiry</th>
                        <th className="w-28 px-2 py-1.5 text-right">Est. value</th>
                        <th className="w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((ln) => {
                        const level = ln.productId ? levelById.get(ln.productId) : undefined;
                        const qty = Number(ln.qty) || 0;
                        const over = level && qty > level.totalQuantity;
                        return (
                          <tr key={ln.key} className="border-b align-top last:border-0">
                            <td className="px-2 py-1.5">
                              <SearchableSelect
                                value={ln.productId}
                                onValueChange={(v) => updateLine(ln.key, { productId: v })}
                                options={productOptions}
                                placeholder={stockLevels.isLoading ? 'Loading products…' : 'Select product…'}
                                searchPlaceholder="Search products…"
                                emptyText="No products match"
                                disabled={stockLevels.isLoading}
                              />
                            </td>
                            <td className="px-2 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                              {level ? <>{fmtQty(level.totalQuantity)}{level.uom ? <span className="ml-1 text-xs">{level.uom}</span> : null}</> : '—'}
                            </td>
                            <td className="px-2 py-1.5">
                              <Input type="number" min="0" step="any" inputMode="decimal" className="h-8 text-right tabular-nums"
                                disabled={!ln.productId} value={ln.qty} onChange={(e) => updateLine(ln.key, { qty: e.target.value })} />
                              {over && (
                                <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-600">
                                  <AlertTriangle className="h-3 w-3" />More than on hand
                                </p>
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              <Input className="h-8" placeholder={level?.batchTracking ? 'Required' : 'Optional'}
                                disabled={!ln.productId} value={ln.batchNumber} onChange={(e) => updateLine(ln.key, { batchNumber: e.target.value })} />
                            </td>
                            <td className="px-2 py-2.5 text-center">
                              <input type="checkbox" className="h-4 w-4" disabled={!ln.productId}
                                checked={ln.isExpiry} onChange={(e) => updateLine(ln.key, { isExpiry: e.target.checked })} />
                            </td>
                            <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                              {level && qty > 0 ? formatMoney(qty * level.averageCost) : '—'}
                            </td>
                            <td className="px-2 py-1.5">
                              <Button size="icon" variant="ghost" className="h-7 w-7"
                                onClick={() => setLines((p) => (p.length > 1 ? p.filter((l) => l.key !== ln.key) : [blankLine()]))}>
                                <Trash2 className="h-3.5 w-3.5 text-destructive" />
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {filled.length > 0 && (
                      <tfoot>
                        <tr className="bg-muted/30">
                          <td colSpan={5} className="px-2 py-2 text-right text-sm font-medium">Estimated loss</td>
                          <td className="px-2 py-2 text-right font-mono font-semibold tabular-nums text-destructive">{formatMoney(estTotal)}</td>
                          <td />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
              {badQty && <p className="text-xs text-destructive">Every selected product needs a quantity greater than 0.</p>}
              {missingBatch && <p className="text-xs text-amber-600">Batch-tracked products without a batch # are taken earliest-expiry first (FEFO).</p>}
            </div>

            <div>
              <label className="text-sm font-medium">Notes</label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What happened? e.g. dropped crate, fridge failure" />
            </div>
            <p className="text-xs text-muted-foreground">
              Posting removes the stock at its current cost and books Dr Waste/Expiry expense · Cr Stock Valuation
              (accounts configurable under Posting Rules).
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={create.isPending} onClick={() => setShowForm(false)}>Cancel</Button>
            <Button variant="secondary" disabled={!canSubmit || create.isPending} onClick={() => create.mutate(false)}>
              <Save className="mr-2 h-4 w-4" />Save as Pending
            </Button>
            {canApprove && (
              <Button disabled={!canSubmit || create.isPending} onClick={() => create.mutate(true)}>
                <CheckCircle2 className="mr-2 h-4 w-4" />{create.isPending ? 'Saving…' : 'Post Write-off'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <Dialog open={!!viewingId} onOpenChange={(o) => { if (!o) setViewingId(null); }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-3xl max-h-[90vh] overflow-y-auto">
          {detail.isLoading && <Skeleton className="h-64 w-full" />}
          {detail.isError && <p className="text-destructive">{errMsg(detail.error, 'Failed to load record')}</p>}
          {detail.data && (() => {
            const d = detail.data;
            return (
              <>
                <DialogHeader><DialogTitle>{d.wasteCode}</DialogTitle></DialogHeader>
                <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <div><span className="text-muted-foreground">Location: </span>{d.location ? `${d.location.code} — ${d.location.name}` : '—'}</div>
                  <div><span className="text-muted-foreground">Category: </span>{CATEGORY_LABELS[d.category] ?? d.category}</div>
                  <div><span className="text-muted-foreground">Registered: </span>{dateTime(d.createdAt)}</div>
                  <div><span className="text-muted-foreground">Status: </span>{STATUS_LABELS[d.status] ?? d.status}</div>
                  {d.postedAt && <div><span className="text-muted-foreground">Posted: </span>{dateTime(d.postedAt)}</div>}
                  <div><span className="text-muted-foreground">{isPending(d.status) ? 'Estimated value: ' : 'Value: '}</span><span className="font-semibold">{formatMoney(Number(d.totalValue))}</span></div>
                  {d.notes && <div className="sm:col-span-2"><span className="text-muted-foreground">Notes: </span>{d.notes}</div>}
                </div>

                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-2 py-1.5 text-left">Product</th>
                        <th className="px-2 py-1.5 text-right">Qty</th>
                        <th className="px-2 py-1.5 text-left">Batch</th>
                        <th className="px-2 py-1.5 text-right">Unit cost</th>
                        <th className="px-2 py-1.5 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.items.map((i) => (
                        <tr key={i.id} className="border-b last:border-0">
                          <td className="px-2 py-1.5">
                            {i.productName}
                            {i.isExpiry && <Badge variant="outline" className="ml-2 text-[10px]">expiry</Badge>}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtQty(Number(i.qty))}{i.unit ? ` ${i.unit}` : ''}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{i.batchNumber ?? '—'}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatMoney(Number(i.unitCost))}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatMoney(Number(i.totalCost))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {d.postedAt && (
                  <div className="space-y-2">
                    <h3 className="flex items-center gap-2 text-sm font-semibold"><BookOpen className="h-4 w-4" />Accounting</h3>
                    {d.journalEntries.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No journal entry — the stock had zero cost, so there was no value to book.</p>
                    ) : d.journalEntries.map((je) => (
                      <div key={je.id} className="rounded-md border">
                        <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5 text-sm">
                          <Link to={`/journal-entries/${je.id}`} className="font-mono text-primary hover:underline">{je.entryNumber}</Link>
                          <span className="text-muted-foreground">{je.status}</span>
                        </div>
                        <table className="w-full text-sm">
                          <tbody>
                            {je.lines.map((l, idx) => (
                              <tr key={idx} className="border-b last:border-0">
                                <td className="px-3 py-1">{l.account.code} — {l.account.name}</td>
                                <td className="w-28 px-3 py-1 text-right font-mono tabular-nums">{Number(l.debit) ? formatMoney(Number(l.debit)) : ''}</td>
                                <td className="w-28 px-3 py-1 text-right font-mono tabular-nums">{Number(l.credit) ? formatMoney(Number(l.credit)) : ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      {d.ledger.length} stock ledger movement{d.ledger.length === 1 ? '' : 's'} ·{' '}
                      <Link to="/inventory/ledger" className="text-primary hover:underline">Stock Ledger</Link>
                    </p>
                  </div>
                )}

                <DialogFooter className="gap-2">
                  {canApprove && isPending(d.status) && (
                    <>
                      <Button variant="outline" disabled={cancel.isPending} onClick={() => confirmCancel(d.id, d.wasteCode)}>
                        <XCircle className="mr-2 h-4 w-4" />Cancel Record
                      </Button>
                      <Button disabled={approve.isPending} onClick={() => approve.mutate(d.id)}>
                        <CheckCircle2 className="mr-2 h-4 w-4" />{approve.isPending ? 'Posting…' : 'Approve & Post'}
                      </Button>
                    </>
                  )}
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
