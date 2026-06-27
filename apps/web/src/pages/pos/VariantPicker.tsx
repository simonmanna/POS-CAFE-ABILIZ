import React, { useEffect, useState } from 'react';
import { Coffee, X, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { VariantFE } from './pos-features-api';

interface Props {
  open: boolean;
  productName: string;
  variants: VariantFE[];
  onClose: () => void;
  onConfirm: (variantId: string, variantName: string, variantPrice: number) => void;
}

const fmt = (n: number) => `UGX ${Number(n || 0).toLocaleString()}`;

export const VariantPicker: React.FC<Props> = ({ open, productName, variants, onClose, onConfirm }) => {
  const [selected, setSelected] = useState('');

  useEffect(() => {
    if (open && variants.length > 0) {
      const def = variants.find((v) => v.sortOrder === 0) ?? variants[0];
      setSelected(def?.id ?? '');
    }
    if (!open) setSelected('');
  }, [open, variants]);

  const picked = variants.find((v) => v.id === selected);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coffee className="h-4 w-4" />
            {productName} — Choose size
          </DialogTitle>
          <DialogDescription>Select a variant to set the base price.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          {variants.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setSelected(v.id)}
              className={`w-full px-4 py-3 rounded-lg border-2 text-left flex items-center justify-between transition-colors ${
                selected === v.id
                  ? 'border-amber-500 bg-amber-50 text-amber-900'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
              }`}
            >
              <span className="flex items-center gap-2">
                {selected === v.id && <Check className="h-4 w-4 text-amber-600" />}
                <span className="font-semibold">{v.name}</span>
              </span>
              <span className="font-mono text-sm">{fmt(v.price)}</span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}><X className="h-4 w-4 mr-1" /> Cancel</Button>
          <Button
            onClick={() => picked && onConfirm(picked.id, picked.name, picked.price)}
            disabled={!picked}
            style={{ background: '#16a34a' }}
          >
            <Check className="h-4 w-4 mr-1" /> Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
