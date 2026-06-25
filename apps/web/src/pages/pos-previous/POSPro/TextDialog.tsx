// Generic text input dialog used for void reason and per-item notes.
import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface Props {
  open: boolean;
  title: string;
  description?: string;
  placeholder?: string;
  initial?: string;
  confirmLabel?: string;
  confirmColor?: string;
  multiline?: boolean;
  onClose: () => void;
  onSubmit: (text: string) => void;
}

export const TextDialog: React.FC<Props> = ({
  open, title, description, placeholder, initial, confirmLabel, confirmColor, multiline, onClose, onSubmit,
}) => {
  const [v, setV] = useState(initial || '');
  useEffect(() => { if (open) setV(initial || ''); }, [open, initial]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {multiline ? (
          <textarea
            value={v}
            onChange={(e) => setV(e.target.value)}
            rows={3}
            autoFocus
            placeholder={placeholder}
            className="w-full px-3 py-2 rounded border border-slate-200 text-sm"
          />
        ) : (
          <input
            type="text"
            value={v}
            onChange={(e) => setV(e.target.value)}
            autoFocus
            placeholder={placeholder}
            className="w-full h-10 px-3 rounded border border-slate-200 text-sm"
          />
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { if (v.trim()) onSubmit(v.trim()); }} style={{ background: confirmColor || '#1a7fcf' }}>{confirmLabel || 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
