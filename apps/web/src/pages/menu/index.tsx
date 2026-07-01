import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Coffee, Edit, Plus, Trash2, Search, Eye,
  Tag, FolderOpen, List, DollarSign, Clock, Layers, RotateCcw,
} from 'lucide-react';
import { PERMISSIONS } from '@erp/shared';
import { Button } from '@/components/ui/button';
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
import { formatCurrency } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import {
  useMenuCategories,
  useMenuItems,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
  useRestoreCategory,
  useCreateMenuItem,
  useUpdateMenuItem,
  useDisableMenuItem,
  type MenuCategory,
  type MenuItem,
} from '@/features/menu/api';
import { CategoryDialog } from './category-dialog';
import { ItemDialog } from './item-dialog';

export function MenuPage() {
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebouncedValue(search, 250);

  const [catDialog, setCatDialog] = useState<{ open: boolean; category?: MenuCategory | null }>({ open: false });
  const [itemDialog, setItemDialog] = useState<{ open: boolean; item?: MenuItem }>({ open: false });
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'category' | 'item'; id: string; name: string } | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

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
  const items = useMenuItems({ page, pageSize: 20, search: debounced || undefined });
  const restoreCategory = useRestoreCategory();

  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();
  const deleteCategory = useDeleteCategory();
  const createItem = useCreateMenuItem();
  const updateItem = useUpdateMenuItem();
  const disableItem = useDisableMenuItem();

  const allPaginatedItems = items.data?.data ?? [];
  const activeItems = useMemo(() => {
    return allPaginatedItems.filter((it) => {
      if (selectedCat && it.categoryId !== selectedCat) return false;
      return true;
    });
  }, [allPaginatedItems, selectedCat]);

  useEffect(() => { setPage(1); }, [debounced]);

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === 'category') {
        await deleteCategory.mutateAsync(deleteTarget.id);
        notify.success('Category moved to Recently deleted');
        if (selectedCat === deleteTarget.id) setSelectedCat(null);
      } else {
        await disableItem.mutateAsync(deleteTarget.id);
        notify.success('Item disabled successfully');
      }
    } catch {
      notify.error('Could not delete');
    }
    setDeleteTarget(null);
  };

  const handleRestore = async (c: MenuCategory) => {
    try {
      await restoreCategory.mutateAsync(c.id);
      notify.success(`Category "${c.name}" restored`);
    } catch {
      notify.error('Could not restore category');
    }
  };

  const meta = items.data?.meta;

  if (!canViewMenu && !canViewCat) {
    return (
      <div className="space-y-4 p-6">
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-6 text-center">
          <h1 className="text-2xl font-semibold text-destructive">Access Denied</h1>
          <p className="mt-2 text-sm text-muted-foreground">You do not have permission to view the menu.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="border-l-4 border-[#3b82f6] pl-4 space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Menu</h1>
          <p className="text-sm text-gray-500">
            Build your cafe menu from existing products. Menu items are what customers order;
            products remain the master inventory behind them.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6">
        {/* Categories Sidebar */}
        {canViewCat && (
          <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="bg-[#3b82f6] text-white p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 bg-white/10 rounded-lg">
                    <FolderOpen className="h-4 w-4 text-white" />
                  </div>
                  <h3 className="font-semibold text-sm">Categories</h3>
                </div>
                {canCreateCat && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setCatDialog({ open: true })}
                    className="h-8 w-8 p-0 text-white hover:bg-white/20"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            <div className="p-3 space-y-1 max-h-[600px] overflow-y-auto">
              <button
                type="button"
                onClick={() => setSelectedCat(null)}
                className={
                  'w-full text-left rounded-lg px-3 py-2.5 text-sm transition-all ' +
                  (selectedCat === null
                    ? 'bg-[#3b82f6]/10 text-[#3b82f6] border border-[#3b82f6]/20'
                    : 'bg-gray-50 text-gray-700')
                }
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <List className="h-4 w-4" />
                    <span className="font-medium">All items</span>
                  </div>
                  <Badge variant="secondary" className="bg-gray-100 text-gray-700">
                    {activeItems.length}
                  </Badge>
                </div>
              </button>

              {cats.isLoading && (
                <div className="space-y-2 pt-2">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-10 w-full rounded-lg" />
                  ))}
                </div>
              )}

              {cats.data?.map((c) => {
                const count = activeItems.filter((it) => it.categoryId === c.id).length;
                return (
                  <div key={c.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setSelectedCat(c.id)}
                      className={
                        'flex-1 text-left rounded-lg px-3 py-2.5 text-sm transition-all bg-gray-50 ' +
                        (selectedCat === c.id
                          ? 'bg-[#3b82f6]/10 text-[#3b82f6] border border-[#3b82f6]/20'
                          : 'hover:bg-gray-50 text-gray-700')
                      }
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Tag className="h-4 w-4" />
                          <span className="font-medium truncate">{c.name}</span>
                        </div>
                        <Badge
                          variant="secondary"
                          className={selectedCat === c.id ? 'bg-[#3b82f6]/20 text-[#3b82f6]' : 'bg-gray-100 text-gray-700'}
                        >
                          {count}
                        </Badge>
                      </div>
                    </button>
                    <div className="flex gap-0.5 opacity-100 transition-opacity">
                      {canEditCat && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 bg-blue-50 text-blue-600"
                          onClick={() => setCatDialog({ open: true, category: c })}
                        >
                          <Edit className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {canDeleteCat && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 bg-red-50 text-red-600"
                          onClick={() => setDeleteTarget({ type: 'category', id: c.id, name: c.name })}
                          title="Soft-delete (move to bin)"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Deleted categories — restore bin */}
            {canDeleteCat && (
              <div className="p-3 pt-0">
                <button
                  type="button"
                  onClick={() => setShowDeleted((v) => !v)}
                  className="flex items-center gap-2 w-full text-left rounded-lg px-3 py-2 text-sm font-semibold text-gray-500 hover:bg-gray-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Recently deleted
                </button>
                {showDeleted && (
                  <div className="mt-1 space-y-1">
                    {cats.data?.filter((c) => (c as any).deletedAt).length === 0 && (
                      <p className="text-xs text-gray-400 px-3 py-2">No deleted categories.</p>
                    )}
                    {(cats.data?.filter((c) => (c as any).deletedAt) ?? []).map((c) => (
                      <div key={c.id} className="flex items-center justify-between rounded-lg px-3 py-2 bg-gray-50 opacity-60">
                        <span className="text-sm text-gray-600 truncate">{c.name}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-emerald-600 hover:bg-emerald-50"
                          onClick={() => handleRestore(c)}
                          disabled={restoreCategory.isPending}
                          title="Restore category"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Items List */}
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-gray-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-[#3b82f6]/10 rounded-lg">
                  <Coffee className="h-5 w-5 text-[#3b82f6]" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">
                    {cats.data?.find((c) => c.id === selectedCat)?.name ?? 'All items'}
                  </h3>
                  <p className="text-xs text-gray-500">
                    {meta?.total ?? 0} item{(meta?.total ?? 0) !== 1 ? 's' : ''}
                    {debounced ? ' (filtered)' : ''}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <Input
                    placeholder="Search items..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-56 pl-9 h-10 border-gray-200 rounded-lg focus:border-[#3b82f6] focus:ring-[#3b82f6]/20"
                  />
                </div>
                {canCreateMenu && (
                  <Button
                    onClick={() => setItemDialog({ open: true })}
                    className="gap-2 bg-[#3b82f6] hover:bg-[#2563eb] text-white"
                  >
                    <Plus className="h-4 w-4" />
                    Add menu item
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="p-4">
            {items.isLoading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-20 w-full rounded-lg" />
                ))}
              </div>
            ) : activeItems.length === 0 ? (
              <div className="text-center py-12">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 mx-auto">
                  <Coffee className="h-8 w-8 text-gray-400" />
                </div>
                <h3 className="text-lg font-semibold text-gray-800">No menu items yet</h3>
                <p className="mt-1 text-sm text-gray-500">
                  {search ? 'Try adjusting your search terms' : 'Add one to make it available on the POS terminal'}
                </p>
                {!search && canCreateMenu && (
                  <Button
                    onClick={() => setItemDialog({ open: true })}
                    className="mt-4 bg-[#3b82f6] hover:bg-[#2563eb] text-white"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add Menu Item
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {activeItems.map((it) => (
                  <ItemRow
                    key={it.id}
                    item={it}
                    canEdit={canEditMenu}
                    canDelete={canDeleteMenu}
                    onEdit={() => setItemDialog({ open: true, item: it })}
                    onDelete={() => setDeleteTarget({ type: 'item', id: it.id, name: it.name })}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Pagination */}
          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50/50">
              <span className="text-sm text-gray-500">
                Page {meta.page} of {meta.totalPages} · {meta.total} total
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button variant="outline" size="sm" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
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
                  onSuccess: () => { notify.success('Category updated successfully'); resolve(); },
                  onError: (e: any) => { notify.error(e?.message ?? 'Could not update category'); reject(e); },
                },
              );
            } else {
              createCategory.mutate(input, {
                onSuccess: () => { notify.success(`Category "${input.name}" created successfully`); resolve(); },
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
            const onSuccess = () => { notify.success(itemDialog.item ? 'Item updated successfully' : 'Item created successfully'); resolve(); };
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

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent className="p-0 gap-0">
          <AlertDialogHeader className="bg-[#3b82f6] text-white p-6 rounded-t-lg">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/10">
                <Trash2 className="h-5 w-5 text-white" />
              </div>
              <div>
                <AlertDialogTitle>
                  {deleteTarget?.type === 'category' ? 'Delete Category' : 'Disable Menu Item'}
                </AlertDialogTitle>
                <AlertDialogDescription className="text-white/80 mt-1">
                  This action can be undone from the Recently deleted bin.
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>
          <div className="p-6">
            <p className="text-sm text-gray-600">
              {deleteTarget?.type === 'category'
                ? <>Are you sure you want to delete <span className="font-semibold text-gray-800">{deleteTarget?.name}</span>? Items in this category will not be deleted and the category can be restored later.</>
                : <>Are you sure you want to disable <span className="font-semibold text-gray-800">{deleteTarget?.name}</span>? It will disappear from the POS menu but stay in the database.</>}
            </p>
          </div>
          <AlertDialogFooter className="p-6 border-t border-gray-200 bg-gray-50/50 rounded-b-lg gap-2">
            <AlertDialogCancel className="h-11 px-6 rounded-lg border-gray-300 hover:bg-gray-100">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="h-11 px-6 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {deleteTarget?.type === 'category' ? 'Delete Category' : 'Disable Item'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ItemRow({
  item, canEdit, canDelete, onEdit, onDelete,
}: {
  item: MenuItem;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const navigateRow = useNavigate();
  const priceMajor = item.basePrice != null ? Number(item.basePrice) : null;
  const ingredientCount = item.ingredients?.length ?? 0;

  return (
    <div
      className="flex items-center gap-4 rounded-lg border border-gray-200 p-4 hover:border-[#3b82f6]/30 hover:bg-[#3b82f6]/5 cursor-pointer transition-all group"
          onClick={() => navigateRow(`/menu/${item.id}`)}
    >
      <div
        className={`w-1.5 self-stretch rounded-full shrink-0 ${item.isAvailable ? 'bg-[#10b981]' : 'bg-gray-300'}`}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-gray-900 truncate group-hover:text-[#3b82f6] transition-colors">
            {item.name}
          </span>
          {item.code && (
            <Badge variant="outline" className="font-mono text-[10px] border-gray-300 text-gray-600">
              {item.code}
            </Badge>
          )}
          {!item.isAvailable && (
            <Badge className="bg-red-100 text-red-800 hover:bg-red-200 border-none text-[10px]">
              Unavailable
            </Badge>
          )}
        </div>
        {item.description && (
          <p className="text-xs text-gray-500 truncate mt-1">{item.description}</p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
          {priceMajor != null && (
            <div className="flex items-center gap-1 text-gray-700">
              <DollarSign className="h-3.5 w-3.5 text-[#10b981]" />
              <span className="font-bold text-gray-900">{formatCurrency(priceMajor)}</span>
            </div>
          )}
          {item.preparationTime != null && (
            <div className="flex items-center gap-1 text-gray-700">
              <Clock className="h-3.5 w-3.5 text-[#f59e0b]" />
              <span>{item.preparationTime}m</span>
            </div>
          )}
          <div className="flex items-center gap-1 text-gray-700">
            <Layers className="h-3.5 w-3.5 text-[#8b5cf6]" />
            <span>{ingredientCount} ingredient{ingredientCount === 1 ? '' : 's'}</span>
          </div>
          <div
            className={`flex items-center gap-1 font-medium ${item.isAvailable ? 'text-[#10b981]' : 'text-gray-400'}`}
          >
            <div className={`h-2 w-2 rounded-full ${item.isAvailable ? 'bg-[#10b981]' : 'bg-gray-400'}`} />
            {item.isAvailable ? 'Active' : 'Unavailable'}
          </div>
        </div>
      </div>

      <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
        <Button
          size="sm"
          variant="ghost"
      onClick={() => navigateRow(`/menu/${item.id}`)}
          className="h-9 w-9 p-0 hover:bg-primary/10 hover:text-primary"
          title="View details"
        >
          <Eye className="h-4 w-4 text-primary/70" />
        </Button>
        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onEdit}
            className="h-9 w-9 p-0 bg-blue-50 text-blue-600 hover:bg-blue-100"
            title="Edit item"
          >
            <Edit className="h-4 w-4" />
          </Button>
        )}
        {canDelete && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            className="h-9 w-9 p-0 hover:bg-red-50 hover:text-red-600"
            title="Disable item"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

export default MenuPage;
