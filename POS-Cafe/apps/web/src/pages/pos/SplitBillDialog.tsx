import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Scissors, X, User } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useCartStore } from '@/features/pos/cart.store';
import { useSplitBill } from '@/features/tables/api';

const fmt = (n: number) => `UGX ${Number(n || 0).toLocaleString()}`;

interface Props {
  open: boolean;
  onClose: () => void;
  tableId: string;
}

export const SplitBillDialog: React.FC<Props> = ({ open, onClose, tableId }) => {
  const lines = useCartStore((s) => s.lines);
  const splitBill = useSplitBill();

  const [splits, setSplits] = useState<Array<{ label: string; lineIds: Set<string> }>>([]);

  const reset = () => {
    setSplits([]);
  };

  React.useEffect(() => {
    if (!open) reset();
  }, [open]);

  const initByItem = () => {
    setSplits(lines.map((l) => ({ label: l.name, lineIds: new Set([l.lineId]) })));
  };

  const initEqual = (count: number) => {
    const groups: Array<{ label: string; lineIds: Set<string> }> = [];
    for (let i = 0; i < count; i++) {
      groups.push({ label: `Guest ${i + 1}`, lineIds: new Set() });
    }
    lines.forEach((l, idx) => {
      const gi = idx % count;
      groups[gi].lineIds.add(l.lineId);
    });
    setSplits(groups);
  };

  const moveLine = (lineId: string, fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= splits.length || fromIdx === toIdx) return;
    setSplits((prev) => {
      const next = prev.map((s) => ({ ...s, lineIds: new Set(s.lineIds) }));
      next[fromIdx].lineIds.delete(lineId);
      next[toIdx].lineIds.add(lineId);
      return next.filter((s) => s.lineIds.size > 0 || s.label);
    });
  };

  const splitTotal = useMemo(() => {
    return splits.map((s) => {
      const sum = lines
        .filter((l) => s.lineIds.has(l.lineId))
        .reduce((acc, l) => acc + l.quantity * l.unitPrice * (1 - l.discountPercent / 100), 0);
      return { label: s.label, total: sum };
    });
  }, [splits, lines]);

  const allCovered = useMemo(() => {
    const assigned = new Set(splits.flatMap((s) => [...s.lineIds]));
    return lines.every((l) => assigned.has(l.lineId));
  }, [splits, lines]);

  const doSplit = async () => {
    if (!allCovered || splits.length < 2) {
      toast.error('Assign all items to at least 2 checks');
      return;
    }
    // Build split payload: each split = guest label + lines (by sourceLineId)
    const body = {
      sourceDocumentId: tableId, // The backend needs the actual documentId
      splits: splits.map((s) => ({
        label: s.label,
        lines: lines
          .filter((l) => s.lineIds.has(l.lineId))
          .map((l) => ({ sourceLineId: l.lineId, quantity: l.quantity })),
      })),
    };
    try {
      await splitBill.mutateAsync({ tableId, body });
      toast.success(`Bill split into ${splits.length} checks`);
      onClose();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Split failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="w-4 h-4" /> Split Bill
          </DialogTitle>
        </DialogHeader>

        {splits.length === 0 ? (
          <div className="space-y-3 py-4">
            <p className="text-sm text-slate-600">How would you like to split?</p>
            <div className="grid grid-cols-3 gap-3">
              <button
                type="button"
                className="p-4 rounded-xl border-2 border-slate-200 hover:border-amber-400 text-center transition"
                onClick={initByItem}
              >
                <Scissors className="w-6 h-6 mx-auto mb-2 text-amber-500" />
                <div className="font-bold text-sm">By Item</div>
                <div className="text-xs text-slate-500">Each item its own check</div>
              </button>
              <button
                type="button"
                className="p-4 rounded-xl border-2 border-slate-200 hover:border-amber-400 text-center transition"
                onClick={() => initEqual(2)}
              >
                <User className="w-6 h-6 mx-auto mb-2 text-amber-500" />
                <div className="font-bold text-sm">Equal Split</div>
                <div className="text-xs text-slate-500">2-way split</div>
              </button>
              <button
                type="button"
                className="p-4 rounded-xl border-2 border-slate-200 hover:border-amber-400 text-center transition"
                onClick={() => initEqual(3)}
              >
                <User className="w-6 h-6 mx-auto mb-2 text-amber-500" />
                <div className="font-bold text-sm">3-Way</div>
                <div className="text-xs text-slate-500">3-way split</div>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 max-h-[50vh] overflow-y-auto py-2">
            {splits.map((s, si) => (
              <div key={si} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between mb-2">
                  <input
                    value={s.label}
                    onChange={(e) => {
                      setSplits((prev) => {
                        const next = [...prev];
                        next[si] = { ...next[si], label: e.target.value };
                        return next;
                      });
                    }}
                    className="font-bold text-sm border-0 bg-transparent focus:outline-none focus:ring-0"
                  />
                  <span className="text-xs font-mono font-bold text-slate-600">
                    {fmt(splitTotal[si]?.total ?? 0)}
                  </span>
                </div>
                <div className="space-y-1">
                  {lines
                    .filter((l) => s.lineIds.has(l.lineId))
                    .map((l) => (
                      <div key={l.lineId} className="flex items-center justify-between text-xs bg-slate-50 rounded px-2 py-1">
                        <span className="truncate flex-1">{l.name} ×{l.quantity}</span>
                        <div className="flex gap-1 ml-2">
                          {splits.map((_, ti) =>
                            ti !== si ? (
                              <button
                                key={ti}
                                type="button"
                                className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 hover:bg-slate-300"
                                onClick={() => moveLine(l.lineId, si, ti)}
                                title={`Move to ${splits[ti].label}`}
                              >
                                →{ti + 1}
                              </button>
                            ) : null
                          )}
                          <button
                            type="button"
                            className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-600 hover:bg-rose-200"
                            onClick={() => {
                              setSplits((prev) => prev.filter((_, i) => i !== si));
                            }}
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            ))}

            {!allCovered && (
              <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded px-3 py-2">
                Some items are not assigned to any check.
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {splits.length > 0 && (
            <Button onClick={doSplit} disabled={!allCovered || splits.length < 2}>
              <Scissors className="w-4 h-4 mr-1" /> Confirm Split
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SplitBillDialog;
