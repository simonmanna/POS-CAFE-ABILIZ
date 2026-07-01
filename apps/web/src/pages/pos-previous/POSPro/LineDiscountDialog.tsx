// Per-line discount dialog. Requires a reason and (for high discounts) a manager PIN.
import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Tag, KeyRound, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { posApi } from './api';
import type { OrderItem } from './types';

const fmt = (n: number) => `UGX ${Number(n || 0).toLocaleString()}`;

interface Props {
  open: boolean;
  orderId: number | null;
  item: OrderItem | null;
  onClose: () => void;
  onApplied: () => void;
}

export const LineDiscountDialog: React.FC<Props> = ({ open, orderId, item, onClose, onApplied }) => {
  const [type, setType] = useState<'percentage' | 'fixed'>('percentage');
  const [value, setValue] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [pin, setPin] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open && item) {
      setType('percentage');
      setValue(item.discountValue ? String(item.discountValue) : '');
      setReason(item.discountReason || '');
      setPin(''); setErr(null);
    } else if (!open) {
      setValue(''); setReason(''); setPin(''); setErr(null);
    }
  }, [open, item?.id]);

  const lineBase = useMemo(() => {
    if (!item) return 0;
    return (item.totalPrice || 0) + (item.addOnsTotal || 0);
  }, [item]);

  const discountAmount = useMemo(() => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (type === 'percentage') return Math.min(lineBase * (n / 100), lineBase);
    return Math.min(n, lineBase);
  }, [value, type, lineBase]);

  const needsManager = useMemo(() => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return false;
    if (type === 'percentage') return n >= 20;
    return discountAmount >= 50000;
  }, [value, type, discountAmount]);

  const apply = async () => {
    if (!orderId || !item) return;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return setErr('Enter a discount value > 0');
    if (!reason.trim()) return setErr('A reason is required for all discounts');
    if (needsManager && !pin) return setErr('Manager PIN required for this discount');
    try {
      setBusy(true); setErr(null);
      await posApi.applyLineDiscount(orderId, item.id, {
        discountType: type, discountValue: n, discountReason: reason.trim(), managerPin: pin || undefined,
      });
      toast.success(`Discount applied: -${fmt(discountAmount)}`);
      onApplied();
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || 'Failed to apply');
    } finally { setBusy(false); }
  };

  const clear = async () => {
    if (!orderId || !item) return;
    try {
      setBusy(true); setErr(null);
      await posApi.clearLineDiscount(orderId, item.id);
      toast.success('Discount cleared');
      onApplied();
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || 'Failed to clear');
    } finally { setBusy(false); }
  };

  if (!item) return null;
  const hasExisting = (item.discountAmount || 0) > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Tag className="h-4 w-4" /> Line discount</DialogTitle>
          <DialogDescription>Discount a single item. Reason is required; high discounts need a manager PIN.</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="font-bold text-sm">{item.menu?.name}</div>
          <div className="text-xs text-slate-500">{item.quantity} × {fmt(item.unitPrice)}{item.addOnsTotal ? ` + add-ons ${fmt(item.addOnsTotal)}` : ''}</div>
          <div className="text-sm font-mono font-bold mt-1">Line base: {fmt(lineBase)}</div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="p-3 rounded-lg border-2 text-left"
            style={{ borderColor: type === 'percentage' ? '#f59e0b' : '#e2e8f0', background: type === 'percentage' ? '#fef3c7' : '#fff' }}
            onClick={() => setType('percentage')}
          >
            <div className="font-bold">Percentage</div>
            <div className="text-xs text-slate-500">% off line total</div>
          </button>
          <button
            type="button"
            className="p-3 rounded-lg border-2 text-left"
            style={{ borderColor: type === 'fixed' ? '#f59e0b' : '#e2e8f0', background: type === 'fixed' ? '#fef3c7' : '#fff' }}
            onClick={() => setType('fixed')}
          >
            <div className="font-bold">Fixed</div>
            <div className="text-xs text-slate-500">UGX off line</div>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>{type === 'percentage' ? 'Percent (%)' : 'Amount (UGX)'}</Label>
            <Input
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0"
              className="text-right font-mono font-bold"
              autoFocus
            />
          </div>
          <div>
            <Label>Discount amount</Label>
            <div className="h-10 rounded-md border border-slate-200 bg-emerald-50 text-emerald-700 font-mono font-bold flex items-center justify-end px-3">
              {fmt(discountAmount)}
            </div>
          </div>
        </div>

        <div>
          <Label>Reason <span className="text-rose-500">*</span></Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Loyalty customer, manager override, VIP"
            rows={2}
          />
        </div>

        {needsManager ? (
          <div>
            <Label className="flex items-center gap-1"><KeyRound className="h-3 w-3" /> Manager PIN</Label>
            <Input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="4-digit PIN"
            />
            <p className="text-[11px] text-amber-700 mt-1">≥ 20% or ≥ 50,000 UGX requires a manager (ADMIN) PIN.</p>
          </div>
        ) : null}

        {err ? <p className="text-sm text-rose-600">{err}</p> : null}

        <DialogFooter>
          {hasExisting ? (
            <Button variant="outline" onClick={clear} disabled={busy} className="mr-auto text-rose-600">
              <X className="h-4 w-4 mr-1" /> Remove existing
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={apply} disabled={busy} style={{ background: '#f59e0b' }}>
            Apply {fmt(discountAmount)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
