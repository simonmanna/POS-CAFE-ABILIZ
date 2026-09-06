import { useAuthStore } from '@/stores/auth.store';
const orgCur = () => useAuthStore.getState().organization?.currencyCode ?? 'IDR';
// Per-line discount dialog. Updates the cart line's discount + reason in the
// store. The reason is REQUIRED for any line discount (A-002): the backend's
// pricing policy rejects a discounted sale without one at quote/settle time.
import React, { useEffect, useState } from 'react';
import { Tag, Percent, DollarSign } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CartLine, DiscountType } from '@/features/pos/types';

interface Props {
  open: boolean;
  line: CartLine | null;
  onClose: () => void;
  /** Receives the percent/fixed amount, the type, and the (required) reason. */
  onApply: (lineId: string, amount: number, type: DiscountType, reason: string) => void;
}

const fmt = (n: number) => `${orgCur()} ${Number(n || 0).toLocaleString()}`;

const COMMON_REASONS = ['Staff', 'Regular customer', 'Promotion', 'Damaged item', 'Price match'];

export const LineDiscountDialog: React.FC<Props> = ({ open, line, onClose, onApply }) => {
  const [mode, setMode] = useState<DiscountType>('percentage');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open && line) {
      setValue(String(line.discountPercent || ''));
      setMode(line.discountType ?? 'percentage');
      setReason(line.discountReason ?? '');
      setErr(null);
    } else if (!open) {
      setValue(''); setReason(''); setErr(null);
    }
  }, [open, line?.lineId]);

  if (!line) return null;

  const num = Number(value);
  const validPercent = Number.isFinite(num) && num >= 0 && num <= 100;
  const validFixed = Number.isFinite(num) && num >= 0;
  const valid = mode === 'percentage' ? validPercent : validFixed;
  const requiresOverride = mode === 'percentage' ? num > 10 : num > 50000;

  const currentDisc = line.discountType === 'fixed_amount'
    ? (line.discountAmount ?? 0)
    : line.quantity * line.unitPrice * (line.discountPercent / 100);
  const lineSub = line.quantity * line.unitPrice - currentDisc;
  const newDisc = mode === 'fixed_amount' ? (validFixed ? num : 0) : line.quantity * line.unitPrice * (validPercent ? num / 100 : 0);
  const newSub = Math.max(0, line.quantity * line.unitPrice - newDisc);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Tag className="h-4 w-4" /> Line discount</DialogTitle>
          <DialogDescription>Discount a single item. A reason is required; ≥10% or {orgCur()} 50,000 needs a manager override.</DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="font-bold text-sm">{line.name}</div>
          <div className="text-xs text-slate-500">
            {line.quantity} × {fmt(line.unitPrice)} = {fmt(line.quantity * line.unitPrice)}
          </div>
        </div>

        {/* Mode toggle */}
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          <button
            type="button"
            className={`flex-1 py-2 text-xs font-bold flex items-center justify-center gap-1.5 transition ${
              mode === 'percentage' ? 'bg-amber-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
            }`}
            onClick={() => setMode('percentage')}
          >
            <Percent className="w-3.5 h-3.5" /> Percentage
          </button>
          <button
            type="button"
            className={`flex-1 py-2 text-xs font-bold flex items-center justify-center gap-1.5 transition ${
              mode === 'fixed_amount' ? 'bg-amber-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
            }`}
            onClick={() => setMode('fixed_amount')}
          >
            <DollarSign className="w-3.5 h-3.5" /> Fixed Amount
          </button>
        </div>

        <div>
          <Label>{mode === 'percentage' ? 'Percent off (%)' : `Amount off (${orgCur()})`}</Label>
          <Input
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0"
            className="text-right text-lg h-11 font-mono font-bold"
            autoFocus
          />
        </div>

        {/* A-002: the reason is mandatory — the server rejects a discounted
            line without one, so collect it up front instead of failing the
            sale at quote time with no way to fix it. */}
        <div>
          <Label>Reason (required)</Label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this line discounted?"
          />
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {COMMON_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className="px-2 py-0.5 rounded-full border border-slate-200 bg-white text-[11px] font-semibold text-slate-600 hover:border-amber-400 hover:text-amber-700"
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded border border-slate-200 px-3 py-2 bg-slate-50">
            <div className="text-xs text-slate-500">Current</div>
            <div className="font-mono font-bold">{fmt(lineSub)}</div>
          </div>
          <div className="rounded border border-emerald-200 px-3 py-2 bg-emerald-50">
            <div className="text-xs text-emerald-700">After discount</div>
            <div className="font-mono font-bold text-emerald-700">{fmt(valid ? newSub : lineSub)}</div>
          </div>
        </div>

        {requiresOverride ? (
          <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded px-3 py-2">
            ✓ This line discount requires a manager override at charge time.
          </div>
        ) : null}

        {err ? <p className="text-sm text-rose-600">{err}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => {
              if (!valid) { setErr(mode === 'percentage' ? 'Enter a percent between 0 and 100' : 'Enter a valid amount'); return; }
              if (!reason.trim()) { setErr('A discount reason is required'); return; }
              onApply(line.lineId, num, mode, reason.trim());
              onClose();
            }}
            style={{ background: '#f59e0b' }}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
