import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Edit, Eye, Plus, Search, Trash2 } from 'lucide-react';
import { PERMISSIONS } from '@erp/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from '@/components/ui/dialog';
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
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { notify } from '@/lib/notify';
import { formatCurrency } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useCreateProduct, useDeleteProduct, useProductCategories, useProducts, useUpdateProduct, type Product } from '@/features/products/api';

const PRODUCT_TYPES = ['stockable', 'consumable', 'service', 'fee', 'subscription', 'asset'] as const;

const schema = z.object({
  code: z.string().min(1, 'Code is required'),
  sku: z.string().optional().or(z.literal('')),
  name: z.string().min(1, 'Name is required'),
  productType: z.string().min(1),
  categoryId: z.string().optional().or(z.literal('')),
  salesPrice: z.string().optional().or(z.literal('')),
  costPrice: z.string().optional().or(z.literal('')),
  trackInventory: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

export function ProductsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);

  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canView = hasPermission(PERMISSIONS.products.view);
  const canCreate = hasPermission(PERMISSIONS.products.create);
  const canEdit = hasPermission(PERMISSIONS.products.edit);
  const canDelete = hasPermission(PERMISSIONS.products.delete);

  useEffect(() => setPage(1), [search, categoryFilter, typeFilter]);

  const { data, isLoading } = useProducts({
    page, pageSize: 10,
    search: search || undefined,
    categoryId: categoryFilter || undefined,
    productType: typeFilter || undefined,
  });
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const deleteProduct = useDeleteProduct();
  const { data: categories = [] } = useProductCategories();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', sku: '', name: '', productType: 'stockable', categoryId: '', salesPrice: '', costPrice: '', trackInventory: true },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ code: '', sku: '', name: '', productType: 'stockable', categoryId: '', salesPrice: '', costPrice: '', trackInventory: true });
    setOpen(true);
  };

  const openEdit = (p: Product) => {
    setEditing(p);
    form.reset({
      code: p.code,
      sku: p.sku ?? '',
      name: p.name,
      productType: p.productType,
      categoryId: p.categoryId ?? '',
      salesPrice: p.salesPrice ?? '',
      costPrice: p.costPrice ?? '',
      trackInventory: p.trackInventory,
    });
    setOpen(true);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    const data = {
      ...values,
      sku: values.sku || undefined,
      categoryId: values.categoryId || undefined,
      salesPrice: values.salesPrice ? Number(values.salesPrice) : undefined,
      costPrice: values.costPrice ? Number(values.costPrice) : undefined,
    };
    if (editing) {
      await updateProduct.mutateAsync({ id: editing.id, data });
      notify.success('Product updated');
    } else {
      await createProduct.mutateAsync(data);
      notify.success('Product created');
    }
    form.reset();
    setOpen(false);
  });

  const handleDelete = async () => {
    if (!deleting) return;
    await deleteProduct.mutateAsync(deleting.id);
    notify.success('Product deleted');
    setDeleting(null);
  };

  const columns: Column<Product>[] = [
    { key: 'name', header: 'Name' },
    { key: 'code', header: 'Code' },
    { key: 'sku', header: 'SKU', render: (p) => p.sku ?? '-' },
    { key: 'category', header: 'Category', render: (p) => p.category?.name ?? '-' },
    { key: 'productType', header: 'Type', render: (p) => <Badge variant="secondary">{p.productType}</Badge> },
    {
      key: 'salesPrice',
      header: 'Sales price',
      className: 'text-right',
      render: (p) => (p.salesPrice != null ? formatCurrency(Number(p.salesPrice)) : '-'),
    },
    {
      key: 'isActive',
      header: 'Active',
      render: (p) => <Badge variant={p.isActive ? 'default' : 'secondary'}>{p.isActive ? 'Yes' : 'No'}</Badge>,
    },
    ...((canEdit || canDelete) ? [{
      key: 'actions' as const,
      header: 'Actions',
      render: (p: Product) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/inventory/items/${p.id}`)}>
            <Eye className="h-4 w-4 text-primary/70" />
          </Button>
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
              <Edit className="h-4 w-4" />
            </Button>
          )}
          {canDelete && (
            <Button size="sm" variant="ghost" onClick={() => setDeleting(p)}>
              <Trash2 className="h-4 w-4 text-destructive/70" />
            </Button>
          )}
        </div>
      ),
    }] : []),
  ];

  const meta = data?.meta;

  if (!canView) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Products</h1>
        <p className="text-sm text-muted-foreground">You do not have permission to view products.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="border-l-4 border-[#3b82f6] pl-4 space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Products</h1>
          <p className="text-sm text-gray-500">Goods, services, fees and subscriptions.</p>
        </div>
        {canCreate && (
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> New Product
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-sm flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            className="pl-9 h-10 border-gray-200 rounded-lg focus:border-[#3b82f6] focus:ring-[#3b82f6]/20"
            placeholder="Search products..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-44 h-10"><SelectValue placeholder="All categories" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-40 h-10"><SelectValue placeholder="All types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">All types</SelectItem>
            {PRODUCT_TYPES.map((t) => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable columns={columns} data={data?.data ?? []} loading={isLoading} getRowId={(p) => p.id} />

      {meta && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{meta.total} record(s)</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span>
              Page {meta.page} of {meta.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= meta.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[650px] p-0 gap-0 overflow-hidden">
        <div className="bg-[#3b82f6] text-white px-6 py-4">
          <h2 className="text-base font-semibold">{editing ? 'Edit Product' : 'New Product'}</h2>
          <p className="text-white/75 text-xs mt-0.5">{editing ? 'Update product details below.' : 'Fill in the details to create a new product.'}</p>
        </div>
        <form onSubmit={onSubmit} className="p-5 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="code" className="text-sm font-medium text-slate-700 mb-1.5">Code *</Label>
                <Input id="code" placeholder="PRD-001" {...form.register('code')} />
                {form.formState.errors.code && (
                  <p className="text-sm text-destructive">{form.formState.errors.code.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="sku" className="text-sm font-medium text-slate-700 mb-1.5">SKU</Label>
                <Input id="sku" placeholder="SKU-001" {...form.register('sku')} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="name" className="text-sm font-medium text-slate-700 mb-1.5">Name *</Label>
              <Input id="name" placeholder="Product name" {...form.register('name')} />
              {form.formState.errors.name && (
                <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="productType" className="text-sm font-medium text-slate-700 mb-1.5">Type</Label>
                <Select
                  value={form.watch('productType')}
                  onValueChange={(v) => form.setValue('productType', v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRODUCT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="categoryId" className="text-sm font-medium text-slate-700 mb-1.5">Category</Label>
                <Select
                  value={form.watch('categoryId')}
                  onValueChange={(v) => form.setValue('categoryId', v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">No category</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="salesPrice" className="text-sm font-medium text-slate-700 mb-1.5">Sales price</Label>
                <Input id="salesPrice" type="number" step="1" min="0" placeholder="0" {...form.register('salesPrice')} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="costPrice" className="text-sm font-medium text-slate-700 mb-1.5">Cost price</Label>
                <Input id="costPrice" type="number" step="1" min="0" placeholder="0" {...form.register('costPrice')} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" {...form.register('trackInventory')} className="rounded" /> Track inventory
            </label>
            <DialogFooter className="px-5 py-3 border-t bg-slate-50 gap-2">
              <Button type="submit" disabled={createProduct.isPending || updateProduct.isPending} className="rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] text-white">
                {createProduct.isPending || updateProduct.isPending ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent className="p-0 gap-0 overflow-hidden">
          <AlertDialogHeader className="bg-[#3b82f6] text-white p-5 rounded-t-lg">
            <AlertDialogTitle>Delete Product</AlertDialogTitle>
            <AlertDialogDescription className="text-white/75 mt-1">
              Are you sure you want to delete <strong className="text-white">{deleting?.name}</strong> ({deleting?.code})? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="px-5 py-3 border-t bg-slate-50 gap-2">
            <AlertDialogCancel className="rounded-lg border-gray-300 hover:bg-gray-100">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="rounded-lg bg-red-600 hover:bg-red-700 text-white">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
