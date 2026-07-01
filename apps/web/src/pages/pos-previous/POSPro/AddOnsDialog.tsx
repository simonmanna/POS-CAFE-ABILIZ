import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Check, Plus } from 'lucide-react';
import type { AddOn, Menu } from './types';

interface Props {
  open: boolean;
  menu: Menu | null;
  onClose: () => void;
  onAdd: (addOnIds: number[], notes: string) => void;
}

const fmt = (n: number) => `+ UGX ${Number(n || 0).toLocaleString()}`;

export const AddOnsDialog: React.FC<Props> = ({ open, menu, onClose, onAdd }) => {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (open) { setPicked(new Set()); setNotes(''); }
  }, [open, menu?.id]);

  if (!menu) return null;
  const total = (menu.addOns || []).filter((a) => picked.has(a.id)).reduce((s, a) => s + a.price, 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" /> Choose add-ons for {menu.name}
          </DialogTitle>
          <DialogDescription>Pick extras and an optional note for the kitchen.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-[40vh] overflow-y-auto">
          {(menu.addOns || []).length === 0 ? (
            <p className="text-sm text-slate-500">No add-ons configured.</p>
          ) : (menu.addOns || []).map((a) => {
            const on = picked.has(a.id);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  const n = new Set(picked);
                  if (n.has(a.id)) n.delete(a.id); else n.add(a.id);
                  setPicked(n);
                }}
                className="w-full flex items-center justify-between p-3 rounded-lg border-2 text-left"
                style={{ borderColor: on ? '#1a7fcf' : '#e2e8f0', background: on ? '#e8f3fb' : '#fff' }}
              >
                <div className="flex items-center gap-2">
                  <span className={'w-5 h-5 rounded-md flex items-center justify-center border-2'} style={{ borderColor: on ? '#1a7fcf' : '#cbd5e1', background: on ? '#1a7fcf' : 'transparent' }}>
                    {on ? <Check className="h-3 w-3 text-white" /> : null}
                  </span>
                  <span className="font-semibold text-sm">{a.name}</span>
                </div>
                <span className="text-sm font-bold text-emerald-600">{fmt(a.price)}</span>
              </button>
            );
          })}
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600">Note for the kitchen (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="e.g. no onions, extra spicy"
            className="w-full px-3 py-2 rounded border border-slate-200 text-sm mt-1"
          />
        </div>
        {total > 0 ? (
          <p className="text-sm text-slate-600">Add-on total: <span className="font-bold text-emerald-600">{fmt(total)}</span></p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onAdd(Array.from(picked), notes)}>Add to order</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
