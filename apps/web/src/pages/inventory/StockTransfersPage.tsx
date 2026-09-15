import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus, Trash2, Save, Undo2, Truck, PackageCheck, CornerUpLeft, X } from 'lucide-react';
import { ReasonDialog } from '@/features/inventory/reason-dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useStaffOptions } from '@/features/inventory/staff-options';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import {
  useTransfers, useCreateTransfer, useApproveTransfer, useReverseTransfer,
  useDispatchTransfer, useReceiveTransfer, useRecallTransfer, useCancelTransfer,
  type StockTransfer,
} from '@/features/inventory/transfers-api';
import { useAuthStore } from '@/stores/auth.store';

interface Location { id: string; code: string; name: string; type?: string }
interface Product { id: string; code: string; name: string }

interface TransferLine {
  productId: string;
  productName: string;
  quantity: number;
  distStrategy: string;
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  pending: 'bg-amber-100 text-amber-700',
  completed: 'bg-green-100 text-green-700',
  approved: 'bg-blue-100 text-blue-700',
  in_transit: 'bg-indigo-100 text-indigo-700',
  partially_received: 'bg-orange-100 text-orange-700',
  cancelled: 'bg-red-100 text-red-700',
  reversed: 'bg-slate-200 text-slate-700',
};

const STATUS_LABEL: Record<string, string> = {
  in_transit: 'in transit',
  partially_received: 'partially received',
};

const num = (v: unknown) => Number(v ?? 0);
const outstanding = (it: StockTransfer['items'][number]) =>
  num(it.qtyDispatched) - num(it.qtyReceived) - num(it.qtyDamaged) - num(it.qtyShort) - num(it.qtyRecalled);

type ReceiveRow = { itemId: string; productName: string; open: number; received: string; damaged: string; short: string };

export function StockTransfersPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [fromLocId, setFromLocId] = useState('');
  const [toLocId, setToLocId] = useState('');
  const [notes, setNotes] = useState('');
  const [mode, setMode] = useState<'immediate' | 'transit'>('immediate');
  const [responsibleId, setResponsibleId] = useState('');
  const [approvedId, setApprovedId] = useState('');
  const [lines, setLines] = useState<TransferLine[]>([
    { productId: '', productName: '', quantity: 1, distStrategy: 'FEFO' },
  ]);

  const { data: transfers, isLoading } = useTransfers();
  const createTransfer = useCreateTransfer();
  const approveTransfer = useApproveTransfer();
  const reverseTransfer = useReverseTransfer();
  const [reversing, setReversing] = useState<{ id: string; code: string } | null>(null);
  const dispatchTransfer = useDispatchTransfer();
  const receiveTransfer = useReceiveTransfer();
  const recallTransfer = useRecallTransfer();
  const cancelTransfer = useCancelTransfer();
  const [recalling, setRecalling] = useState<{ id: string; code: string } | null>(null);
  const [receiving, setReceiving] = useState<{ id: string; code: string; rows: ReceiveRow[] } | null>(null);
  const [receiveNotes, setReceiveNotes] = useState('');
  const has = useAuthStore((s) => s.hasPermission);
  const canCreate = has('inventory_doc:create');
  const canApprove = has('inventory_doc:approve');
  const canMove = has('inventory_doc:update');

  const openReceive = (tr: StockTransfer) => {
    setReceiveNotes('');
    setReceiving({
      id: tr.id,
      code: tr.transferCode,
      rows: tr.items
        .map((it) => ({ itemId: it.id, productName: it.productName, open: outstanding(it), received: '', damaged: '', short: '' }))
        .filter((r) => r.open > 0)
        .map((r) => ({ ...r, received: String(r.open) })),
    });
  };
  const receiveInvalid = receiving?.rows.some((r) => {
    const total = num(r.received) + num(r.damaged) + num(r.short);
    return [r.received, r.damaged, r.short].some((v) => num(v) < 0) || total > r.open + 1e-6;
  }) ?? false;
  const receiveEmpty = receiving ? receiving.rows.every((r) => num(r.received) + num(r.damaged) + num(r.short) === 0) : true;

  const staffOptionsQuery = useStaffOptions();
  const staffOptions = staffOptionsQuery.data ?? [];

  const products = useQuery<Product[]>({
    queryKey: ['products'],
    queryFn: async () => {
      const res = await api.get<{ data: Product[] }>('/products?pageSize=200');
      return res.data.data ?? [];
    },
  });

  const locations = useQuery<Location[]>({
    queryKey: ['inventory-locations'],
    queryFn: async () => {
      const res = await api.get<{ data: Location[] }>('/inventory/locations');
      return res.data.data ?? [];
    },
  });

  const locMap = new Map(locations.data?.map((l) => [l.id, l]));
  // The transit location is system-managed: never a pickable source or destination.
  const pickableLocations = (locations.data ?? []).filter((l) => l.type !== 'transit');

  const pickProduct = (idx: number, productId: string) => {
    const p = products.data?.find((x) => x.id === productId);
    if (!p) return;
    const next = [...lines];
    next[idx] = { ...next[idx], productId, productName: p.name };
    setLines(next);
  };

  const handleSubmit = () => {
    const items = lines
      .filter((l) => l.productId && l.quantity > 0)
      .map((l) => ({
        productId: l.productId,
        qtyRequested: l.quantity,
        distStrategy: l.distStrategy,
      }));
    createTransfer.mutate(
      { fromLocationId: fromLocId, toLocationId: toLocId, responsibleById: responsibleId, approvedById: approvedId, mode, items, notes: notes || undefined },
      {
        onSuccess: () => {
          setShowForm(false);
          setFromLocId('');
          setToLocId('');
          setNotes('');
          setMode('immediate');
          setResponsibleId('');
          setApprovedId('');
          setLines([{ productId: '', productName: '', quantity: 1, distStrategy: 'FEFO' }]);
          qc.invalidateQueries({ queryKey: ['inventory-product-stock-levels'] });
          qc.invalidateQueries({ queryKey: ['inventory-stats'] });
        },
      },
    );
  };

  const canSubmit = fromLocId && toLocId && fromLocId !== toLocId && responsibleId && approvedId && lines.some((l) => l.productId && l.quantity > 0) && !createTransfer.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Stock Transfers</h1>
          <p className="text-sm text-muted-foreground">Move stock between locations — immediately on the same premises, or via dispatch and receipt between branches</p>
        </div>
        {canCreate && (
          <Button onClick={() => setShowForm(true)}>
            <Plus className="mr-2 h-4 w-4" />New Transfer
          </Button>
        )}
      </div>

      {isLoading && <Skeleton className="h-48 w-full" />}
      {transfers && transfers.length === 0 && (
        <Card><CardContent className="p-8 text-center text-muted-foreground">No transfers yet. Click "New Transfer" to create one.</CardContent></Card>
      )}
      {transfers && transfers.length > 0 && (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th scope="col" className="px-3 py-2 text-left font-medium">Transfer #</th>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">From → To</th>
                <th className="px-3 py-2 text-left font-medium">Mode</th>
                <th className="px-3 py-2 text-right font-medium">Items</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Notes</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((tr) => {
                const fromLoc = locMap.get(tr.fromLocId);
                const toLoc = locMap.get(tr.toLocId);
                return (
                  <tr key={tr.id} className="border-b hover:bg-muted/30">
                    <td className="px-3 py-2 font-mono text-xs font-medium">{tr.transferCode}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{dateTime(tr.createdAt)}</td>
                    <td className="px-3 py-2">
                      {fromLoc?.code ?? '—'} → {toLoc?.code ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{tr.mode === 'transit' ? 'Transit' : 'Immediate'}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{tr.items?.length ?? 0}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex px-2.5 py-0.5 rounded text-xs font-semibold whitespace-nowrap ${STATUS_COLORS[tr.status] ?? 'bg-gray-100 text-gray-700'}`}>
                        {STATUS_LABEL[tr.status] ?? tr.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 max-w-48 truncate text-muted-foreground">{tr.notes ?? '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1">
                      {tr.status === 'pending' && canApprove && (
                        <Button size="sm" variant="outline" onClick={() => approveTransfer.mutate(tr.id)} disabled={approveTransfer.isPending}>
                          {approveTransfer.isPending ? '…' : 'Approve'}
                        </Button>
                      )}
                      {tr.status === 'approved' && tr.mode === 'transit' && canMove && (
                        <Button size="sm" variant="outline" onClick={() => dispatchTransfer.mutate(tr.id)} disabled={dispatchTransfer.isPending}>
                          <Truck className="mr-1 h-3.5 w-3.5" />{dispatchTransfer.isPending ? 'Dispatching…' : 'Dispatch'}
                        </Button>
                      )}
                      {(tr.status === 'pending' || (tr.status === 'approved' && tr.mode === 'transit')) && canApprove && (
                        <Button size="sm" variant="ghost" aria-label={`Cancel ${tr.transferCode}`} onClick={() => cancelTransfer.mutate(tr.id)} disabled={cancelTransfer.isPending}>
                          <X className="mr-1 h-3.5 w-3.5" />Cancel
                        </Button>
                      )}
                      {(tr.status === 'in_transit' || tr.status === 'partially_received') && canMove && (
                        <Button size="sm" variant="outline" onClick={() => openReceive(tr)}>
                          <PackageCheck className="mr-1 h-3.5 w-3.5" />Receive
                        </Button>
                      )}
                      {(tr.status === 'in_transit' || tr.status === 'partially_received') && canApprove && (
                        <Button size="sm" variant="ghost" onClick={() => setRecalling({ id: tr.id, code: tr.transferCode })} disabled={recallTransfer.isPending}>
                          <CornerUpLeft className="mr-1 h-3.5 w-3.5" />Recall
                        </Button>
                      )}
                      {tr.status === 'completed' && canApprove && (
                        <Button size="sm" variant="ghost" title="Reverse posted transfer"
                          onClick={() => setReversing({ id: tr.id, code: tr.transferCode })} disabled={reverseTransfer.isPending}>
                          <Undo2 className="mr-1 h-3.5 w-3.5" />Reverse
                        </Button>
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

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>New Stock Transfer</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <fieldset>
              <legend className="text-sm font-medium">Transfer type</legend>
              <div className="mt-1 grid gap-2 sm:grid-cols-2">
                {([
                  ['immediate', 'Immediate', 'Same premises. Stock moves the moment it is approved.'],
                  ['transit', 'Branch (in transit)', 'Approve, dispatch, then the destination receives — with damage and shortage recorded.'],
                ] as const).map(([value, label, hint]) => (
                  <label key={value} className={`flex cursor-pointer gap-2 rounded-md border p-2 text-sm ${mode === value ? 'border-primary bg-primary/5' : ''}`}>
                    <input type="radio" name="transfer-mode" value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-1" />
                    <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium">From Location</label>
                <Select value={fromLocId} onValueChange={setFromLocId}>
                  <SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger>
                  <SelectContent>
                    {pickableLocations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>{l.code} — {l.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">To Location</label>
                <Select value={toLocId} onValueChange={setToLocId}>
                  <SelectTrigger><SelectValue placeholder="Select destination" /></SelectTrigger>
                  <SelectContent>
                    {pickableLocations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>{l.code} — {l.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
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
            {fromLocId && toLocId && fromLocId === toLocId && (
              <p className="text-sm text-destructive">Source and destination must be different</p>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Items</label>
                <Button size="sm" variant="outline" onClick={() => setLines([...lines, { productId: '', productName: '', quantity: 1, distStrategy: 'FEFO' }])}>
                  <Plus className="mr-1 h-3 w-3" />Add Item
                </Button>
              </div>
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-2 py-1 text-left font-medium">Product</th>
                      <th className="px-2 py-1 text-right font-medium">Quantity</th>
                      <th className="px-2 py-1 font-medium">Strategy</th>
                      <th className="w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((ln, idx) => (
                      <tr key={idx} className="border-b">
                        <td className="px-2 py-1">
                          <select
                            className="w-full rounded border bg-background px-1 py-0.5 text-sm"
                            value={ln.productId}
                            onChange={(e) => pickProduct(idx, e.target.value)}
                          >
                            <option value="">Select product…</option>
                            {products.data?.map((p) => (
                              <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <Input
                            type="number" min="1" className="h-7 w-24 text-right"
                            value={ln.quantity}
                            onChange={(e) => {
                              const next = [...lines];
                              next[idx] = { ...next[idx], quantity: Number(e.target.value) };
                              setLines(next);
                            }}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <Select value={ln.distStrategy} onValueChange={(v) => {
                            const next = [...lines];
                            next[idx] = { ...next[idx], distStrategy: v };
                            setLines(next);
                          }}>
                            <SelectTrigger className="h-7 w-24"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="FEFO">FEFO</SelectItem>
                              <SelectItem value="FIFO">FIFO</SelectItem>
                              <SelectItem value="MANUAL">Manual</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-1">
                          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setLines(lines.filter((_, i) => i !== idx))}>
                            <Trash2 className="h-3 w-3 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium">Notes</label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional transfer notes" rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              <Save className="mr-2 h-4 w-4" />{createTransfer.isPending ? 'Creating…' : 'Create Transfer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReasonDialog
        open={!!reversing}
        onOpenChange={(o) => { if (!o) setReversing(null); }}
        title={`Reverse ${reversing?.code ?? ''}`}
        description={<p>Moves the transferred quantities back to the source location today. It fails if the destination no longer holds them.</p>}
        confirmLabel="Reverse transfer"
        pendingLabel="Reversing…"
        destructive
        pending={reverseTransfer.isPending}
        onConfirm={(reason) => reversing && reverseTransfer.mutate({ id: reversing.id, reason }, { onSuccess: () => setReversing(null) })}
      />

      <ReasonDialog
        open={!!recalling}
        onOpenChange={(o) => { if (!o) setRecalling(null); }}
        title={`Recall ${recalling?.code ?? ''}`}
        description={<p>Returns everything still in transit to the source location. Quantities already received, damaged or short are not affected.</p>}
        confirmLabel="Recall to source"
        pendingLabel="Recalling…"
        destructive
        pending={recallTransfer.isPending}
        onConfirm={(reason) => recalling && recallTransfer.mutate({ id: recalling.id, reason }, { onSuccess: () => setRecalling(null) })}
      />

      <Dialog open={!!receiving} onOpenChange={(o) => { if (!o) setReceiving(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Receive {receiving?.code}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Split what is still in transit into what arrived in good condition, what arrived damaged (written off as waste) and what never arrived (written off as a loss). Anything left blank stays in transit for a later receipt.
          </p>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th scope="col" className="px-2 py-1 text-left font-medium">Product</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">In transit</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">Received</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">Damaged</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">Short</th>
                </tr>
              </thead>
              <tbody>
                {receiving?.rows.map((r, idx) => {
                  const over = num(r.received) + num(r.damaged) + num(r.short) > r.open + 1e-6;
                  const set = (field: 'received' | 'damaged' | 'short', value: string) =>
                    setReceiving((cur) => cur && { ...cur, rows: cur.rows.map((x, i) => (i === idx ? { ...x, [field]: value } : x)) });
                  return (
                    <tr key={r.itemId} className="border-b">
                      <td className="px-2 py-1">
                        {r.productName}
                        {over && <span role="alert" className="block text-xs text-destructive">More than is in transit</span>}
                      </td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums">{r.open}</td>
                      {(['received', 'damaged', 'short'] as const).map((field) => (
                        <td key={field} className="px-2 py-1">
                          <Input
                            type="number" min="0" step="any" inputMode="decimal"
                            aria-label={`${field} quantity for ${r.productName}`}
                            aria-invalid={over}
                            className="h-8 w-24 ml-auto text-right"
                            value={r[field]}
                            onChange={(e) => set(field, e.target.value)}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="receive-notes">Notes</label>
            <Textarea id="receive-notes" value={receiveNotes} onChange={(e) => setReceiveNotes(e.target.value)} placeholder="Delivery note, driver, condition…" rows={2} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiving(null)}>Cancel</Button>
            <Button
              disabled={receiveInvalid || receiveEmpty || receiveTransfer.isPending}
              onClick={() => receiving && receiveTransfer.mutate(
                {
                  id: receiving.id,
                  notes: receiveNotes || undefined,
                  lines: receiving.rows.map((r) => ({ itemId: r.itemId, received: num(r.received), damaged: num(r.damaged), short: num(r.short) })),
                },
                { onSuccess: () => setReceiving(null) },
              )}
            >
              <PackageCheck className="mr-2 h-4 w-4" />{receiveTransfer.isPending ? 'Posting…' : 'Post receipt'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
