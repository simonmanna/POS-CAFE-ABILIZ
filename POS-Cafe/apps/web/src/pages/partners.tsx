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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { useCreatePartner, useDeletePartner, usePartners, useUpdatePartner, type Partner } from '@/features/partners/api';

const schema = z.object({
  code: z.string().min(1, 'Code is required'),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  isCustomer: z.boolean(),
  isSupplier: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

export function PartnersPage() {
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partner | null>(null);
  const [deleting, setDeleting] = useState<Partner | null>(null);

  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canView = hasPermission(PERMISSIONS.partners.view);
  const canCreate = hasPermission(PERMISSIONS.partners.create);
  const canEdit = hasPermission(PERMISSIONS.partners.edit);
  const canDelete = hasPermission(PERMISSIONS.partners.delete);

  useEffect(() => setPage(1), [search]);

  const { data, isLoading } = usePartners({ page, pageSize: 10, search: search || undefined }, { enabled: canView });
  const createPartner = useCreatePartner();
  const updatePartner = useUpdatePartner();
  const deletePartner = useDeletePartner();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', name: '', email: '', isCustomer: true, isSupplier: false },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ code: '', name: '', email: '', isCustomer: true, isSupplier: false });
    setOpen(true);
  };

  const openEdit = (p: Partner) => {
    setEditing(p);
    form.reset({
      code: p.code,
      name: p.name,
      email: p.email ?? '',
      isCustomer: p.isCustomer,
      isSupplier: p.isSupplier,
    });
    setOpen(true);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    if (editing) {
      await updatePartner.mutateAsync({ id: editing.id, data: values });
      notify.success('Partner updated');
    } else {
      await createPartner.mutateAsync(values);
      notify.success('Partner created');
    }
    form.reset();
    setOpen(false);
  });

  const handleDelete = async () => {
    if (!deleting) return;
    await deletePartner.mutateAsync(deleting.id);
    notify.success('Partner deleted');
    setDeleting(null);
  };

  const columns: Column<Partner>[] = [
    { key: 'code', header: 'Code' },
    { key: 'name', header: 'Name' },
    {
      key: 'type',
      header: 'Type',
      render: (p) => (
        <div className="flex gap-1">
          {p.isCustomer && <Badge variant="secondary">Customer</Badge>}
          {p.isSupplier && <Badge variant="outline">Supplier</Badge>}
          {p.isEmployee && <Badge variant="outline">Employee</Badge>}
        </div>
      ),
    },
    { key: 'email', header: 'Email', render: (p) => p.email ?? '-' },
    {
      key: 'status',
      header: 'Status',
      render: (p) => (
        <Badge variant={p.status === 'active' ? 'default' : 'secondary'}>{p.status}</Badge>
      ),
    },
    ...((canEdit || canDelete) ? [{
      key: 'actions' as const,
      header: 'Actions',
      render: (p: Partner) => (
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
        <h1 className="text-2xl font-semibold">Partners</h1>
        <p className="text-sm text-muted-foreground">You do not have permission to view partners.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Partners</h1>
          <p className="text-sm text-muted-foreground">Customers, suppliers and other parties.</p>
        </div>
        {canCreate && (
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> New Partner
          </Button>
        )}
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search partners..."
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
            <DialogTitle>{editing ? 'Edit Partner' : 'New Partner'}</DialogTitle>
            <DialogDescription>{editing ? 'Update partner details.' : 'Create a customer or supplier.'}</DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="code">Code</Label>
              <Input id="code" placeholder="CUST-001" {...form.register('code')} />
              {form.formState.errors.code && (
                <p className="text-sm text-destructive">{form.formState.errors.code.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" placeholder="Acme Ltd" {...form.register('name')} />
              {form.formState.errors.name && (
                <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" placeholder="orders@acme.test" {...form.register('email')} />
              {form.formState.errors.email && (
                <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
              )}
            </div>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" {...form.register('isCustomer')} /> Customer
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" {...form.register('isSupplier')} /> Supplier
              </label>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={createPartner.isPending || updatePartner.isPending}>
                {createPartner.isPending || updatePartner.isPending ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Partner</AlertDialogTitle>
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
