import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Hash } from 'lucide-react';

interface Props {
  open: boolean;
  initialTaxRate: number;
  initialSCRate: number;
  onClose: () => void;
  onApply: (taxRate: number, scRate: number) => void;
}

export const TaxServiceDialog: React.FC<Props> = ({ open, initialTaxRate, initialSCRate, onClose, onApply }) => {
  const [tax, setTax] = useState(String(initialTaxRate || 0));
  const [sc, setSC] = useState(String(initialSCRate || 0));
  useEffect(() => {
    if (open) { setTax(String(initialTaxRate || 0)); setSC(String(initialSCRate || 0)); }
  }, [open, initialTaxRate, initialSCRate]);

  const presets = [
    { label: '0% / 0%', t: 0, s: 0 },
    { label: 'VAT 18%', t: 18, s: 0 },
    { label: 'VAT 18% + 5% SC', t: 18, s: 5 },
    { label: 'VAT 20% + 10% SC', t: 20, s: 10 },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Hash className="h-4 w-4" /> Tax & service charge</DialogTitle>
          <DialogDescription>Pick a preset or set your own. Applied on top of the discounted subtotal.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className="p-2 rounded-lg border border-slate-200 hover:border-blue-400 hover:bg-blue-50 text-left"
              onClick={() => { setTax(String(p.t)); setSC(String(p.s)); }}
            >
              <div className="text-sm font-bold">{p.label}</div>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Tax (%)</Label>
            <Input type="number" value={tax} onChange={(e) => setTax(e.target.value)} className="text-right font-mono" />
          </div>
          <div>
            <Label>Service charge (%)</Label>
            <Input type="number" value={sc} onChange={(e) => setSC(e.target.value)} className="text-right font-mono" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onApply(Number(tax) || 0, Number(sc) || 0)}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
