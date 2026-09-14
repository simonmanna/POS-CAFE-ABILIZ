import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Minus, Plus, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useStaffOptions } from '@/features/inventory/staff-options';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { notify } from '@/lib/notify';

interface Location { id: string; code: string; name: string; type: string }

interface DirectStockActionsProps {
  /** Extra query keys to invalidate after a successful post (page-specific lists). */
  invalidateKeys?: string[];
}

/**
 * The "Direct Stock In" / "Direct Stock Out" buttons and their dialogs, shared
 * by every page that needs to move stock ad hoc (Stock Levels, Stock Ledger).
 * Owns its own queries, form state and posting — the host page only renders it.
 */
export function DirectStockActions({ invalidateKeys = [] }: DirectStockActionsProps) {
  const locations = useQuery<Location[]>({
    queryKey: ['inventory-locations'],
    queryFn: async () => {
      const res = await api.get<{ data: Location[] }>('/inventory/locations');
      return res.data.data ?? [];
    },
  });

  const staffOptionsQuery = useStaffOptions();
  const staffOptions = staffOptionsQuery.data ?? [];

  const products = useQuery<{ data: { id: string; code: string; name: string }[] }>({
    queryKey: ['products-simple'],
    queryFn: async () => (await api.get('/products?pageSize=1000')).data,
  });

  /** Options for the searchable product pickers in the stock-in/out dialogs. */
  const productOptions = useMemo(
    () => (products.data?.data ?? []).map((p) => ({ value: p.id, label: p.name, code: p.code })),
    [products.data],
  );

  const qc = useQueryClient();

  /** Refresh every list a stock movement can change, plus the host page's own. */
  const invalidateAll = () => {
    for (const key of ['inventory-product-stock-levels', 'inventory-stats', 'inventory-ledger', ...invalidateKeys]) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  };

  // — Direct Stock In state
  const [inOpen, setInOpen] = useState(false);
  const [inLocId, setInLocId] = useState('');
  const [inNotes, setInNotes] = useState('');
  const [inResponsibleId, setInResponsibleId] = useState('');
  const [inApprovedId, setInApprovedId] = useState('');
  const [inLines, setInLines] = useState<{ productId: string; name: string; quantity: number; unitCost: string; batchNumber: string; expiryDate: string }[]>([
    { productId: '', name: '', quantity: 1, unitCost: '', batchNumber: '', expiryDate: '' },
  ]);

  const directIn = useMutation({
    mutationFn: async () => {
      const items = inLines
        .filter((l) => l.productId && l.quantity > 0)
        .map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          ...(l.unitCost ? { unitCost: Number(l.unitCost) } : {}),
          ...(l.batchNumber ? { batchNumber: l.batchNumber } : {}),
          ...(l.expiryDate ? { expiryDate: l.expiryDate } : {}),
        }));
      const res = await api.post('/inventory/direct-stock/in', {
        locationId: inLocId,
        responsibleById: inResponsibleId,
        approvedById: inApprovedId,
        items,
        notes: inNotes || undefined,
      });
      return res.data;
    },
    onSuccess: (data: any) => {
      notify.success(`Stock in ${data.code} completed`);
      setInOpen(false);
      setInLocId('');
      setInNotes('');
      setInResponsibleId('');
      setInApprovedId('');
      setInLines([{ productId: '', name: '', quantity: 1, unitCost: '', batchNumber: '', expiryDate: '' }]);
      invalidateAll();
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Stock in failed'),
  });

  // — Direct Stock Out state
  const [outOpen, setOutOpen] = useState(false);
  const [outLocId, setOutLocId] = useState('');
  const [outNotes, setOutNotes] = useState('');
  const [outResponsibleId, setOutResponsibleId] = useState('');
  const [outApprovedId, setOutApprovedId] = useState('');
  const [outLines, setOutLines] = useState<{ productId: string; name: string; quantity: number; distStrategy: string; batchNumber: string }[]>([
    { productId: '', name: '', quantity: 1, distStrategy: 'FEFO', batchNumber: '' },
  ]);

  const directOut = useMutation({
    mutationFn: async () => {
      const items = outLines
        .filter((l) => l.productId && l.quantity > 0)
        .map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          distStrategy: l.distStrategy,
          ...(l.batchNumber ? { batchNumber: l.batchNumber } : {}),
        }));
      const res = await api.post('/inventory/direct-stock/out', {
        locationId: outLocId,
        responsibleById: outResponsibleId,
        approvedById: outApprovedId,
        items,
        notes: outNotes || undefined,
      });
      return res.data;
    },
    onSuccess: (data: any) => {
      notify.success(`Stock out ${data.code} completed`);
      setOutOpen(false);
      setOutLocId('');
      setOutNotes('');
      setOutResponsibleId('');
      setOutApprovedId('');
      setOutLines([{ productId: '', name: '', quantity: 1, distStrategy: 'FEFO', batchNumber: '' }]);
      invalidateAll();
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Stock out failed'),
  });

  const pickInProduct = (idx: number, productId: string) => {
    const p = products.data?.data?.find((x) => x.id === productId);
    if (!p) return;
    const next = [...inLines];
    next[idx] = { ...next[idx], productId, name: p.name };
    setInLines(next);
  };

  const pickOutProduct = (idx: number, productId: string) => {
    const p = products.data?.data?.find((x) => x.id === productId);
    if (!p) return;
    const next = [...outLines];
    next[idx] = { ...next[idx], productId, name: p.name };
    setOutLines(next);
  };

  // Footer figures and the Manual-batch guard, so each dialog states what it is
  // about to do before the button is pressed.
  const inFilled = inLines.filter((l) => l.productId && l.quantity > 0);
  const inFilledCount = inFilled.length;
  const inTotalQty = inFilled.reduce((n, l) => n + l.quantity, 0);
  const inTotalValue = inFilled.reduce((n, l) => n + (l.unitCost ? Number(l.unitCost) * l.quantity : 0), 0);

  const outFilled = outLines.filter((l) => l.productId && l.quantity > 0);
  const outFilledCount = outFilled.length;
  const outTotalQty = outFilled.reduce((n, l) => n + l.quantity, 0);
  const outMissingBatch = outFilled.filter((l) => l.distStrategy === 'MANUAL' && !l.batchNumber.trim()).length;

  return (
    <>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setInOpen(true)}>
          <Plus className="mr-1 h-3 w-3" />Direct Stock In
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOutOpen(true)}>
          <Minus className="mr-1 h-3 w-3" />Direct Stock Out
        </Button>
      </div>

    {/* Direct Stock In Dialog */}
    <Dialog open={inOpen} onOpenChange={setInOpen}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[1120px] max-h-[92vh] gap-0 overflow-hidden p-0">
        <div className="bg-[#3c8dbc] px-6 py-4 text-white">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg text-white">
              <Plus className="h-5 w-5" /> Direct Stock In
            </DialogTitle>
          </DialogHeader>
          <p className="mt-1 text-sm text-white/80">
            Receive stock straight into a location. Posts an audited movement, valued at the cost you
            enter — leave cost blank to use the item's current average.
          </p>
        </div>

        <div className="max-h-[calc(92vh-16rem)] space-y-4 overflow-y-auto p-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Location <span className="text-destructive">*</span>
              </label>
              <Select value={inLocId} onValueChange={setInLocId}>
                <SelectTrigger><SelectValue placeholder="Select location…" /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {locations.data?.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.code} — {l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Responsible Person <span className="text-destructive">*</span>
              </label>
              <SearchableSelect
                value={inResponsibleId}
                onValueChange={setInResponsibleId}
                options={staffOptions}
                placeholder="Select staff…"
                searchPlaceholder="Search staff…"
                emptyText="No staff match"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Approved By <span className="text-destructive">*</span>
              </label>
              <SearchableSelect
                value={inApprovedId}
                onValueChange={setInApprovedId}
                options={staffOptions}
                placeholder="Select staff…"
                searchPlaceholder="Search staff…"
                emptyText="No staff match"
              />
            </div>
            <div className="space-y-1.5 md:col-span-3">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Notes <span className="font-normal normal-case tracking-normal">(optional)</span>
              </label>
              <Input placeholder="Reference, supplier, reason…" value={inNotes} onChange={(e) => setInNotes(e.target.value)} />
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[30%]" />
                <col className="w-[11%]" />
                <col className="w-[15%]" />
                <col className="w-[15%]" />
                <col className="w-[13%]" />
                <col className="w-[16%]" />
                <col className="w-[52px]" />
              </colgroup>
              <thead>
                <tr className="border-b bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-600">
                  <th className="px-3 py-2.5 font-semibold">Product</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Qty</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Unit Cost</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Line Total</th>
                  <th className="px-3 py-2.5 font-semibold">Batch #</th>
                  <th className="px-3 py-2.5 font-semibold">Expiry</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {inLines.map((line, idx) => (
                  <tr key={idx} className="border-b align-middle last:border-0">
                    <td className="px-2 py-2">
                      <SearchableSelect
                        value={line.productId}
                        onValueChange={(v) => pickInProduct(idx, v)}
                        options={productOptions}
                        placeholder="Select product…"
                        searchPlaceholder="Search products…"
                        emptyText="No products match"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <Input type="number" min={1} className="text-right tabular-nums" value={line.quantity} onChange={(e) => {
                        const next = [...inLines]; next[idx] = { ...next[idx], quantity: Number(e.target.value) }; setInLines(next);
                      }} />
                    </td>
                    <td className="px-2 py-2">
                      <Input type="number" step="0.01" min={0} className="text-right tabular-nums" placeholder="Avg cost" value={line.unitCost} onChange={(e) => {
                        const next = [...inLines]; next[idx] = { ...next[idx], unitCost: e.target.value }; setInLines(next);
                      }} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-slate-600">
                      {line.unitCost && line.quantity > 0
                        ? formatMoney(Number(line.unitCost) * line.quantity)
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-2 py-2">
                      <Input placeholder="Optional" value={line.batchNumber} onChange={(e) => {
                        const next = [...inLines]; next[idx] = { ...next[idx], batchNumber: e.target.value }; setInLines(next);
                      }} />
                    </td>
                    <td className="px-2 py-2">
                      <Input type="date" value={line.expiryDate} onChange={(e) => {
                        const next = [...inLines]; next[idx] = { ...next[idx], expiryDate: e.target.value }; setInLines(next);
                      }} />
                    </td>
                    <td className="px-2 py-2 text-center">
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-destructive" disabled={inLines.length <= 1} title="Remove line" onClick={() => setInLines((prev) => prev.filter((_, i) => i !== idx))}>
                        <XCircle className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t bg-slate-50/60 px-3 py-2">
              <Button variant="outline" size="sm" onClick={() => setInLines((prev) => [...prev, { productId: '', name: '', quantity: 1, unitCost: '', batchNumber: '', expiryDate: '' }])}>
                <Plus className="mr-1 h-3 w-3" />Add Item
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-slate-50 px-6 py-3">
          <div className="text-xs text-muted-foreground">
            {inFilledCount} item{inFilledCount !== 1 ? 's' : ''} · {inTotalQty} unit{inTotalQty !== 1 ? 's' : ''}
            {inTotalValue > 0 && (
              <> · valued <span className="font-semibold text-slate-700">{formatMoney(inTotalValue)}</span></>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setInOpen(false)}>Cancel</Button>
            <Button className="bg-[#3c8dbc] hover:bg-[#367fa9]" disabled={!inLocId || !inResponsibleId || !inApprovedId || inFilledCount === 0 || directIn.isPending} onClick={() => directIn.mutate()}>
              {directIn.isPending ? 'Processing…' : 'Complete Stock In'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    {/* Direct Stock Out Dialog */}
    <Dialog open={outOpen} onOpenChange={setOutOpen}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[1000px] max-h-[92vh] gap-0 overflow-hidden p-0">
        <div className="bg-rose-600 px-6 py-4 text-white">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg text-white">
              <Minus className="h-5 w-5" /> Direct Stock Out
            </DialogTitle>
          </DialogHeader>
          <p className="mt-1 text-sm text-white/80">
            Issue stock out of a location. FEFO and FIFO pick the batch for you; Manual needs the
            batch number. Cost comes from the batch, never from this form.
          </p>
        </div>

        <div className="max-h-[calc(92vh-16rem)] space-y-4 overflow-y-auto p-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Location <span className="text-destructive">*</span>
              </label>
              <Select value={outLocId} onValueChange={setOutLocId}>
                <SelectTrigger><SelectValue placeholder="Select location…" /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {locations.data?.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.code} — {l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Responsible Person <span className="text-destructive">*</span>
              </label>
              <SearchableSelect
                value={outResponsibleId}
                onValueChange={setOutResponsibleId}
                options={staffOptions}
                placeholder="Select staff…"
                searchPlaceholder="Search staff…"
                emptyText="No staff match"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Approved By <span className="text-destructive">*</span>
              </label>
              <SearchableSelect
                value={outApprovedId}
                onValueChange={setOutApprovedId}
                options={staffOptions}
                placeholder="Select staff…"
                searchPlaceholder="Search staff…"
                emptyText="No staff match"
              />
            </div>
            <div className="space-y-1.5 md:col-span-3">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Notes <span className="font-normal normal-case tracking-normal">(optional)</span>
              </label>
              <Input placeholder="Reason, department, reference…" value={outNotes} onChange={(e) => setOutNotes(e.target.value)} />
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[38%]" />
                <col className="w-[13%]" />
                <col className="w-[20%]" />
                <col className="w-[23%]" />
                <col className="w-[52px]" />
              </colgroup>
              <thead>
                <tr className="border-b bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-600">
                  <th className="px-3 py-2.5 font-semibold">Product</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Qty</th>
                  <th className="px-3 py-2.5 font-semibold">Strategy</th>
                  <th className="px-3 py-2.5 font-semibold">Batch #</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {outLines.map((line, idx) => (
                  <tr key={idx} className="border-b align-middle last:border-0">
                    <td className="px-2 py-2">
                      <SearchableSelect
                        value={line.productId}
                        onValueChange={(v) => pickOutProduct(idx, v)}
                        options={productOptions}
                        placeholder="Select product…"
                        searchPlaceholder="Search products…"
                        emptyText="No products match"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <Input type="number" min={1} className="text-right tabular-nums" value={line.quantity} onChange={(e) => {
                        const next = [...outLines]; next[idx] = { ...next[idx], quantity: Number(e.target.value) }; setOutLines(next);
                      }} />
                    </td>
                    <td className="px-2 py-2">
                      <Select value={line.distStrategy} onValueChange={(v) => {
                        const next = [...outLines]; next[idx] = { ...next[idx], distStrategy: v, batchNumber: v !== 'MANUAL' ? '' : next[idx].batchNumber }; setOutLines(next);
                      }}>
                        <SelectTrigger className="min-w-0"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="FEFO">FEFO — earliest expiry</SelectItem>
                          <SelectItem value="FIFO">FIFO — oldest first</SelectItem>
                          <SelectItem value="MANUAL">Manual batch</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-2 py-2">
                      <Input
                        placeholder={line.distStrategy === 'MANUAL' ? 'Required' : 'Auto-picked'}
                        disabled={line.distStrategy !== 'MANUAL'}
                        value={line.batchNumber}
                        onChange={(e) => {
                          const next = [...outLines]; next[idx] = { ...next[idx], batchNumber: e.target.value }; setOutLines(next);
                        }}
                      />
                    </td>
                    <td className="px-2 py-2 text-center">
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-destructive" disabled={outLines.length <= 1} title="Remove line" onClick={() => setOutLines((prev) => prev.filter((_, i) => i !== idx))}>
                        <XCircle className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t bg-slate-50/60 px-3 py-2">
              <Button variant="outline" size="sm" onClick={() => setOutLines((prev) => [...prev, { productId: '', name: '', quantity: 1, distStrategy: 'FEFO', batchNumber: '' }])}>
                <Plus className="mr-1 h-3 w-3" />Add Item
              </Button>
            </div>
          </div>

          {outMissingBatch > 0 && (
            <p className="text-xs text-destructive">
              {outMissingBatch} line{outMissingBatch !== 1 ? 's' : ''} set to Manual still need a batch number.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-slate-50 px-6 py-3">
          <div className="text-xs text-muted-foreground">
            {outFilledCount} item{outFilledCount !== 1 ? 's' : ''} · {outTotalQty} unit{outTotalQty !== 1 ? 's' : ''} leaving stock
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setOutOpen(false)}>Cancel</Button>
            <Button className="bg-rose-600 hover:bg-rose-700" disabled={!outLocId || !outResponsibleId || !outApprovedId || outFilledCount === 0 || outMissingBatch > 0 || directOut.isPending} onClick={() => directOut.mutate()}>
              {directOut.isPending ? 'Processing…' : 'Complete Stock Out'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </>
  );
}
