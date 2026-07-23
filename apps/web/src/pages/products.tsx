import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Edit, Eye, Plus, Search, Trash2, X } from 'lucide-react';
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
import { api, resolveAssetUrl } from '@/lib/api';
import { toast } from 'sonner';

const PRODUCT_TYPES = ['stockable', 'consumable', 'service', 'fee', 'subscription', 'asset'] as const;

const MEASUREMENT_METHODS = [
  { value: 'count', label: 'Count units' },
  { value: 'manual_volume', label: 'Manual remaining volume' },
  { value: 'digital_weight', label: 'Digital weight scale (bar alcohol)' },
] as const;

const schema = z.object({
  code: z.string().min(1, 'Code is required'),
  sku: z.string().optional().or(z.literal('')),
  name: z.string().min(1, 'Name is required'),
  productType: z.string().min(1),
  categoryId: z.string().optional().or(z.literal('')),
  salesPrice: z.string().optional().or(z.literal('')),
  costPrice: z.string().optional().or(z.literal('')),
  trackInventory: z.boolean(),
  // Beverage Control (bar alcohol) — digital-weight measurement.
  measurementMethod: z.string(),
  containerVolumeMl: z.string().optional().or(z.literal('')),
  emptyBottleWeightG: z.string().optional().or(z.literal('')),
  actualEmptyWeightG: z.string().optional().or(z.literal('')),
  fullBottleWeightG: z.string().optional().or(z.literal('')),
  standardPourMl: z.string().optional().or(z.literal('')),
  allowPartialBottle: z.boolean(),
  varianceToleranceG: z.string().optional().or(z.literal('')),
});
type FormValues = z.infer<typeof schema>;

const BEVERAGE_DEFAULTS = {
  measurementMethod: 'count',
  containerVolumeMl: '',
  emptyBottleWeightG: '',
  actualEmptyWeightG: '',
  fullBottleWeightG: '',
  standardPourMl: '',
  allowPartialBottle: true,
  varianceToleranceG: '',
} as const;

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

  const imageFileIdRef = useRef<string>('');
  const [previewSrc, setPreviewSrc] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingImg, setUploadingImg] = useState(false);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingImg(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('ownerType', 'product');
      if (editing?.id) form.append('ownerId', editing.id);
      const { data } = await api.post('/files/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const fileId = data.id as string | undefined;
      if (fileId) imageFileIdRef.current = fileId;
      const previewUrl = (data as any).downloadUrl ?? (data as any).url ?? '';
      setPreviewSrc(resolveAssetUrl(previewUrl) ?? '');
    } catch (err: any) {
      toast.error(err?.response?.data?.message ?? 'Image upload failed');
    } finally {
      setUploadingImg(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

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
    defaultValues: { code: '', sku: '', name: '', productType: 'stockable', categoryId: '', salesPrice: '', costPrice: '', trackInventory: true, ...BEVERAGE_DEFAULTS },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ code: '', sku: '', name: '', productType: 'stockable', categoryId: '', salesPrice: '', costPrice: '', trackInventory: true, ...BEVERAGE_DEFAULTS });
    setPreviewSrc('');
    imageFileIdRef.current = '';
    setOpen(true);
  };

  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

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
      measurementMethod: p.measurementMethod ?? 'count',
      containerVolumeMl: s(p.containerVolumeMl),
      emptyBottleWeightG: s(p.emptyBottleWeightG),
      actualEmptyWeightG: s(p.actualEmptyWeightG),
      fullBottleWeightG: s(p.fullBottleWeightG),
      standardPourMl: s(p.standardPourMl),
      allowPartialBottle: p.allowPartialBottle ?? true,
      varianceToleranceG: s(p.varianceToleranceG),
    });
    const raw = p.image ?? '';
    const uuid = raw.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] ?? '';
    if (raw.startsWith('http') || raw.startsWith('/api/v1/files/')) {
      setPreviewSrc(resolveAssetUrl(raw) ?? '');
      imageFileIdRef.current = uuid;
    } else if (raw) {
      imageFileIdRef.current = raw;
      api.post(`/files/${encodeURIComponent(raw)}/signed-url`)
        .then((r) => { if (r.data?.url) setPreviewSrc(resolveAssetUrl(r.data.url) ?? ''); })
        .catch(() => setPreviewSrc(''));
    } else {
      setPreviewSrc('');
      imageFileIdRef.current = '';
    }
    setOpen(true);
  };

  // When navigated here with an editId in location state (from inventory detail
  // page), open the edit dialog with that product once its data is loaded.
  const location = useLocation();
  const openEditRef = useRef(openEdit);
  openEditRef.current = openEdit;
  const processedEditId = useRef<string | null>(null);
  const editId = (location.state as any)?.editId as string | undefined;
  useEffect(() => {
    if (!editId || processedEditId.current === editId) return;
    const inLoadedData = data?.data?.find((p) => p.id === editId);
    if (inLoadedData) {
      processedEditId.current = editId;
      openEditRef.current(inLoadedData);
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [editId, data?.data?.length, navigate]);

  const onSubmit = form.handleSubmit(async (values) => {
    const numOrUndef = (v?: string) => (v !== undefined && v !== '' ? Number(v) : undefined);
    const isWeight = values.measurementMethod === 'digital_weight';
    const data = {
      ...values,
      sku: values.sku || undefined,
      categoryId: values.categoryId || undefined,
      salesPrice: values.salesPrice ? Number(values.salesPrice) : undefined,
      costPrice: values.costPrice ? Number(values.costPrice) : undefined,
      image: imageFileIdRef.current || (previewSrc || undefined),
      // Beverage Control: only send bottle metrics for digital-weight products.
      measurementMethod: values.measurementMethod,
      containerVolumeMl: isWeight ? numOrUndef(values.containerVolumeMl) : undefined,
      emptyBottleWeightG: isWeight ? numOrUndef(values.emptyBottleWeightG) : undefined,
      actualEmptyWeightG: isWeight ? numOrUndef(values.actualEmptyWeightG) : undefined,
      fullBottleWeightG: isWeight ? numOrUndef(values.fullBottleWeightG) : undefined,
      standardPourMl: isWeight ? numOrUndef(values.standardPourMl) : undefined,
      allowPartialBottle: isWeight ? values.allowPartialBottle : undefined,
      varianceToleranceG: isWeight ? numOrUndef(values.varianceToleranceG) : undefined,
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
            <div className="space-y-2">
              <Label className="text-sm font-medium text-slate-700 mb-1.5">Image</Label>
              <div className="flex items-start gap-3">
                {previewSrc && (
                  <img
                    src={previewSrc}
                    alt="Preview"
                    className="w-16 h-16 rounded-md border border-slate-200 object-cover shrink-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
                <div className="flex-1 space-y-1.5">
                  <Input
                    id="image"
                    placeholder="Paste image URL, or use Browse"
                    value={previewSrc}
                    onChange={(e) => { setPreviewSrc(e.target.value); imageFileIdRef.current = ''; }}
                  />
                  <div className="flex items-center gap-2">
                    <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                    <Button type="button" size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploadingImg}>
                      {uploadingImg ? 'Uploading…' : 'Browse'}
                    </Button>
                    {previewSrc && (
                      <Button type="button" size="sm" variant="ghost" onClick={() => { setPreviewSrc(''); imageFileIdRef.current = ''; }}>
                        <X className="h-3 w-3 mr-1" /> Clear
                      </Button>
                    )}
                  </div>
                </div>
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

            {/* Beverage Control — how remaining stock is measured. */}
            <div className="space-y-2">
              <Label className="text-sm font-medium text-slate-700 mb-1.5">Measurement method</Label>
              <Select
                value={form.watch('measurementMethod')}
                onValueChange={(v) => form.setValue('measurementMethod', v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEASUREMENT_METHODS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {form.watch('measurementMethod') === 'digital_weight' && (() => {
              const vol = Number(form.watch('containerVolumeMl')) || 0;
              const empty = Number(form.watch('actualEmptyWeightG')) || Number(form.watch('emptyBottleWeightG')) || 0;
              const full = Number(form.watch('fullBottleWeightG')) || 0;
              const pour = Number(form.watch('standardPourMl')) || 0;
              const liquid = full > empty ? full - empty : 0;
              const factor = liquid > 0 && vol > 0 ? vol / liquid : 0;
              const shots = pour > 0 && vol > 0 ? vol / pour : 0;
              return (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-4">
                  <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Bottle weighing setup</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="containerVolumeMl" className="text-sm">Bottle size (ml) *</Label>
                      <Input id="containerVolumeMl" type="number" step="1" min="0" placeholder="750" {...form.register('containerVolumeMl')} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="standardPourMl" className="text-sm">Standard pour (ml)</Label>
                      <Input id="standardPourMl" type="number" step="1" min="0" placeholder="30" {...form.register('standardPourMl')} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="emptyBottleWeightG" className="text-sm">Empty bottle (g) *</Label>
                      <Input id="emptyBottleWeightG" type="number" step="1" min="0" placeholder="420" {...form.register('emptyBottleWeightG')} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fullBottleWeightG" className="text-sm">Full bottle (g) *</Label>
                      <Input id="fullBottleWeightG" type="number" step="1" min="0" placeholder="1135" {...form.register('fullBottleWeightG')} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="actualEmptyWeightG" className="text-sm">Actual empty (g)</Label>
                      <Input id="actualEmptyWeightG" type="number" step="0.1" min="0" placeholder="optional — measured tare" {...form.register('actualEmptyWeightG')} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="varianceToleranceG" className="text-sm">Tolerance (g)</Label>
                      <Input id="varianceToleranceG" type="number" step="0.5" min="0" placeholder="org default" {...form.register('varianceToleranceG')} />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="rounded-md bg-white border border-slate-200 py-2">
                      <div className="text-[11px] text-slate-500">Liquid weight</div>
                      <div className="text-sm font-semibold text-slate-800">{liquid ? `${liquid.toFixed(0)} g` : '—'}</div>
                    </div>
                    <div className="rounded-md bg-white border border-slate-200 py-2">
                      <div className="text-[11px] text-slate-500">Conversion</div>
                      <div className="text-sm font-semibold text-slate-800">{factor ? `${factor.toFixed(5)} ml/g` : '—'}</div>
                    </div>
                    <div className="rounded-md bg-white border border-slate-200 py-2">
                      <div className="text-[11px] text-slate-500">Shots / bottle</div>
                      <div className="text-sm font-semibold text-slate-800">{shots ? shots.toFixed(1) : '—'}</div>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" {...form.register('allowPartialBottle')} className="rounded" /> Allow partial bottle
                  </label>
                  <p className="text-[11px] text-slate-500">
                    For live pour tracking, set this product's stock unit to <strong>ml</strong> and add each drink's pour (e.g. 30 ml) as a recipe line.
                  </p>
                </div>
              );
            })()}
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
            Move <strong className="text-white">{deleting?.name}</strong> ({deleting?.code}) to recently deleted? It can be restored later.
          </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="px-5 py-3 border-t bg-slate-50 gap-2">
            <AlertDialogCancel className="rounded-lg border-gray-300 hover:bg-gray-100">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="rounded-lg bg-red-600 hover:bg-red-700 text-white">
              Move to deleted
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
