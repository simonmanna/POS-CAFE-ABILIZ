// Order-level discount dialog. Requires a reason; high discounts need a manager PIN.
import React, { useEffect, useState } from 'react';
import { Tag, KeyRound } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  open: boolean;
  initialType: 'percentage' | 'fixed';
  initialValue: number;
  initialReason?: string;
  onClose: () => void;
  onApply: (type: 'percentage' | 'fixed', value: number, reason: string, managerPin?: string) => void;
}

export const DiscountDialog: React.FC<Props> = ({ open, initialType, initialValue, initialReason, onClose, onApply }) => {
  const [type, setType] = useState<'percentage' | 'fixed'>(initialType);
  const [value, setValue] = useState<string>(String(initialValue || ''));
  const [reason, setReason] = useState<string>(initialReason || '');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) { setType(initialType); setValue(String(initialValue || '')); setReason(initialReason || ''); setPin(''); setErr(null); }
  }, [open, initialType, initialValue, initialReason]);

  const num = Number(value);
  const needsManager = (type === 'percentage' && num >= 20) || (type === 'fixed' && num >= 50000);

  const apply = () => {
    if (!Number.isFinite(num) || num <= 0) return setErr('Enter a valid number');
    if (!reason.trim()) return setErr('A reason is required for all discounts');
    if (needsManager && !pin) return setErr('Manager PIN required for high discounts');
    onApply(type, num, reason.trim(), pin || undefined);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Tag className="h-4 w-4" /> Apply order discount</DialogTitle>
          <DialogDescription>Reason is required; ≥ 20% or ≥ 50,000 UGX needs a manager (ADMIN) PIN.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="p-3 rounded-lg border-2 text-left"
            style={{ borderColor: type === 'percentage' ? '#f59e0b' : '#e2e8f0', background: type === 'percentage' ? '#fef3c7' : '#fff' }}
            onClick={() => setType('percentage')}
          >
            <div className="font-bold">Percentage</div>
            <div className="text-xs text-slate-500">% off subtotal</div>
          </button>
          <button
            type="button"
            className="p-3 rounded-lg border-2 text-left"
            style={{ borderColor: type === 'fixed' ? '#f59e0b' : '#e2e8f0', background: type === 'fixed' ? '#fef3c7' : '#fff' }}
            onClick={() => setType('fixed')}
          >
            <div className="font-bold">Fixed</div>
            <div className="text-xs text-slate-500">UGX off subtotal</div>
          </button>
        </div>
        <div>
          <Label>{type === 'percentage' ? 'Percent (%)' : 'Amount (UGX)'}</Label>
          <Input
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0"
            className="text-right text-lg h-11 font-mono font-bold"
            autoFocus
          />
        </div>
        <div>
          <Label>Reason <span className="text-rose-500">*</span></Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Happy hour, VIP friend of owner"
            rows={2}
          />
        </div>
        {needsManager ? (
          <div>
            <Label className="flex items-center gap-1"><KeyRound className="h-3 w-3" /> Manager PIN</Label>
            <Input type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="4-digit PIN" />
          </div>
        ) : null}
        {err ? <p className="text-sm text-rose-600">{err}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={apply} style={{ background: '#f59e0b' }}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
