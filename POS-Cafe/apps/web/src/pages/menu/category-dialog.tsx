import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CreateCategoryInput, MenuCategory } from '@/features/menu/api';

interface Props {
  open: boolean;
  category?: MenuCategory | null;
  onOpenChange: (o: boolean) => void;
  onSubmit: (input: CreateCategoryInput) => Promise<void>;
}

export function CategoryDialog({ open, category, onOpenChange, onSubmit }: Props) {
  const isEdit = Boolean(category);
  const [name, setName] = useState('');
  const [displayOrder, setDisplayOrder] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (category) {
      setName(category.name);
      setDisplayOrder(String(category.displayOrder));
    } else {
      setName('');
      setDisplayOrder('');
    }
  }, [open, category]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit category' : 'Add category'}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setSubmitting(true);
            try {
              await onSubmit({
                name: name.trim(),
                displayOrder: displayOrder ? Number(displayOrder) : undefined,
              });
              onOpenChange(false);
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <div>
            <Label htmlFor="cat-name">Name</Label>
            <Input
              id="cat-name"
              autoFocus
              placeholder="e.g. Hot Drinks"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor="cat-order">Display order (optional)</Label>
            <Input
              id="cat-order"
              type="number"
              placeholder="0 = top"
              value={displayOrder}
              onChange={(e) => setDisplayOrder(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create category'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
