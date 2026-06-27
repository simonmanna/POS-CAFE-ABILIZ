import React, { useEffect, useMemo, useState } from 'react';
import { Coffee, X, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { AccompanimentGroupFE } from './pos-features-api';

interface Props {
  open: boolean;
  productName: string;
  groups: AccompanimentGroupFE[];
  onClose: () => void;
  onConfirm: (selections: Array<{ optionId: string; optionName: string; priceImpact: number }>) => void;
}

const fmt = (n: number) => (n === 0 ? '—' : `UGX ${Number(n || 0).toLocaleString()}`);

export const AccompanimentPicker: React.FC<Props> = ({ open, productName, groups, onClose, onConfirm }) => {
  const [selections, setSelections] = useState<Record<string, Record<string, { optionId: string; optionName: string; priceImpact: number }>>>({});

  useEffect(() => {
    if (!open) { setSelections({}); return; }
    const init: Record<string, Record<string, { optionId: string; optionName: string; priceImpact: number }>> = {};
    for (const g of groups) {
      const defaults = g.options.filter((o) => o.isDefault);
      if (defaults.length > 0) {
        init[g.id] = {};
        for (const o of defaults) init[g.id][o.id] = { optionId: o.id, optionName: o.name, priceImpact: o.priceImpact };
      }
    }
    setSelections(init);
  }, [open, groups]);

  const toggle = (g: AccompanimentGroupFE, optionId: string, optionName: string, priceImpact: number) => {
    setSelections((prev) => {
      const cur = { ...(prev[g.id] ?? {}) };
      if (cur[optionId]) {
        delete cur[optionId];
      } else if (g.maxSelect === 1) {
        const next: Record<string, { optionId: string; optionName: string; priceImpact: number }> = {};
        next[optionId] = { optionId, optionName, priceImpact };
        return { ...prev, [g.id]: next };
      } else if (Object.keys(cur).length >= g.maxSelect) {
        delete cur[Object.keys(cur)[0]];
        cur[optionId] = { optionId, optionName, priceImpact };
      } else {
        cur[optionId] = { optionId, optionName, priceImpact };
      }
      return { ...prev, [g.id]: cur };
    });
  };

  const valid = useMemo(() => {
    for (const g of groups) {
      const count = Object.keys(selections[g.id] ?? {}).length;
      if (g.isRequired && count === 0) return false;
      if (g.minSelect > 0 && count < g.minSelect) return false;
    }
    return true;
  }, [groups, selections]);

  const totalImpact = useMemo(() => {
    let t = 0;
    for (const g of groups)
      for (const o of Object.values(selections[g.id] ?? {}))
        t += o.priceImpact;
    return t;
  }, [groups, selections]);

  const handleConfirm = () => {
    const flat: Array<{ optionId: string; optionName: string; priceImpact: number }> = [];
    for (const g of groups)
      for (const o of Object.values(selections[g.id] ?? {}))
        flat.push(o);
    onConfirm(flat);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coffee className="h-4 w-4" />
            {productName} — Choose side
          </DialogTitle>
          <DialogDescription>Select accompaniments for your order.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {groups.map((g) => (
            <div key={g.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-bold text-sm">{g.name}</div>
                <div className="text-[11px] text-slate-500">
                  {g.isRequired ? 'Required' : 'Optional'} · {g.maxSelect === 1 ? 'Pick one' : `Up to ${g.maxSelect}`}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {g.options.map((o) => {
                  const sel = !!selections[g.id]?.[o.id];
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => toggle(g, o.id, o.name, o.priceImpact)}
                      className={`px-2.5 py-1.5 rounded-md text-xs font-semibold border-2 text-left flex items-center justify-between ${
                        sel ? 'border-amber-500 bg-amber-50 text-amber-900' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        {sel && <Check className="h-3 w-3" />}
                        {o.name}
                      </span>
                      <span className="text-[11px] font-mono">
                        {o.priceImpact === 0 ? '(included)' : `+${fmt(o.priceImpact)}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {totalImpact !== 0 && (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-emerald-900">+ Accompaniments</span>
              <span className="font-mono font-bold text-emerald-900">+{fmt(totalImpact)}</span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}><X className="h-4 w-4 mr-1" /> Cancel</Button>
          <Button onClick={handleConfirm} disabled={!valid} style={{ background: '#16a34a' }}>
            <Check className="h-4 w-4 mr-1" /> Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
