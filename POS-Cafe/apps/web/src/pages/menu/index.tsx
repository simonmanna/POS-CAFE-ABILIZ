import { useMemo, useState } from 'react';
import { Coffee, Edit, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { PERMISSIONS } from '@erp/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { notify } from '@/lib/notify';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useAuthStore } from '@/stores/auth.store';
import {
  useMenuCategories,
  useMenuItems,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
  useCreateMenuItem,
  useUpdateMenuItem,
  useToggleAvailability,
  useDisableMenuItem,
  type MenuCategory,
  type MenuItem,
} from '@/features/menu/api';
import { CategoryDialog } from './category-dialog';
import { ItemDialog } from './item-dialog';

export function MenuPage() {
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 250);

  const [catDialog, setCatDialog] = useState<{ open: boolean; category?: MenuCategory | null }>({ open: false });
  const [itemDialog, setItemDialog] = useState<{ open: boolean; item?: MenuItem }>({ open: false });
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'category' | 'item'; id: string; name: string } | null>(null);

  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canViewMenu = hasPermission(PERMISSIONS.menu.view);
  const canCreateMenu = hasPermission(PERMISSIONS.menu.create);
  const canEditMenu = hasPermission(PERMISSIONS.menu.edit);
  const canDeleteMenu = hasPermission(PERMISSIONS.menu.delete);
  const canViewCat = hasPermission(PERMISSIONS.menuCategories.view);
  const canCreateCat = hasPermission(PERMISSIONS.menuCategories.create);
  const canEditCat = hasPermission(PERMISSIONS.menuCategories.edit);
  const canDeleteCat = hasPermission(PERMISSIONS.menuCategories.delete);

  const cats = useMenuCategories();
  const items = useMenuItems();
  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();
  const deleteCategory = useDeleteCategory();
  const createItem = useCreateMenuItem();
  const updateItem = useUpdateMenuItem();
  const toggleAvail = useToggleAvailability();
  const disableItem = useDisableMenuItem();

  const filteredItems = useMemo(() => {
    const all = items.data ?? [];
    return all.filter((it) => {
      if (selectedCat && it.categoryId !== selectedCat) return false;
      if (!debounced) return true;
      const q = debounced.toLowerCase();
      return (
        it.name.toLowerCase().includes(q) ||
        (it.code ?? '').toLowerCase().includes(q) ||
        (it.description ?? '').toLowerCase().includes(q)
      );
    });
  }, [items.data, selectedCat, debounced]);

  const selectedCatName = cats.data?.find((c) => c.id === selectedCat)?.name;

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === 'category') {
        await deleteCategory.mutateAsync(deleteTarget.id);
        notify.success('Category deleted');
        if (selectedCat === deleteTarget.id) setSelectedCat(null);
      } else {
        await disableItem.mutateAsync(deleteTarget.id);
        notify.success('Item disabled');
      }
    } catch {
      notify.error('Could not delete');
    }
    setDeleteTarget(null);
  };

  if (!canViewMenu && !canViewCat) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Menu</h1>
        <p className="text-sm text-muted-foreground">You do not have permission to view the menu.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Menu</h1>
        <p className="text-sm text-muted-foreground">
          Build your cafe menu from existing products. Menu items are what customers order;
          products remain the master inventory behind them.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        {canViewCat && (
          <Card>
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-base">Categories</CardTitle>
              {canCreateCat && (
                <Button size="sm" variant="outline" onClick={() => setCatDialog({ open: true })}>
                  <Plus className="h-4 w-4 mr-1" /> Add
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-1">
              <button
                type="button"
                onClick={() => setSelectedCat(null)}
                className={
                  'w-full text-left rounded-md px-3 py-2 text-sm transition-colors ' +
                  (selectedCat === null
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted')
                }
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">All items</span>
                  <Badge variant="secondary">{items.data?.length ?? 0}</Badge>
                </div>
              </button>

              {cats.isLoading && (
                <div className="space-y-2">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              )}

              {cats.data?.map((c) => {
                const count = (items.data ?? []).filter((it) => it.categoryId === c.id).length;
                return (
                  <div
                    key={c.id}
                    className="group flex items-center gap-1"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedCat(c.id)}
                      className={
                        'flex-1 text-left rounded-md px-3 py-2 text-sm transition-colors ' +
                        (selectedCat === c.id
                          ? 'bg-primary text-primary-foreground'
                          : 'hover:bg-muted')
                      }
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{c.name}</span>
                        <Badge variant={selectedCat === c.id ? 'secondary' : 'outline'}>{count}</Badge>
                      </div>
                    </button>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      {canEditCat && (
                        <Button
                          size="sm" variant="ghost" className="h-7 w-7 p-0"
                          onClick={() => setCatDialog({ open: true, category: c })}
                        >
                          <Edit className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {canDeleteCat && (
                        <Button
                          size="sm" variant="ghost" className="h-7 w-7 p-0"
                          onClick={() => setDeleteTarget({ type: 'category', id: c.id, name: c.name })}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive/70" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">
                {selectedCatName ?? 'All items'}{' '}
                <span className="text-muted-foreground font-normal text-sm ml-2">
                  ({filteredItems.length})
                </span>
              </CardTitle>
              <div className="flex gap-2">
                <Input
                  placeholder="Search items..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-56"
                />
                {canCreateMenu && (
                  <Button onClick={() => setItemDialog({ open: true })}>
                    <Plus className="h-4 w-4 mr-1" /> Add menu item
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {items.isLoading && (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            )}

            {!items.isLoading && filteredItems.length === 0 && (
              <div className="text-center text-muted-foreground py-12">
                <Coffee className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p>No menu items yet.</p>
                <p className="text-sm">Add one to make it available on the POS terminal.</p>
              </div>
            )}

            <div className="space-y-2">
              {filteredItems.map((it) => (
                <ItemRow
                  key={it.id}
                  item={it}
                  canEdit={canEditMenu}
                  canDelete={canDeleteMenu}
                  onEdit={() => setItemDialog({ open: true, item: it })}
                  onToggleAvail={() =>
                    toggleAvail.mutate(
                      { id: it.id, isAvailable: !it.isAvailable },
                      {
                        onSuccess: () =>
                          notify.success(it.isAvailable ? "86'd from menu" : 'Re-enabled'),
                        onError: () => notify.error('Could not update availability'),
                      },
                    )
                  }
                  onDelete={() => setDeleteTarget({ type: 'item', id: it.id, name: it.name })}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <CategoryDialog
        open={catDialog.open}
        category={catDialog.category ?? null}
        onOpenChange={(o) => setCatDialog((s) => ({ ...s, open: o, category: o ? s.category : null }))}
        onSubmit={(input) =>
          new Promise<void>((resolve, reject) => {
            if (catDialog.category) {
              updateCategory.mutate(
                { id: catDialog.category.id, data: input },
                {
                  onSuccess: () => { notify.success('Category updated'); resolve(); },
                  onError: (e: any) => { notify.error(e?.message ?? 'Could not update category'); reject(e); },
                },
              );
            } else {
              createCategory.mutate(input, {
                onSuccess: () => { notify.success(`Category "${input.name}" created`); resolve(); },
                onError: (e: any) => { notify.error(e?.message ?? 'Could not create category'); reject(e); },
              });
            }
          })
        }
      />

      <ItemDialog
        open={itemDialog.open}
        item={itemDialog.item}
        categories={cats.data ?? []}
        onOpenChange={(o) => setItemDialog((s) => ({ ...s, open: o }))}
        onSubmit={(input) =>
          new Promise<void>((resolve, reject) => {
            const onSuccess = () => { notify.success(itemDialog.item ? 'Item updated' : 'Item created'); resolve(); };
            const onError = (e: any) => { notify.error(e?.message ?? 'Could not save item'); reject(e); };
            if (itemDialog.item) {
              updateItem.mutate(
                { id: itemDialog.item.id, patch: input },
                { onSuccess, onError },
              );
            } else {
              createItem.mutate(input, { onSuccess, onError });
            }
          })
        }
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.type === 'category' ? 'Category' : 'Menu Item'}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === 'category'
                ? `Delete category "${deleteTarget?.name}"? Items in this category will not be deleted.`
                : `Disable "${deleteTarget?.name}"? It will disappear from the POS menu but stay in the database.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleteTarget?.type === 'category' ? 'Delete' : 'Disable'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ItemRow({
  item, canEdit, canDelete, onEdit, onToggleAvail, onDelete,
}: {
  item: MenuItem;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onToggleAvail: () => void;
  onDelete: () => void;
}) {
  const priceMajor = item.basePrice != null ? Number(item.basePrice) / 100 : null;
  const ingredientCount = item.ingredients?.length ?? 0;

  return (
    <div
      className="flex items-center gap-3 rounded-lg border p-3 hover:bg-accent/40 hover:border-accent cursor-pointer transition-all group"
      onClick={canEdit ? onEdit : undefined}
    >
      <div
        className={`w-1 self-stretch rounded-full shrink-0 ${item.isAvailable ? 'bg-emerald-400' : 'bg-slate-300'}`}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold truncate group-hover:text-primary transition-colors">{item.name}</span>
          {item.code && <Badge variant="outline" className="font-mono text-[10px]">{item.code}</Badge>}
          {!item.isAvailable && (
            <Badge variant="destructive" className="text-[10px]">86&apos;d</Badge>
          )}
        </div>
        {item.description && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{item.description}</p>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-muted-foreground">
          {priceMajor != null && <span className="font-bold text-foreground">${priceMajor.toFixed(2)}</span>}
          {item.preparationTime != null && <span>{item.preparationTime}m</span>}
          <span>{ingredientCount} ingredient{ingredientCount === 1 ? '' : 's'}</span>
          <span
            className={`font-medium ${item.isAvailable ? 'text-emerald-600' : 'text-slate-400'}`}
          >
            {item.isAvailable ? 'Active' : 'Unavailable'}
          </span>
        </div>
      </div>

      <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" onClick={onToggleAvail} className="h-8 w-8 p-0" title={item.isAvailable ? '86 (mark unavailable)' : 'Re-enable'}>
          {item.isAvailable ? <EyeOff className="h-4 w-4 text-amber-500" /> : <Eye className="h-4 w-4 text-emerald-500" />}
        </Button>
        {canDelete && (
          <Button size="sm" variant="ghost" onClick={onDelete} className="h-8 w-8 p-0" title="Disable (soft delete)">
            <Trash2 className="h-4 w-4 text-destructive/70 hover:text-destructive" />
          </Button>
        )}
      </div>
    </div>
  );
}

export default MenuPage;
