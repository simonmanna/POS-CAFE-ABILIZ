// P4 — Modifier picker dialog. Opens when a cashier taps a product that
// has required modifier groups (e.g. "Latte" → "Choose size + milk").
import React, { useEffect, useMemo, useState } from 'react';
import { Coffee, X, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useMenuItemBundle, type ModifierGroupFE } from './pos-features-api';

interface Props {
  open: boolean;
  productId: string | null;
  onClose: () => void;
  /** Resolves to the selected modifiers (with names + price deltas), the
   *  quantity, and the free-form note. */
  onAdd: (input: {
    productId: string;
    productName: string;
    /** Per-unit price = base + selected modifier deltas. */
    unitPrice: number;
    sku: string | null;
    modifiers: Array<{ modifierId: string; name: string; priceDelta: number }>;
    quantity: number;
    note: string;
    taxInclusive?: boolean;
  }) => void;
}

const fmt = (n: number) => `UGX ${Number(n || 0).toLocaleString()}`;

export const AddOnsDialog: React.FC<Props> = ({ open, productId, onClose, onAdd }) => {
  // `productId` here is the catalog item id — a MenuItem id in the menu-based POS.
  const { data: bundle, isLoading } = useMenuItemBundle(open ? productId : null);
  // selection[groupId] = Set<modifierId>
  const [selection, setSelection] = useState<Record<string, Set<string>>>({});
  const [note, setNote] = useState('');
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    if (!open || !bundle) { setSelection({}); setNote(''); setQuantity(1); return; }
    // Pre-check default modifiers (radio groups: only one; checkbox: all defaults).
    const init: Record<string, Set<string>> = {};
    for (const g of bundle.groups) {
      const defaults = g.modifiers.filter((m) => m.isDefault);
      if (defaults.length > 0) {
        init[g.id] = new Set(defaults.map((m) => m.id).slice(0, g.maxSelect));
      } else {
        init[g.id] = new Set();
      }
    }
    setSelection(init);
    setNote('');
    setQuantity(1);
  }, [open, bundle?.product.id]);

  const toggle = (g: ModifierGroupFE, modifierId: string) => {
    setSelection((prev) => {
      const cur = new Set(prev[g.id] ?? []);
      if (cur.has(modifierId)) {
        cur.delete(modifierId);
      } else {
        if (g.maxSelect === 1) {
          cur.clear();
          cur.add(modifierId);
        } else if (cur.size >= g.maxSelect) {
          // Already at max — replace the oldest by removing then adding.
          const first = cur.values().next().value;
          if (first) cur.delete(first);
          cur.add(modifierId);
        } else {
          cur.add(modifierId);
        }
      }
      return { ...prev, [g.id]: cur };
    });
  };

  const validation = useMemo(() => {
    if (!bundle) return { ok: false, missing: [] as string[] };
    const missing: string[] = [];
    for (const g of bundle.groups) {
      if (g.minSelect > 0 && (selection[g.id]?.size ?? 0) < g.minSelect) {
        missing.push(g.name);
      }
    }
    return { ok: missing.length === 0, missing };
  }, [bundle, selection]);

  const extraPrice = useMemo(() => {
    if (!bundle) return 0;
    let total = 0;
    for (const g of bundle.groups) {
      for (const m of g.modifiers) {
        if (selection[g.id]?.has(m.id)) total += Number(m.priceDelta);
      }
    }
    return total;
  }, [bundle, selection]);

  if (!bundle && !isLoading) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coffee className="h-4 w-4" />
            {isLoading ? 'Loading…' : bundle?.product.name}
          </DialogTitle>
          <DialogDescription>
            Choose your options. Selected modifiers add to the line price.
          </DialogDescription>
        </DialogHeader>

        {bundle ? (
          <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
            {/* Quantity — the waiter sets it here before adding. */}
            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-2">
              <span className="text-sm font-bold text-slate-700">Quantity</span>
              <div className="flex items-center gap-3">
                <button type="button" aria-label="decrease quantity" onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="w-9 h-9 rounded-md border border-slate-300 font-bold text-xl leading-none">−</button>
                <span className="w-8 text-center font-mono font-bold text-lg">{quantity}</span>
                <button type="button" aria-label="increase quantity" onClick={() => setQuantity((q) => q + 1)} className="w-9 h-9 rounded-md border border-slate-300 font-bold text-xl leading-none">+</button>
              </div>
            </div>

            {bundle.groups.length === 0 ? (
              <div className="text-sm text-slate-500 italic text-center py-4">
                No options for this product.
              </div>
            ) : null}

            {bundle.groups.map((g) => (
              <div key={g.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-bold text-sm">{g.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {g.minSelect > 0 ? `Choose at least ${g.minSelect}` : 'Optional'}
                    {' · '}
                    {g.maxSelect === 1 ? 'Pick one' : `Up to ${g.maxSelect}`}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {g.modifiers.map((m) => {
                    const selected = selection[g.id]?.has(m.id) ?? false;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggle(g, m.id)}
                        className={
                          'px-2.5 py-1.5 rounded-md text-xs font-semibold border-2 text-left flex items-center justify-between ' +
                          (selected
                            ? 'border-amber-500 bg-amber-50 text-amber-900'
                            : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300')
                        }
                      >
                        <span className="flex items-center gap-1.5">
                          {selected && <Check className="h-3 w-3" />}
                          {m.name}
                        </span>
                        <span className="text-[11px] font-mono">
                          {m.priceDelta === 0 ? '—' : (m.priceDelta > 0 ? '+' : '') + fmt(m.priceDelta)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            <div>
              <div className="text-xs font-semibold text-slate-500 mb-1">Note for kitchen</div>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. extra hot, no sugar"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md"
              />
            </div>

            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-amber-900">Base price</span>
              <span className="font-mono font-bold text-amber-900">{fmt(bundle.product.unitPrice)}</span>
            </div>
            {extraPrice !== 0 ? (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-emerald-900">+ Modifiers</span>
                <span className="font-mono font-bold text-emerald-900">+{fmt(extraPrice)}</span>
              </div>
            ) : null}
            <div className="rounded-lg bg-slate-900 text-white px-3 py-3 flex items-center justify-between">
              <span className="text-sm font-semibold">Line total{quantity > 1 ? ` (×${quantity})` : ''}</span>
              <span className="font-mono font-bold text-lg">{fmt((bundle.product.unitPrice + extraPrice) * quantity)}</span>
            </div>

            {validation.missing.length > 0 ? (
              <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
                Required: {validation.missing.join(', ')}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            <X className="h-4 w-4 mr-1" /> Cancel
          </Button>
          <Button
            onClick={() => {
              if (!bundle || !validation.ok) return;
              const modifiers: Array<{ modifierId: string; name: string; priceDelta: number }> = [];
              for (const g of bundle.groups) {
                for (const m of g.modifiers) {
                  if (selection[g.id]?.has(m.id)) {
                    modifiers.push({ modifierId: m.id, name: m.name, priceDelta: Number(m.priceDelta) });
                  }
                }
              }
              onAdd({
                productId: bundle.product.id,
                productName: bundle.product.name,
                unitPrice: bundle.product.unitPrice + extraPrice,
                sku: bundle.product.sku,
                modifiers,
                quantity,
                note,
              });
            }}
            disabled={!bundle || !validation.ok}
            style={{ background: '#16a34a' }}
          >
            <Check className="h-4 w-4 mr-1" /> Add to cart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};