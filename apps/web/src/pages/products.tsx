import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Edit, Eye, Plus, Search, Trash2 } from 'lucide-react';
import { PERMISSIONS } from '@erp/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { notify } from '@/lib/notify';
import { formatCurrency } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import {
  useDeleteProduct, useProductCategories, useProducts,
  type Product,
} from '@/features/products/api';

const PRODUCT_TYPES = ['stockable', 'consumable', 'service', 'fee', 'subscription', 'asset'] as const;

export function ProductsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
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
  const deleteProduct = useDeleteProduct();
  const { data: categories = [] } = useProductCategories();

  const handleDelete = async () => {
    if (!deleting) return;
    await deleteProduct.mutateAsync(deleting.id);
    notify.success('Product moved to deleted');
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
            <Button size="sm" variant="ghost" onClick={() => navigate(`/products/${p.id}/edit`)}>
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
          <Button onClick={() => navigate('/products/new')}>
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

      <DataTable columns={columns} data={data?.data ?? []} loading={isLoading} getRowId={(p) => p.id} compact />

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

      {/* Delete confirmation */}
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
    </div>
  );
}
