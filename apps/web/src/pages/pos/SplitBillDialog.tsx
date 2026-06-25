// Split Bill — divide a table's open tab into N guest checks.
// Operates on the SERVER tab document (not the local cart) so the split
// references real DocumentLine ids, and supports PARTIAL quantities: each line's
// units are allocated across checks and must sum back to the line quantity
// (the backend validates exact coverage).
import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Scissors, Minus, Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useSplitBill } from '@/features/tables/api';
import { useTab } from './api';

const fmt = (n: number) => `UGX ${Number(n || 0).toLocaleString()}`;

interface Props {
  open: boolean;
  onClose: () => void;
  tableId: string;
}

interface DocLine { id: string; description: string; quantity: string; unitPrice: string }

export const SplitBillDialog: React.FC<Props> = ({ open, onClose, tableId }) => {
  const { data: tab, isLoading } = useTab(open ? tableId : undefined);
  const splitBill = useSplitBill();
  const docLines = useMemo<DocLine[]>(() => (tab?.lines ?? []) as DocLine[], [tab]);

  // splits[si].qty[lineId] = units of that line assigned to check si.
  const [splits, setSplits] = useState<Array<{ label: string; qty: Record<string, number> }>>([]);

  /** Build N checks; all units of every line default to the first check. */
  const buildSplits = (count: number) => {
    const groups = Array.from({ length: count }, (_, i) => ({ label: `Guest ${i + 1}`, qty: {} as Record<string, number> }));
    for (const l of docLines) groups[0].qty[l.id] = Math.round(Number(l.quantity));
    setSplits(groups);
  };

  useEffect(() => {
    if (!open) setSplits([]);
  }, [open]);

  const lineQty = (l: DocLine) => Math.round(Number(l.quantity));
  const assignedFor = (lineId: string) => splits.reduce((s, g) => s + (g.qty[lineId] ?? 0), 0);

  const setQty = (si: number, lineId: string, q: number, max: number) => {
    setSplits((prev) => {
      const next = prev.map((g) => ({ ...g, qty: { ...g.qty } }));
      next[si].qty[lineId] = Math.max(0, Math.min(max, Math.floor(q) || 0));
      return next;
    });
  };

  const splitTotal = (si: number) =>
    docLines.reduce((acc, l) => acc + (splits[si]?.qty[l.id] ?? 0) * Number(l.unitPrice), 0);

  const allAllocated = useMemo(
    () => docLines.length > 0 && docLines.every((l) => assignedFor(l.id) === lineQty(l)),
    [splits, docLines],
  );
  const nonEmpty = splits.filter((g) => docLines.some((l) => (g.qty[l.id] ?? 0) > 0)).length;

  const doSplit = async () => {
    if (!tab?.id) { toast.error('No open tab to split'); return; }
    if (!allAllocated || nonEmpty < 2) {
      toast.error('Allocate every item across at least 2 checks');
      return;
    }
    const body = {
      sourceDocumentId: tab.id,
      splits: splits
        .map((g, si) => ({
          label: g.label || `Guest ${si + 1}`,
          lines: docLines
            .map((l) => ({ sourceLineId: l.id, quantity: g.qty[l.id] ?? 0 }))
            .filter((x) => x.quantity > 0),
        }))
        .filter((g) => g.lines.length > 0),
    };
    try {
      await splitBill.mutateAsync({ tableId, body });
      toast.success(`Bill split into ${body.splits.length} checks`);
      onClose();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Split failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="w-4 h-4" /> Split Bill
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-slate-400">Loading tab…</div>
        ) : docLines.length === 0 ? (
          <div className="py-8 text-center text-slate-400">This table has no open tab to split.</div>
        ) : splits.length === 0 ? (
          <div className="space-y-3 py-4">
            <p className="text-sm text-slate-600">How many checks?</p>
            <div className="grid grid-cols-3 gap-3">
              {[2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  className="p-4 rounded-xl border-2 border-slate-200 hover:border-amber-400 text-center transition"
                  onClick={() => buildSplits(n)}
                >
                  <div className="font-bold text-lg">{n}</div>
                  <div className="text-xs text-slate-500">{n}-way split</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3 max-h-[56vh] overflow-y-auto py-2">
            {docLines.map((l) => {
              const assigned = assignedFor(l.id);
              const q = lineQty(l);
              const ok = assigned === q;
              return (
                <div key={l.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-bold truncate">{l.description} <span className="text-slate-400">×{q}</span></span>
                    <span className={`text-xs font-mono font-bold ${ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {assigned}/{q} allocated
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {splits.map((g, si) => {
                      const cur = g.qty[l.id] ?? 0;
                      const headroom = q - (assigned - cur);
                      return (
                        <div key={si} className="flex items-center gap-1 rounded-lg bg-slate-50 border border-slate-200 px-2 py-1">
                          <span className="text-[10px] font-semibold text-slate-500 truncate flex-1">{g.label}</span>
                          <button type="button" className="text-slate-500 disabled:opacity-30" disabled={cur <= 0} onClick={() => setQty(si, l.id, cur - 1, headroom)}><Minus className="w-3 h-3" /></button>
                          <span className="w-5 text-center text-xs font-mono font-bold">{cur}</span>
                          <button type="button" className="text-slate-500 disabled:opacity-30" disabled={cur >= headroom} onClick={() => setQty(si, l.id, cur + 1, headroom)}><Plus className="w-3 h-3" /></button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {splits.map((g, si) => (
                <div key={si} className="rounded-lg bg-amber-50 border border-amber-200 px-2 py-1.5 text-center">
                  <input
                    value={g.label}
                    onChange={(e) =>
                      setSplits((prev) => { const n = [...prev]; n[si] = { ...n[si], label: e.target.value }; return n; })
                    }
                    className="w-full text-center text-xs font-bold bg-transparent border-0 focus:outline-none"
                  />
                  <div className="text-xs font-mono font-bold text-amber-700">{fmt(splitTotal(si))}</div>
                </div>
              ))}
            </div>
            {!allAllocated && (
              <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded px-3 py-2">
                Every item must be fully allocated across the checks.
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {splits.length > 0 && (
            <Button onClick={doSplit} disabled={!allAllocated || nonEmpty < 2 || splitBill.isPending}>
              <Scissors className="w-4 h-4 mr-1" /> Confirm Split
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SplitBillDialog;
