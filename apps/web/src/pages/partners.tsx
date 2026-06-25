import { useEffect, useState, useMemo, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { 
  Edit, 
  Plus, 
  Search, 
  Trash2, 
  Building2, 
  User, 
  Users, 
  Briefcase,
  Mail,
  Code2,
  Tag,
  X,
  Check,
  Calendar,
  Clock,
  Package,
  FileText
} from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DataTable, type Column } from '@/components/data-table';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { notify } from '@/lib/notify';
import { useAuthStore } from '@/stores/auth.store';
import {
  useCreatePartner,
  useDeletePartner,
  usePartners,
  useUpdatePartner,
  type Partner,
} from '@/features/partners/api';

const schema = z.object({
  code: z.string().min(1, 'Code is required'),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  isCustomer: z.boolean(),
  isSupplier: z.boolean(),
  isEmployee: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

const partnerTypes = [
  { key: 'isCustomer' as const, label: 'Customer', icon: Users, description: 'Buy products or services' },
  { key: 'isSupplier' as const, label: 'Supplier', icon: Building2, description: 'Provide products or services' },
  { key: 'isEmployee' as const, label: 'Employee', icon: Briefcase, description: 'Staff member' },
];

export function PartnersPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
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

  const { data, isLoading } = usePartners(
    { page, pageSize, search: search || undefined },
    { enabled: canView }
  );
  const createPartner = useCreatePartner();
  const updatePartner = useUpdatePartner();
  const deletePartner = useDeletePartner();

  const defaultFormValues = useMemo<FormValues>(
    () => ({ code: '', name: '', email: '', isCustomer: true, isSupplier: false, isEmployee: false }),
    []
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaultFormValues,
  });

  const openCreate = useCallback(() => {
    setEditing(null);
    form.reset(defaultFormValues);
    setOpen(true);
  }, [form, defaultFormValues]);

  const openEdit = useCallback(
    (p: Partner) => {
      setEditing(p);
      form.reset({
        code: p.code,
        name: p.name,
        email: p.email ?? '',
        isCustomer: p.isCustomer,
        isSupplier: p.isSupplier,
        isEmployee: p.isEmployee,
      });
      setOpen(true);
    },
    [form]
  );

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (editing) {
        await updatePartner.mutateAsync({ id: editing.id, data: values });
        notify.success('Partner updated successfully');
      } else {
        await createPartner.mutateAsync(values);
        notify.success('Partner created successfully');
      }
      setOpen(false);
      form.reset(defaultFormValues);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : 'An unexpected error occurred');
    }
  });

  const handleDelete = useCallback(async () => {
    if (!deleting) return;
    try {
      await deletePartner.mutateAsync(deleting.id);
      notify.success('Partner deleted successfully');
      setDeleting(null);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : 'Could not delete partner');
    }
  }, [deleting, deletePartner]);

  const isMutating = createPartner.isPending || updatePartner.isPending || deletePartner.isPending;

  const columns: Column<Partner>[] = useMemo(() => {
    const cols: Column<Partner>[] = [
      { 
        key: 'code', 
        header: 'Code',
        render: (p) => (
          <div className="flex items-center gap-2">
            <Code2 className="h-4 w-4 text-gray-400" />
            <span className="font-medium text-gray-800">{p.code}</span>
          </div>
        )
      },
      { 
        key: 'name', 
        header: 'Name',
        render: (p) => (
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-[#0066aa]/10 flex items-center justify-center">
              <User className="h-4 w-4 text-[#0066aa]" />
            </div>
            <div className="font-medium text-gray-800">{p.name}</div>
          </div>
        )
      },
      {
        key: 'type',
        header: 'Type',
        render: (p) => (
          <div className="flex flex-wrap gap-1">
            {p.isCustomer && <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-200 border-none">Customer</Badge>}
            {p.isSupplier && <Badge className="bg-purple-100 text-purple-800 hover:bg-purple-200 border-none">Supplier</Badge>}
            {p.isEmployee && <Badge className="bg-green-100 text-green-800 hover:bg-green-200 border-none">Employee</Badge>}
          </div>
        ),
      },
      { 
        key: 'email', 
        header: 'Email', 
        render: (p) => p.email ? (
          <div className="flex items-center gap-2 text-gray-600">
            <Mail className="h-4 w-4" />
            {p.email}
          </div>
        ) : (
          <span className="text-gray-400">—</span>
        )
      },
      {
        key: 'status',
        header: 'Status',
        render: (p) => (
          <Badge variant={p.status === 'active' ? 'default' : 'secondary'} className={p.status === 'active' ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 border-none' : ''}>
            {p.status === 'active' ? 'Active' : 'Inactive'}
          </Badge>
        ),
      },
    ];

    if (canEdit || canDelete) {
      cols.push({
        key: 'actions',
        header: 'Actions',
        render: (p: Partner) => (
          <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
            {canEdit && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openEdit(p)}
                aria-label={`Edit ${p.name}`}
                title="Edit"
                className="h-8 w-8 p-0 hover:bg-blue-50 hover:text-blue-600"
              >
                <Edit className="h-4 w-4" />
              </Button>
            )}
            {canDelete && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDeleting(p)}
                aria-label={`Delete ${p.name}`}
                title="Delete"
                className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ),
      });
    }

    return cols;
  }, [canEdit, canDelete, openEdit]);

  const meta = data?.meta;

  if (!canView) {
    return (
      <div className="space-y-4 p-6">
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-6 text-center">
          <h1 className="text-2xl font-semibold text-destructive">Access Denied</h1>
          <p className="mt-2 text-sm text-muted-foreground">You do not have permission to view partners.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Partners</h1>
          <p className="text-sm text-gray-500">
            Manage customers, suppliers, and employees
          </p>
        </div>
        {canCreate && (
          <Button onClick={openCreate} disabled={isMutating} className="gap-2 bg-[#0066aa] hover:bg-[#005599] text-white">
            <Plus className="h-4 w-4" /> 
            New Partner
          </Button>
        )}
      </div>

      {/* Search & Filters */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              className="pl-9 h-11 border-gray-200 rounded-lg focus:border-[#0066aa] focus:ring-[#0066aa]"
              placeholder="Search partners by name, code, or email..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3">
            <Label className="text-sm text-gray-600">Show:</Label>
            <select
              className="h-11 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#0066aa]/20"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
            >
              {[10, 20, 50, 100].map((size) => (
                <option key={size} value={size}>{size} per page</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Data Table */}
      <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
        <DataTable
          columns={columns}
          data={data?.data ?? []}
          loading={isLoading}
          getRowId={(p) => p.id}
          emptyMessage={
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                <Users className="h-8 w-8 text-gray-400" />
              </div>
              <h3 className="text-lg font-semibold text-gray-800">No partners found</h3>
              <p className="mt-1 text-sm text-gray-500">
                {search ? 'Try adjusting your search terms' : 'Create your first partner to get started'}
              </p>
              {!search && canCreate && (
                <Button onClick={openCreate} className="mt-4" variant="outline">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Partner
                </Button>
              )}
            </div>
          }
        />
      </div>

      {/* Pagination */}
      {meta && (
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="text-sm text-gray-600">
            Showing <span className="font-medium text-gray-800">{(page - 1) * pageSize + 1}</span> to{' '}
            <span className="font-medium text-gray-800">{Math.min(page * pageSize, meta.total)}</span> of{' '}
            <span className="font-medium text-gray-800">{meta.total}</span> partners
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((p) => p - 1)}
              className="border-gray-300"
            >
              Previous
            </Button>
            <span className="text-sm text-gray-600">
              Page {page} of {meta.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= meta.totalPages || isLoading}
              onClick={() => setPage((p) => p + 1)}
              className="border-gray-300"
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[650px] p-0 gap-0 bg-white">
          {/* Header with Blue Background */}
          <DialogHeader className="bg-[#0066aa] text-white p-6 rounded-t-lg">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-white/10 rounded-lg">
                  <Building2 className="h-6 w-6 text-white" />
                </div>
                <div>
                  <DialogTitle className="text-xl font-semibold leading-tight">
                    {editing ? 'Edit Partner' : 'New Partner'}
                  </DialogTitle>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="secondary" className="bg-white/20 text-white hover:bg-white/30 border-none">
                      {editing ? 'Update' : 'Create'}
                    </Badge>
                    <span className="text-sm text-white/80">
                      {editing ? 'Update partner information' : 'Create a new customer, supplier, or employee'}
                    </span>
                  </div>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen(false)}
                className="h-8 w-8 text-white hover:bg-white/20 hover:text-white"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
          </DialogHeader>

          {/* Content */}
          <form onSubmit={onSubmit} className="p-6 space-y-6">
            {/* Basic Information Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Tag className="h-5 w-5 text-[#f59e0b]" />
                <Label className="text-base font-semibold text-gray-800">
                  Basic Information
                </Label>
              </div>
              
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="code" className="text-sm font-medium text-gray-700">
                    Code <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <Code2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <Input 
                      id="code" 
                      className="pl-10 h-11 border-gray-200 rounded-lg focus:border-[#0066aa] focus:ring-[#0066aa]" 
                      placeholder="CUST-001" 
                      {...form.register('code')} 
                    />
                  </div>
                  {form.formState.errors.code && (
                    <p className="text-xs text-destructive">{form.formState.errors.code.message}</p>
                  )}
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-sm font-medium text-gray-700">
                    Name <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <Input 
                      id="name" 
                      className="pl-10 h-11 border-gray-200 rounded-lg focus:border-[#0066aa] focus:ring-[#0066aa]" 
                      placeholder="Acme Ltd" 
                      {...form.register('name')} 
                    />
                  </div>
                  {form.formState.errors.name && (
                    <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
                  )}
                </div>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm font-medium text-gray-700">
                  Email
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <Input 
                    id="email" 
                    type="email" 
                    className="pl-10 h-11 border-gray-200 rounded-lg focus:border-[#0066aa] focus:ring-[#0066aa]" 
                    placeholder="contact@example.com" 
                    {...form.register('email')} 
                  />
                </div>
                {form.formState.errors.email && (
                  <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
                )}
              </div>
            </div>

            {/* Partner Type Section */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-[#8b5cf6]" />
                <Label className="text-base font-semibold text-gray-800">
                  Partner Type
                </Label>
              </div>
              
              <div className="grid gap-3 sm:grid-cols-3">
                {partnerTypes.map((type) => {
                  const Icon = type.icon;
                  const value = form.watch(type.key);
                  
                  return (
                    <div
                      key={type.key}
                      role="button"
                      tabIndex={0}
                      onClick={() => form.setValue(type.key, !value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          form.setValue(type.key, !value);
                        }
                      }}
                      className={`cursor-pointer rounded-lg border-2 p-4 transition-all duration-200 flex flex-col items-center text-center space-y-3 ${
                        value 
                          ? 'border-[#0066aa] bg-[#0066aa]/5 shadow-sm' 
                          : 'border-gray-200 hover:border-gray-300 bg-white hover:bg-gray-50'
                      }`}
                    >
                      <div className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
                        value ? 'bg-[#0066aa] text-white' : 'bg-gray-100 text-gray-500'
                      }`}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="font-semibold text-sm text-gray-800">{type.label}</div>
                        <div className="text-xs text-gray-500 mt-1">{type.description}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </form>

          {/* Footer */}
          <DialogFooter className="p-6 border-t border-gray-200 bg-gray-50/50 rounded-b-lg gap-2">
            <Button 
              type="button" 
              variant="outline" 
              onClick={() => setOpen(false)}
              className="h-11 px-6 rounded-lg border-gray-300 hover:bg-gray-100"
            >
              Cancel
            </Button>
            <Button 
              type="submit" 
              onClick={onSubmit}
              disabled={isMutating} 
              className="h-11 px-6 rounded-lg bg-[#10b981] hover:bg-[#059669] text-white font-medium"
            >
              {createPartner.isPending || updatePartner.isPending ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Saving...
                </span>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  {editing ? 'Update Partner' : 'Create Partner'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent className="p-0 gap-0">
          <AlertDialogHeader className="bg-[#0066aa] text-white p-6 rounded-t-lg">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/10">
                <Trash2 className="h-5 w-5 text-white" />
              </div>
              <div>
                <AlertDialogTitle>Delete Partner</AlertDialogTitle>
                <AlertDialogDescription className="text-white/80 mt-1">
                  This action cannot be undone.
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>
          <div className="p-6">
            <p className="text-sm text-gray-600">
              Are you sure you want to delete{' '}
              <span className="font-semibold text-gray-800">{deleting?.name}</span>{' '}
              <span className="text-gray-500">({deleting?.code})</span>?
            </p>
          </div>
          <AlertDialogFooter className="p-6 border-t border-gray-200 bg-gray-50/50 rounded-b-lg gap-2">
            <AlertDialogCancel className="h-11 px-6 rounded-lg border-gray-300 hover:bg-gray-100">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deletePartner.isPending}
              className="h-11 px-6 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {deletePartner.isPending ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Deleting...
                </span>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Partner
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}