import { useAuthStore } from '@/stores/auth.store';
const orgCur = () => useAuthStore.getState().organization?.currencyCode ?? 'IDR';
// Order-level discount dialog. Asks for % or fixed amount, calls back with the value.
// Parent decides whether manager override is required (we don't block here).
import React, { useEffect, useState } from 'react';
import { Tag, DollarSign, Percent } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { DiscountType } from '@/features/pos/types';

interface Props {
  open: boolean;
  initialPercent: number;
  onClose: () => void;
  /** Returns the discount value. percentage mode → value is percent; fixed mode → value in minor units. */
  onApply: (percent: number) => void;
  onApplyEx?: (amount: number, type: DiscountType) => void;
  /**
   * Audit#2 N-03 — the org's approval thresholds, served by GET /pos/settings.
   * This dialog used to hardcode 10% / 50,000, so its warning banner told the
   * cashier something the server did not believe: tighten the org threshold and
   * the banner stayed silent right up to the 403 at the payment screen.
   * The parent owns the rule; this component only renders its verdict.
   */
  thresholdPercent: number;
  /** 0 = the org has set no absolute-amount tier. */
  thresholdAmount?: number;
  /** Cart subtotal, so a fixed amount is judged the way the server judges it. */
  subtotal?: number;
}

const QUICK_PERCENTS = [5, 10, 15, 20, 25, 50];
const QUICK_FIXED = [5000, 10000, 20000, 50000];

export const DiscountDialog: React.FC<Props> = ({ open, initialPercent, onClose, onApply, onApplyEx, thresholdPercent, thresholdAmount = 0, subtotal = 0 }) => {
  const [mode, setMode] = useState<DiscountType>('percentage');
  const [value, setValue] = useState(String(initialPercent || ''));
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setValue(String(initialPercent || '')); setErr(null); setMode('percentage'); }
  }, [open, initialPercent]);

  const num = Number(value);
  const validPercent = Number.isFinite(num) && num > 0 && num <= 100;
  const validFixed = Number.isFinite(num) && num > 0;
  const valid = mode === 'percentage' ? validPercent : validFixed;
  // Mirrors evaluatePricingAuthority exactly: a fixed amount is compared as a
  // percentage of what the cart is worth, and the amount tier is a separate,
  // optional gate. Strictly greater-than, like the server.
  const asPercent = mode === 'fixed_amount' ? (subtotal > 0 ? (num / subtotal) * 100 : 0) : num;
  const requiresOverride = num > 0 && (
    asPercent > thresholdPercent || (thresholdAmount > 0 && (mode === 'fixed_amount' ? num : (subtotal * num) / 100) > thresholdAmount)
  );

  const doApply = () => {
    if (!valid) {
      setErr(mode === 'percentage' ? 'Enter a percent between 0 and 100' : 'Enter a valid amount');
      return;
    }
    if (onApplyEx) {
      onApplyEx(num, mode);
    } else {
      onApply(num);
    }
    onClose();
  };

  const quickLabel = (v: number) =>
    mode === 'percentage' ? `${v}%` : `${orgCur()} ${v.toLocaleString()}`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Tag className="h-4 w-4" /> Order-level discount</DialogTitle>
          <DialogDescription>
            Choose percentage or fixed amount. Discounts ≥ 10% (or {orgCur()} 50,000) need a manager override.
          </DialogDescription>
        </DialogHeader>

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

        {/* Quick buttons */}
        <div className="flex flex-wrap gap-1.5">
          {(mode === 'percentage' ? QUICK_PERCENTS : QUICK_FIXED).map((v) => (
            <button
              key={v}
              type="button"
              className="px-3 py-1.5 rounded-md bg-slate-100 hover:bg-amber-100 text-xs font-bold"
              onClick={() => setValue(String(v))}
            >
              {quickLabel(v)}
            </button>
          ))}
        </div>

        <div>
          <Label>{mode === 'percentage' ? 'Percent off (%)' : 'Amount off ({orgCur()})'}</Label>
          <Input
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0"
            className="text-right text-lg h-11 font-mono font-bold"
            autoFocus
          />
        </div>

        {requiresOverride ? (
          <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded px-3 py-2">
            ⚠ This discount requires a manager override. Tap Apply, then verify the manager PIN.
          </div>
        ) : null}

        {err ? <p className="text-sm text-rose-600">{err}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={doApply}
            style={{ background: '#f59e0b' }}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};