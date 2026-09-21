import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Edit, Eye, Package, Plus, Trash2, Loader2 } from 'lucide-react';
import { PERMISSIONS, type PaginatedResult } from '@erp/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
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
import { DataTable, type Column } from '@/components/data-table';
import {
  DataTablePagination, ExportMenu, FilterChips, FilterSelect, ListCard, ListPageHeader,
  ListToolbar, SearchInput, StatusPill, describeFilters, useListState, type ActiveChip,
} from '@/components/list';
import { api, resolveAssetUrl } from '@/lib/api';
import { fetchAllPages, type ExportColumn } from '@/lib/export-list';
import { money, statusLabel, useOrgCurrency } from '@/lib/format';
import { notify } from '@/lib/notify';
import { useAuthStore } from '@/stores/auth.store';
import {
  useProducts, useDeleteProduct, useProductCategories,
  useCreateProductCategory, useUpdateProductCategory, useDeleteProductCategory,
  type Product, type ProductCategory,
} from '@/features/products/api';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

const PRODUCT_TYPES = ['stockable', 'consumable', 'service', 'fee', 'subscription', 'asset'] as const;
const TYPE_OPTIONS = PRODUCT_TYPES.map((t) => ({ value: t, label: statusLabel(t) }));
const FILTERS = { categoryId: '', productType: '' };
// Radix Select forbids an empty-string item value.
const NO_PARENT = '__none__';

/** Gross margin % from sales vs cost price, or null when either is missing. */
function marginPct(p: Product): number | null {
  const sale = Number(p.salesPrice);
  const cost = Number(p.costPrice);
  if (p.salesPrice == null || p.costPrice == null || !(sale > 0) || !(cost > 0)) return null;
  return ((sale - cost) / sale) * 100;
}

function ProductThumb({ p }: { p: Product }) {
  const [failed, setFailed] = useState(false);
  const src = p.image ? resolveAssetUrl(p.image) : undefined;
  if (src && !failed) {
    return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="h-9 w-9 shrink-0 rounded-lg border object-cover" />;
  }
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-semibold uppercase text-primary">
      {p.name.slice(0, 1)}
    </div>
  );
}

export function ProductsPage() {
  const navigate = useNavigate();
  const currency = useOrgCurrency();
  const list = useListState(FILTERS);
  const { categoryId: categoryFilter, productType: typeFilter } = list.filters;
  const [deleting, setDeleting] = useState<Product | null>(null);

  // Categories dialog state
  const [categoryDialog, setCategoryDialog] = useState<{
    open: boolean;
    category?: ProductCategory | null;
  }>({ open: false });
  const [catName, setCatName] = useState('');
  const [catParentId, setCatParentId] = useState('');
  const [catIncomeAccountId, setCatIncomeAccountId] = useState('');
  const [catExpenseAccountId, setCatExpenseAccountId] = useState('');
  const [catSaving, setCatSaving] = useState(false);
  const [catError, setCatError] = useState('');

  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canViewProducts = hasPermission(PERMISSIONS.products.view);
  const canCreateProduct = hasPermission(PERMISSIONS.products.create);
  const canEditProduct = hasPermission(PERMISSIONS.products.edit);
  const canDeleteProduct = hasPermission(PERMISSIONS.products.delete);
  const canViewCategories = hasPermission(PERMISSIONS.productCategory.read);
  const canCreateCategory = hasPermission(PERMISSIONS.productCategory.create);
  const canEditCategory = hasPermission(PERMISSIONS.productCategory.update);
  const canDeleteCategory = hasPermission(PERMISSIONS.productCategory.delete);

  const query = {
    search: list.search || undefined,
    categoryId: categoryFilter || undefined,
    productType: typeFilter || undefined,
    sortBy: list.sort?.by,
    sortOrder: list.sort?.order,
  };
  const { data, isLoading, isFetching } = useProducts({ page: list.page, pageSize: list.pageSize, ...query });
  const deleteProduct = useDeleteProduct();
  const { data: categories = [] } = useProductCategories();
  const createCategory = useCreateProductCategory();
  const updateCategory = useUpdateProductCategory();
  const deleteCategory = useDeleteProductCategory();

  const handleDelete = async () => {
    if (!deleting) return;
    await deleteProduct.mutateAsync(deleting.id);
    notify.success('Product moved to deleted');
    setDeleting(null);
  };

  const rows = data?.data ?? [];
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? 'Category';

  const chips: ActiveChip[] = [
    ...(list.search ? [{ key: 'q', label: `“${list.search}”`, onRemove: () => list.setSearchInput('') }] : []),
    ...(categoryFilter ? [{ key: 'category', label: categoryName(categoryFilter), onRemove: () => list.setFilter('categoryId', '') }] : []),
    ...(typeFilter ? [{ key: 'type', label: statusLabel(typeFilter), onRemove: () => list.setFilter('productType', '') }] : []),
  ];

  const columns: Column<Product>[] = [
    {
      key: 'name',
      header: 'Product',
      sortKey: 'name',
      render: (p) => (
        <div className="flex min-w-[200px] items-center gap-3">
          <ProductThumb p={p} />
          <div className="min-w-0">
            <div className="truncate font-medium">{p.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {p.code}{p.sku ? ` · SKU ${p.sku}` : ''}
            </div>
          </div>
        </div>
      ),
    },
    { key: 'category', header: 'Category', render: (p) => p.category?.name ?? <span className="text-muted-foreground">—</span> },
    {
      key: 'productType',
      header: 'Type',
      sortKey: 'productType',
      render: (p) => <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium">{statusLabel(p.productType)}</span>,
    },
    {
      key: 'costPrice',
      header: 'Cost',
      className: 'text-right',
      sortKey: 'costPrice',
      render: (p) => <span className="tabular-nums text-muted-foreground">{p.costPrice != null ? money(p.costPrice, currency) : '—'}</span>,
    },
    {
      key: 'salesPrice',
      header: 'Sales price',
      className: 'text-right',
      sortKey: 'salesPrice',
      render: (p) => <span className="font-semibold tabular-nums">{p.salesPrice != null ? money(p.salesPrice, currency) : '—'}</span>,
    },
    {
      key: 'margin',
      header: 'Margin',
      className: 'text-right',
      render: (p) => {
        const m = marginPct(p);
        if (m == null) return <span className="text-muted-foreground/50">—</span>;
        const tone = m < 0 ? 'text-rose-600 dark:text-rose-400' : m < 20 ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400';
        return <span className={`text-xs font-medium tabular-nums ${tone}`}>{m.toFixed(1)}%</span>;
      },
    },
    {
      key: 'isActive',
      header: 'Status',
      render: (p) => <StatusPill tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? 'Active' : 'Inactive'}</StatusPill>,
    },
    {
      key: 'actions',
      header: '',
      className: 'w-28 text-right',
      render: (p: Product) => (
        <div className="flex justify-end gap-0.5">
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => navigate(`/inventory/items/${p.id}`)} aria-label="View stock">
            <Eye className="h-4 w-4 text-primary/70" />
          </Button>
          {canEditProduct && (
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => navigate(`/products/${p.id}/edit`)} aria-label="Edit">
              <Edit className="h-4 w-4" />
            </Button>
          )}
          {canDeleteProduct && (
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setDeleting(p)} aria-label="Delete">
              <Trash2 className="h-4 w-4 text-destructive/70" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  const exportColumns: ExportColumn<Product>[] = [
    { header: 'Name', value: (p) => p.name },
    { header: 'Code', value: (p) => p.code },
    { header: 'SKU', value: (p) => p.sku ?? '' },
    { header: 'Category', value: (p) => p.category?.name ?? '' },
    { header: 'Type', value: (p) => statusLabel(p.productType) },
    { header: 'Cost', value: (p) => (p.costPrice != null ? money(p.costPrice, currency) : ''), align: 'right' },
    { header: 'Sales price', value: (p) => (p.salesPrice != null ? money(p.salesPrice, currency) : ''), align: 'right' },
    { header: 'Margin %', value: (p) => marginPct(p)?.toFixed(1) ?? '', align: 'right' },
    { header: 'Status', value: (p) => (p.isActive ? 'Active' : 'Inactive') },
  ];

  const fetchAll = () =>
    fetchAllPages<Product>(async (page, pageSize) => {
      const res = (await api.get<PaginatedResult<Product>>('/products', { params: { ...query, page, pageSize } })).data;
      return { rows: res.data, totalPages: res.meta.totalPages };
    }, { pageSize: 500 });

  const meta = data?.meta;

  if (!canViewProducts && !canViewCategories) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Products</h1>
        <p className="text-sm text-muted-foreground">You do not have permission to view products or categories.</p>
      </div>
    );
  }

  // Category dialog handlers
  const openCategoryDialog = (category?: ProductCategory | null) => {
    if (category) {
      setCatName(category.name);
      setCatParentId(category.parentId ?? '');
      setCatIncomeAccountId(category.incomeAccountId ?? '');
      setCatExpenseAccountId(category.expenseAccountId ?? '');
    } else {
      setCatName('');
      setCatParentId('');
      setCatIncomeAccountId('');
      setCatExpenseAccountId('');
    }
    setCatError('');
    setCategoryDialog({ open: true, category });
  };

  const closeCategoryDialog = () => {
    setCategoryDialog({ open: false });
  };

  const saveCategory = async () => {
    if (!catName.trim()) return setCatError('Category name is required');
    setCatSaving(true);
    setCatError('');
    try {
      const payload = {
        name: catName.trim(),
        parentId: catParentId || undefined,
        incomeAccountId: catIncomeAccountId || undefined,
        expenseAccountId: catExpenseAccountId || undefined,
      };
      if (categoryDialog.category) {
        await updateCategory.mutateAsync({ id: categoryDialog.category.id, data: payload });
      } else {
        await createCategory.mutateAsync(payload);
      }
      closeCategoryDialog();
      notify.success(categoryDialog.category ? 'Category updated' : 'Category created');
    } catch (e: any) {
      const msg = e.response?.data?.message;
      setCatError(Array.isArray(msg) ? msg.join(', ') : msg || e.message);
    } finally {
      setCatSaving(false);
    }
  };

  const handleDeleteCategory = async (cat: ProductCategory) => {
    if (!confirm(`Delete "${cat.name}"? This cannot be undone.`)) return;
    try {
      await deleteCategory.mutateAsync(cat.id);
      notify.success('Category deleted');
    } catch (e: any) {
      alert(e.response?.data?.message || e.message);
    }
  };

  return (
    <div className="space-y-4">
      <ListPageHeader icon={Package} title="Products" description="Goods, services, fees and subscriptions." />

      <Tabs defaultValue="products" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
        </TabsList>

        <TabsContent value="products" className="space-y-4">
          {canViewProducts ? (
            <>
              <ListToolbar chips={<FilterChips chips={chips} onClearAll={list.clearFilters} />}>
                <SearchInput value={list.searchInput} onChange={list.setSearchInput} placeholder="Search name, code or SKU…" />
                <FilterSelect
                  value={categoryFilter}
                  onChange={(v) => list.setFilter('categoryId', v)}
                  options={categories.map((c) => ({ value: c.id, label: c.name }))}
                  allLabel="All categories"
                  className="w-[180px]"
                />
                <FilterSelect value={typeFilter} onChange={(v) => list.setFilter('productType', v)} options={TYPE_OPTIONS} allLabel="All types" />
                <div className="ml-auto flex items-center gap-2">
                  <ExportMenu
                    basename="products"
                    title="Products"
                    subtitle={describeFilters(chips)}
                    columns={exportColumns}
                    pageRows={rows}
                    total={meta?.total}
                    fetchAll={fetchAll}
                  />
                  {canCreateProduct && (
                    <Button size="sm" onClick={() => navigate('/products/new')}>
                      <Plus className="mr-1 h-4 w-4" /> New Product
                    </Button>
                  )}
                </div>
              </ListToolbar>

              <ListCard>
                <div className={isFetching && !isLoading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
                  <DataTable
                    columns={columns}
                    data={rows}
                    loading={isLoading}
                    loadingRows={10}
                    getRowId={(p) => p.id}
                    onRowClick={canEditProduct ? (p) => navigate(`/products/${p.id}/edit`) : undefined}
                    sort={list.sort}
                    onSortChange={list.setSort}
                    cellClassName="py-2 px-4"
                    headerRowClassName="h-10"
                    emptyMessage={chips.length ? 'No products match these filters.' : 'No products yet.'}
                  />
                </div>
                {meta && (
                  <DataTablePagination
                    page={meta.page}
                    pageSize={list.pageSize}
                    total={meta.total}
                    totalPages={meta.totalPages}
                    onPageChange={list.setPage}
                    onPageSizeChange={list.setPageSize}
                    noun="product"
                  />
                )}
              </ListCard>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">You do not have permission to view products.</p>
          )}

          <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Product?</AlertDialogTitle>
                <AlertDialogDescription>
                  {deleting?.name} will be marked as deleted. It can be restored later.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </TabsContent>

        <TabsContent value="categories" className="space-y-4">
          {canViewCategories && (
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold">Categories</h2>
                <p className="text-sm text-muted-foreground">Organize products into categories.</p>
              </div>
              {canCreateCategory && (
                <Button onClick={() => openCategoryDialog(null)}>
                  <Plus className="h-4 w-4" /> New Category
                </Button>
              )}
            </div>
          )}

          {canViewCategories ? (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <tr>
                    <th className="text-left px-4 py-2 font-semibold">Name</th>
                    <th className="text-left px-4 py-2 font-semibold">Parent</th>
                    <th className="text-left px-4 py-2 font-semibold">Income Account</th>
                    <th className="text-left px-4 py-2 font-semibold">Expense Account</th>
                    <th className="text-right px-4 py-2 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {categories.map((c) => (
                    <tr key={c.id}>
                      <td className="px-4 py-2.5 font-medium text-slate-800">{c.name}</td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {categories.find(p => p.id === c.parentId)?.name ?? '-'}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {c.incomeAccountId ? c.incomeAccountId.slice(0, 8) + '...' : '-'}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {c.expenseAccountId ? c.expenseAccountId.slice(0, 8) + '...' : '-'}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        {(canEditCategory || canDeleteCategory) && (
                          <div className="flex items-center justify-end gap-1">
                            {canEditCategory && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openCategoryDialog(c)}
                                className="h-8 w-8"
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                            )}
                            {canDeleteCategory && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDeleteCategory(c)}
                                className="h-8 w-8 text-destructive hover:text-destructive"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {categories.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-slate-400">
                        No categories yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">You do not have permission to view categories.</p>
            </div>
          )}

          <Dialog open={categoryDialog.open} onOpenChange={(o) => !o && closeCategoryDialog()}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {categoryDialog.category ? `Edit "${categoryDialog.category.name}"` : 'New Category'}
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                {catError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded px-3 py-2">
                    {catError}
                  </div>
                )}

                <div>
                  <Label className="text-sm font-medium">Name</Label>
                  <Input
                    value={catName}
                    onChange={(e) => setCatName(e.target.value)}
                    placeholder="e.g. Beverages"
                    disabled={catSaving}
                  />
                </div>

                <div>
                  <Label className="text-sm font-medium">Parent Category</Label>
                  <Select
                    value={catParentId || NO_PARENT}
                    onValueChange={(v) => setCatParentId(v === NO_PARENT ? '' : v)}
                    disabled={catSaving}
                  >
                    <SelectTrigger className="w-full"><SelectValue placeholder="No parent (top level)" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_PARENT}>No parent (top level)</SelectItem>
                      {categories.filter(c => c.id !== categoryDialog.category?.id).map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-sm font-medium">Income Account (optional)</Label>
                  <Input
                    value={catIncomeAccountId}
                    onChange={(e) => setCatIncomeAccountId(e.target.value)}
                    placeholder="Account ID"
                    disabled={catSaving}
                  />
                </div>

                <div>
                  <Label className="text-sm font-medium">Expense Account (optional)</Label>
                  <Input
                    value={catExpenseAccountId}
                    onChange={(e) => setCatExpenseAccountId(e.target.value)}
                    placeholder="Account ID"
                    disabled={catSaving}
                  />
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={closeCategoryDialog} disabled={catSaving}>
                  Cancel
                </Button>
                <Button onClick={saveCategory} disabled={catSaving}>
                  {catSaving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                  {categoryDialog.category ? 'Save' : 'Create'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>
      </Tabs>
    </div>
  );
}