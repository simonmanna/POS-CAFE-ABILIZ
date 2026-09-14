import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Plus, Trash2, Save, CheckCircle2, XCircle, Eye, RefreshCw } from 'lucide-react';
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
import { dateTime } from '@/lib/format';

import {
  type StockLevel, fetchAllStockLevels, fmtQty, apiErrorMessage as errMsg,
} from '@/features/inventory/stock-levels';

interface Location { id: string; code: string; name: string }

interface AdjustmentItem {
  id: string; productId: string; productName: string; unit: string | null;
  qtySystem: string | number; qtyActual: string | number; qtyDiff: string | number;
}
interface AdjustmentRow {
  id: string; adjCode: string; createdAt: string; reason: string; status: string; notes: string | null;
  location: { id: string; code: string; name: string } | null;
  items: AdjustmentItem[];
  approvedAt: string | null; postedAt: string | null;
}

interface DraftLine {
  key: number;
  productId: string;
  /** Counted quantity as typed; '' means not yet counted. */
  actual: string;
}

// Must match STOCK_ADJUSTMENT_REASONS in @erp/shared (API rejects anything else).
const ADJUSTMENT_REASONS = [
  { value: 'cycle_count', label: 'Cycle Count' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'expired', label: 'Expired' },
  { value: 'theft', label: 'Theft / Loss' },
  { value: 'found', label: 'Found / Surplus' },
  { value: 'initial_count', label: 'Initial Stock Count' },
  { value: 'other', label: 'Other' },
];
const REASON_LABELS = Object.fromEntries(ADJUSTMENT_REASONS.map((r) => [r.value, r.label]));

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  completed: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-red-100 text-red-700',
};
const STATUS_LABELS: Record<string, string> = { completed: 'posted' };

let lineSeq = 0;
const blankLine = (): DraftLine => ({ key: ++lineSeq, productId: '', actual: '' });

export function StockAdjustmentsPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [viewing, setViewing] = useState<AdjustmentRow | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [locationId, setLocationId] = useState('');
  const [reason, setReason] = useState('cycle_count');
  const [notes, setNotes] = useState('');
  const [responsibleId, setResponsibleId] = useState('');
  const [approvedId, setApprovedId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);

  const staffOptionsQuery = useStaffOptions();
  const staffOptions = staffOptionsQuery.data ?? [];

  const adjustments = useQuery<AdjustmentRow[]>({
    queryKey: ['stock-adjustments', statusFilter],
    queryFn: async () => {
      const qs = statusFilter === 'all' ? '' : `?status=${statusFilter}`;
      return (await api.get<AdjustmentRow[]>(`/inventory/adjustments${qs}`)).data;
    },
  });

  const locations = useQuery<Location[]>({
    queryKey: ['inventory-locations'],
    queryFn: async () => (await api.get<{ data: Location[] }>('/inventory/locations')).data.data ?? [],
  });

  const stockLevels = useQuery<StockLevel[]>({
    queryKey: ['inventory-product-stock-levels', 'adjustment', locationId],
    queryFn: () => fetchAllStockLevels(locationId),
    enabled: showForm && !!locationId,
    staleTime: 0,
  });

  const levelById = useMemo(
    () => new Map((stockLevels.data ?? []).map((s) => [s.id, s])),
    [stockLevels.data],
  );

  const productOptions = useMemo(
    () => (stockLevels.data ?? []).map((s) => ({
      value: s.id,
      label: s.name,
      code: s.code,
      hint: `On hand: ${fmtQty(s.totalQuantity)}${s.uom ? ` ${s.uom}` : ''}`,
    })),
    [stockLevels.data],
  );

  const resetForm = () => {
    setLines([blankLine()]);
    setNotes('');
    setReason('cycle_count');
    setResponsibleId('');
    setApprovedId('');
  };

  const invalidateStock = () => {
    for (const key of ['stock-adjustments', 'inventory-product-stock-levels', 'inventory-items', 'inventory-stats', 'inventory-ledger']) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const filled = lines.filter((l) => l.productId);
  const lineCounts = new Map<string, number>();
  for (const l of filled) lineCounts.set(l.productId, (lineCounts.get(l.productId) ?? 0) + 1);
  const duplicateIds = new Set([...lineCounts].filter(([, n]) => n > 1).map(([id]) => id));
  const invalidActual = filled.some((l) => l.actual.trim() === '' || !Number.isFinite(Number(l.actual)) || Number(l.actual) < 0);
  const canSubmit = !!locationId && !!responsibleId && !!approvedId && filled.length > 0 && !invalidActual && duplicateIds.size === 0 && !stockLevels.isFetching;

  const create = useMutation({
    mutationFn: async (post: boolean) => {
      const res = await api.post<AdjustmentRow>('/inventory/adjustments', {
        locationId,
        responsibleById: responsibleId,
        approvedById: approvedId,
        reason,
        notes: notes.trim() || undefined,
        items: filled.map((l) => ({
          productId: l.productId,
          qtyActual: Number(l.actual),
          unit: levelById.get(l.productId)?.uom ?? undefined,
        })),
      });
      const doc = res.data;
      if (!post) return { doc, posted: false as const };
      try {
        const approved = await api.post<AdjustmentRow>(`/inventory/adjustments/${doc.id}/approve`);
        return { doc: approved.data, posted: true as const };
      } catch (e) {
        // Document exists; it just could not post yet (approval policy / permission).
        return { doc, posted: false as const, postError: errMsg(e, 'Posting failed') };
      }
    },
    onSuccess: (r) => {
      if (r.posted) notify.success(`${r.doc.adjCode} posted — stock updated`);
      else if ('postError' in r && r.postError) notify.error(`${r.doc.adjCode} saved as pending: ${r.postError}`);
      else notify.success(`${r.doc.adjCode} saved as pending`);
      setShowForm(false);
      resetForm();
      invalidateStock();
    },
    onError: (e: any) => notify.error(errMsg(e, 'Could not save adjustment')),
  });

  const approve = useMutation({
    mutationFn: async (id: string) => (await api.post<AdjustmentRow>(`/inventory/adjustments/${id}/approve`)).data,
    onSuccess: (d) => { notify.success(`${d.adjCode} posted — stock updated`); setViewing(null); invalidateStock(); },
    onError: (e: any) => notify.error(errMsg(e, 'Posting failed')),
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => (await api.post<AdjustmentRow>(`/inventory/adjustments/${id}/cancel`)).data,
    onSuccess: (d) => { notify.success(`${d.adjCode} cancelled`); setViewing(null); qc.invalidateQueries({ queryKey: ['stock-adjustments'] }); },
    onError: (e: any) => notify.error(errMsg(e, 'Cancel failed')),
  });

  const updateLine = (key: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const pickProduct = (key: number, productId: string) => {
    const level = levelById.get(productId);
    // Pre-fill the count with the system figure so only real variances need typing.
    updateLine(key, { productId, actual: level ? String(Number(level.totalQuantity.toFixed(4))) : '' });
  };

  const isPending = (s: string) => s === 'pending' || s === 'draft';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Stock Adjustments</h1>
          <p className="text-sm text-muted-foreground">Correct stock levels, record damages, cycle counts</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="completed">Posted</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={() => { resetForm(); setShowForm(true); }}>
            <Plus className="mr-2 h-4 w-4" />New Adjustment
          </Button>
        </div>
      </div>

      {adjustments.isLoading && <Skeleton className="h-48 w-full" />}
      {adjustments.isError && (
        <Card><CardContent className="p-8 text-center text-destructive">{errMsg(adjustments.error, 'Failed to load adjustments')}</CardContent></Card>
      )}
      {adjustments.data && adjustments.data.length === 0 && (
        <Card><CardContent className="p-8 text-center text-muted-foreground">No adjustments yet. Click "New Adjustment" to create one.</CardContent></Card>
      )}
      {adjustments.data && adjustments.data.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-3 py-2 text-left">Adj #</th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Location</th>
                <th className="px-3 py-2 text-left">Reason</th>
                <th className="px-3 py-2 text-right">Items</th>
                <th className="px-3 py-2 text-right">Net Diff</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Notes</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {adjustments.data.map((adj) => {
                const net = adj.items.reduce((s, i) => s + Number(i.qtyDiff), 0);
                return (
                  <tr key={adj.id} className="border-b hover:bg-muted/30">
                    <td className="px-3 py-2 font-mono text-xs font-medium">{adj.adjCode}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{dateTime(adj.createdAt)}</td>
                    <td className="px-3 py-2">{adj.location ? `${adj.location.code} — ${adj.location.name}` : '—'}</td>
                    <td className="px-3 py-2"><Badge variant="outline" className="text-xs">{REASON_LABELS[adj.reason] ?? adj.reason}</Badge></td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{adj.items.length}</td>
                    <td className={`px-3 py-2 text-right font-mono tabular-nums ${net > 0 ? 'text-emerald-600' : net < 0 ? 'text-destructive' : ''}`}>
                      {net > 0 ? '+' : ''}{fmtQty(net)}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex px-2.5 py-0.5 rounded text-xs font-semibold ${STATUS_COLORS[adj.status] ?? 'bg-gray-100 text-gray-700'}`}>
                        {STATUS_LABELS[adj.status] ?? adj.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 max-w-48 truncate text-muted-foreground">{adj.notes ?? '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" className="h-7 w-7" title="View" onClick={() => setViewing(adj)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        {isPending(adj.status) && (
                          <>
                            <Button size="icon" variant="ghost" className="h-7 w-7" title="Approve & post"
                              disabled={approve.isPending} onClick={() => approve.mutate(adj.id)}>
                              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7" title="Cancel"
                              disabled={cancel.isPending}
                              onClick={() => { if (window.confirm(`Cancel ${adj.adjCode}?`)) cancel.mutate(adj.id); }}>
                              <XCircle className="h-4 w-4 text-destructive" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Adjustment Dialog */}
      <Dialog open={showForm} onOpenChange={(o) => { if (!create.isPending) setShowForm(o); }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>New Stock Adjustment</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Location <span className="text-destructive">*</span></label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger>
                  <SelectContent>
                    {locations.data?.map((l) => (
                      <SelectItem key={l.id} value={l.id}>{l.code} — {l.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">Reason</label>
                <Select value={reason} onValueChange={setReason}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ADJUSTMENT_REASONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
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
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" disabled={!locationId || stockLevels.isFetching}
                    onClick={() => stockLevels.refetch()} title="Reload system quantities">
                    <RefreshCw className={`mr-1 h-3 w-3 ${stockLevels.isFetching ? 'animate-spin' : ''}`} />Refresh
                  </Button>
                  <Button size="sm" variant="outline" disabled={!locationId} onClick={() => setLines((p) => [...p, blankLine()])}>
                    <Plus className="mr-1 h-3 w-3" />Add Item
                  </Button>
                </div>
              </div>

              {!locationId ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  Select a location first — system quantities are per location.
                </div>
              ) : stockLevels.isError ? (
                <div className="rounded-md border p-6 text-center text-sm text-destructive">
                  {errMsg(stockLevels.error, 'Failed to load stock levels')}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-2 py-1.5 text-left">Product</th>
                        <th className="w-28 px-2 py-1.5 text-right">System</th>
                        <th className="w-32 px-2 py-1.5 text-right">Actual</th>
                        <th className="w-24 px-2 py-1.5 text-right">Diff</th>
                        <th className="w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((ln) => {
                        const level = ln.productId ? levelById.get(ln.productId) : undefined;
                        const system = level?.totalQuantity ?? 0;
                        const actualNum = Number(ln.actual);
                        const hasActual = ln.productId && ln.actual.trim() !== '' && Number.isFinite(actualNum);
                        const diff = hasActual ? actualNum - system : 0;
                        const dup = duplicateIds.has(ln.productId);
                        return (
                          <tr key={ln.key} className="border-b align-middle last:border-0">
                            <td className="px-2 py-1.5">
                              <SearchableSelect
                                value={ln.productId}
                                onValueChange={(v) => pickProduct(ln.key, v)}
                                options={productOptions}
                                placeholder={stockLevels.isLoading ? 'Loading products…' : 'Select product…'}
                                searchPlaceholder="Search products…"
                                emptyText="No products match"
                                disabled={stockLevels.isLoading}
                              />
                              {dup && <p className="mt-1 text-xs text-destructive">Product already on another line</p>}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                              {ln.productId
                                ? stockLevels.isFetching && !level ? '…' : <>{fmtQty(system)}{level?.uom ? <span className="ml-1 text-xs">{level.uom}</span> : null}</>
                                : '—'}
                            </td>
                            <td className="px-2 py-1.5">
                              <Input
                                type="number" min="0" step="any" inputMode="decimal"
                                className="h-8 text-right tabular-nums"
                                disabled={!ln.productId}
                                value={ln.actual}
                                onChange={(e) => updateLine(ln.key, { actual: e.target.value })}
                              />
                            </td>
                            <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${
                              diff > 0 ? 'text-emerald-600' : diff < 0 ? 'text-destructive' : ''
                            }`}>
                              {hasActual ? `${diff > 0 ? '+' : ''}${fmtQty(diff)}` : '—'}
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
                  </table>
                </div>
              )}
              {invalidActual && <p className="text-xs text-destructive">Every selected product needs a counted quantity of 0 or more.</p>}
            </div>

            <div>
              <label className="text-sm font-medium">Notes</label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional adjustment notes" />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={create.isPending} onClick={() => setShowForm(false)}>Cancel</Button>
            <Button variant="secondary" disabled={!canSubmit || create.isPending} onClick={() => create.mutate(false)}>
              <Save className="mr-2 h-4 w-4" />Save as Pending
            </Button>
            <Button disabled={!canSubmit || create.isPending} onClick={() => create.mutate(true)}>
              <CheckCircle2 className="mr-2 h-4 w-4" />{create.isPending ? 'Saving…' : 'Post Adjustment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Adjustment Dialog */}
      <Dialog open={!!viewing} onOpenChange={(o) => { if (!o) setViewing(null); }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl max-h-[90vh] overflow-y-auto">
          {viewing && (
            <>
              <DialogHeader><DialogTitle>{viewing.adjCode}</DialogTitle></DialogHeader>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-muted-foreground">Location: </span>{viewing.location ? `${viewing.location.code} — ${viewing.location.name}` : '—'}</div>
                <div><span className="text-muted-foreground">Reason: </span>{REASON_LABELS[viewing.reason] ?? viewing.reason}</div>
                <div><span className="text-muted-foreground">Created: </span>{dateTime(viewing.createdAt)}</div>
                <div><span className="text-muted-foreground">Status: </span>{STATUS_LABELS[viewing.status] ?? viewing.status}</div>
                {viewing.postedAt && <div><span className="text-muted-foreground">Posted: </span>{dateTime(viewing.postedAt)}</div>}
                {viewing.notes && <div className="col-span-2"><span className="text-muted-foreground">Notes: </span>{viewing.notes}</div>}
              </div>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-2 py-1.5 text-left">Product</th>
                      <th className="px-2 py-1.5 text-right">System</th>
                      <th className="px-2 py-1.5 text-right">Actual</th>
                      <th className="px-2 py-1.5 text-right">Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewing.items.map((i) => {
                      const d = Number(i.qtyDiff);
                      return (
                        <tr key={i.id} className="border-b last:border-0">
                          <td className="px-2 py-1.5">{i.productName}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtQty(Number(i.qtySystem))}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtQty(Number(i.qtyActual))}</td>
                          <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${d > 0 ? 'text-emerald-600' : d < 0 ? 'text-destructive' : ''}`}>
                            {d > 0 ? '+' : ''}{fmtQty(d)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {isPending(viewing.status) && (
                <p className="text-xs text-muted-foreground">
                  System figures are a snapshot from when this was saved. Posting counts each product to its Actual quantity at the current on-hand.
                </p>
              )}
              <DialogFooter className="gap-2">
                {isPending(viewing.status) && (
                  <>
                    <Button variant="outline" disabled={cancel.isPending}
                      onClick={() => { if (window.confirm(`Cancel ${viewing.adjCode}?`)) cancel.mutate(viewing.id); }}>
                      <XCircle className="mr-2 h-4 w-4" />Cancel Adjustment
                    </Button>
                    <Button disabled={approve.isPending} onClick={() => approve.mutate(viewing.id)}>
                      <CheckCircle2 className="mr-2 h-4 w-4" />{approve.isPending ? 'Posting…' : 'Approve & Post'}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
