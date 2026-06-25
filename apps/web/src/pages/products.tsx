import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Edit, Plus, Search, Trash2 } from 'lucide-react';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { useAuthStore } from '@/stores/auth.store';
import { useCreateProduct, useDeleteProduct, useProducts, useUpdateProduct, type Product } from '@/features/products/api';

const PRODUCT_TYPES = ['stockable', 'consumable', 'service', 'fee', 'subscription', 'asset'] as const;

const schema = z.object({
  code: z.string().min(1, 'Code is required'),
  sku: z.string().optional().or(z.literal('')),
  name: z.string().min(1, 'Name is required'),
  productType: z.string().min(1),
  salesPrice: z.string().optional().or(z.literal('')),
  costPrice: z.string().optional().or(z.literal('')),
  trackInventory: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

export function ProductsPage() {
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);

  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canView = hasPermission(PERMISSIONS.products.view);
  const canCreate = hasPermission(PERMISSIONS.products.create);
  const canEdit = hasPermission(PERMISSIONS.products.edit);
  const canDelete = hasPermission(PERMISSIONS.products.delete);

  useEffect(() => setPage(1), [search]);

  const { data, isLoading } = useProducts({ page, pageSize: 10, search: search || undefined });
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const deleteProduct = useDeleteProduct();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', sku: '', name: '', productType: 'stockable', salesPrice: '', costPrice: '', trackInventory: true },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ code: '', sku: '', name: '', productType: 'stockable', salesPrice: '', costPrice: '', trackInventory: true });
    setOpen(true);
  };

  const openEdit = (p: Product) => {
    setEditing(p);
    form.reset({
      code: p.code,
      sku: p.sku ?? '',
      name: p.name,
      productType: p.productType,
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
    { key: 'code', header: 'Code' },
    { key: 'sku', header: 'SKU', render: (p) => p.sku ?? '-' },
    { key: 'name', header: 'Name' },
    { key: 'productType', header: 'Type', render: (p) => <Badge variant="secondary">{p.productType}</Badge> },
    {
      key: 'salesPrice',
      header: 'Sales price',
      className: 'text-right',
      render: (p) => (p.salesPrice != null ? Number(p.salesPrice).toFixed(2) : '-'),
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
        <div>
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-sm text-muted-foreground">Goods, services, fees and subscriptions.</p>
        </div>
        {canCreate && (
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> New Product
          </Button>
        )}
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search products..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Product' : 'New Product'}</DialogTitle>
            <DialogDescription>{editing ? 'Update product details.' : 'Create a new product.'}</DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="code">Code *</Label>
                <Input id="code" placeholder="PRD-001" {...form.register('code')} />
                {form.formState.errors.code && (
                  <p className="text-sm text-destructive">{form.formState.errors.code.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="sku">SKU</Label>
                <Input id="sku" placeholder="SKU-001" {...form.register('sku')} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input id="name" placeholder="Product name" {...form.register('name')} />
              {form.formState.errors.name && (
                <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="productType">Type</Label>
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="salesPrice">Sales price</Label>
                <Input id="salesPrice" type="number" step="0.01" min="0" placeholder="0.00" {...form.register('salesPrice')} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="costPrice">Cost price</Label>
                <Input id="costPrice" type="number" step="0.01" min="0" placeholder="0.00" {...form.register('costPrice')} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...form.register('trackInventory')} /> Track inventory
            </label>
            <DialogFooter>
              <Button type="submit" disabled={createProduct.isPending || updateProduct.isPending}>
                {createProduct.isPending || updateProduct.isPending ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Product</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleting?.name}</strong> ({deleting?.code})? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
