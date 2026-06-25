/**
 * ItemDialog — create or edit a MenuItem.
 *
 * Handles the full MenuItem payload:
 *   - metadata: code, name, description, image, prep time, availability
 *   - money:    basePrice (major units in the UI, converted to minor units on submit)
 *   - tree:     category picker
 *   - composition: ingredients (product picker with quantity) — fully editable
 *                on both create and edit (replace-all semantics).
 */
import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  useProductPicker,
  type MenuCategory, type MenuItem,
  type CreateMenuItemInput, type IngredientInput,
} from '@/features/menu/api';

interface Props {
  open: boolean;
  item?: MenuItem;
  categories: MenuCategory[];
  onOpenChange: (o: boolean) => void;
  onSubmit: (input: CreateMenuItemInput) => Promise<void>;
}

interface DraftIngredient extends IngredientInput {
  /** Temporary key so React can track rows before the backend assigns an id. */
  _key: string;
}

const newIngredient = (): DraftIngredient => ({
  productId: '',
  quantity: 1,
  _key: Math.random().toString(36).slice(2, 10),
});

export function ItemDialog({ open, item, categories, onOpenChange, onSubmit }: Props) {
  const isEdit = Boolean(item);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [basePrice, setBasePrice] = useState('');
  const [image, setImage] = useState('');
  const [prepTime, setPrepTime] = useState('');
  const [isAvailable, setIsAvailable] = useState(true);
  const [ingredients, setIngredients] = useState<DraftIngredient[]>([newIngredient()]);
  const [productSearch, setProductSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const products = useProductPicker(productSearch);

  // Reset / hydrate form when the dialog opens or the target item changes.
  useEffect(() => {
    if (!open) return;
    if (item) {
      setName(item.name);
      setCode(item.code ?? '');
      setDescription(item.description ?? '');
      setCategoryId(item.categoryId ?? '');
      setBasePrice(item.basePrice != null ? (Number(item.basePrice) / 100).toFixed(2) : '');
      setImage(item.image ?? '');
      setPrepTime(item.preparationTime != null ? String(item.preparationTime) : '');
      setIsAvailable(item.isAvailable);
      setIngredients(
        (item.ingredients ?? []).map((ing) => ({
          productId: ing.productId,
          quantity: Number(ing.quantity),
          _key: ing.id,
        })),
      );
    } else {
      setName(''); setCode(''); setDescription(''); setCategoryId('');
      setBasePrice(''); setImage(''); setPrepTime(''); setIsAvailable(true);
      setIngredients([newIngredient()]);
    }
  }, [open, item]);

  const valid = name.trim() && ingredients.every((i) => i.productId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit menu item` : 'Add menu item'}</DialogTitle>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!valid) return;
            setSubmitting(true);
            try {
              await onSubmit({
                name: name.trim(),
                code: code.trim() || undefined,
                description: description.trim() || undefined,
                categoryId: categoryId || undefined,
                basePrice: basePrice ? Number(basePrice) : undefined,
                image: image.trim() || undefined,
                preparationTime: prepTime ? Number(prepTime) : undefined,
                isAvailable,
                ingredients: ingredients.map(({ productId, quantity }) => ({
                  productId,
                  quantity: quantity ?? 1,
                })),
              });
              onOpenChange(false);
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <Label htmlFor="mi-name">Name *</Label>
              <Input id="mi-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="mi-code">Code (SKU)</Label>
              <Input id="mi-code" placeholder="e.g. MI-ESP" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="mi-cat">Category</Label>
              <Select value={categoryId || '_none'} onValueChange={(v) => setCategoryId(v === '_none' ? '' : v)}>
                <SelectTrigger id="mi-cat"><SelectValue placeholder="Pick category" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">— No category —</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="mi-price">Base price</Label>
              <Input id="mi-price" type="number" step="0.01" min="0"
                placeholder="0.00"
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="mi-prep">Prep time (minutes)</Label>
              <Input id="mi-prep" type="number" min="0" step="1"
                value={prepTime}
                onChange={(e) => setPrepTime(e.target.value)} />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="mi-img">Image URL</Label>
              <Input id="mi-img" placeholder="https://..." value={image} onChange={(e) => setImage(e.target.value)} />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="mi-desc">Description</Label>
              <Textarea id="mi-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="md:col-span-2 flex items-center gap-2">
              <input
                id="mi-avail"
                type="checkbox"
                checked={isAvailable}
                onChange={(e) => setIsAvailable(e.target.checked)}
                className="h-4 w-4"
              />
              <Label htmlFor="mi-avail" className="cursor-pointer">Available on the POS menu</Label>
            </div>
          </div>

          {/* Ingredients */}
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between">
              <Label className="text-base">Ingredients (products)</Label>
              <Button
                type="button" size="sm" variant="outline"
                onClick={() => setIngredients((s) => [...s, newIngredient()])}
              >
                <Plus className="h-4 w-4 mr-1" /> Add ingredient
              </Button>
            </div>

            <Input
              placeholder="Search products..."
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              className="max-w-sm"
            />

            {ingredients.length === 0 && (
              <p className="text-sm text-muted-foreground">No ingredients yet — add at least one product to sell this item.</p>
            )}

            <div className="space-y-2">
              {ingredients.map((ing, idx) => (
                <div key={ing._key} className="flex items-center gap-2">
                  <Select
                    value={ing.productId || '_pick'}
                    onValueChange={(v) => setIngredients((s) =>
                      s.map((row, i) => i === idx ? { ...row, productId: v === '_pick' ? '' : v } : row))}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Pick product" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_pick">— pick —</SelectItem>
                      {(products.data ?? []).map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          <span className="font-mono text-xs mr-2">{p.code}</span>
                          {p.name}
                          {p.station ? <Badge variant="outline" className="ml-2 text-xs">{p.station}</Badge> : null}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number" min="0" step="0.001"
                    className="w-24"
                    placeholder="Qty"
                    value={ing.quantity ?? 1}
                    onChange={(e) => setIngredients((s) =>
                      s.map((row, i) => i === idx ? { ...row, quantity: Number(e.target.value) } : row))}
                  />
                  <Button
                    type="button" size="sm" variant="ghost"
                    onClick={() => setIngredients((s) => s.filter((_, i) => i !== idx))}
                    disabled={ingredients.length === 1}
                  >
                    <X className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
            {ingredients.some((i) => !i.productId) && (
              <p className="text-sm text-destructive">
                Pick a product for every ingredient row before saving.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !valid}>
              {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create item'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}