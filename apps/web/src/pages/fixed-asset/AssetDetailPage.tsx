import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { ArrowLeft, Plus } from 'lucide-react';
import { PERMISSIONS } from '@erp/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuthStore } from '@/stores/auth.store';
import { notify } from '@/lib/notify';
import { formatCurrency } from '@/lib/utils';
import { useAsset, useAllAssetCategories, useAssetAssignments, useCreateAssignment, useAssetTransfers, useCreateTransfer, useAssetMaintenance, useCreateMaintenance, useAssetWarranties, useCreateWarranty, useAssetDisposal, useCreateDisposal, useAssetAcquisition, useUpsertAcquisition, useAssetDepreciation } from '@/features/fixed-asset/api';
import type { Asset } from '@/features/fixed-asset/types';
import { tx } from '@/lib/i18n/tx';

const statusColor: Record<string, string> = { active: 'bg-green-100 text-green-800', under_maintenance: 'bg-yellow-100 text-yellow-800', disposed: 'bg-red-100 text-red-800', lost_stolen: 'bg-red-100 text-red-800', in_repair: 'bg-orange-100 text-orange-800', reserved: 'bg-blue-100 text-blue-800' };

export function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: asset, isLoading } = useAsset(id!);
  const { data: categories } = useAllAssetCategories();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canEdit = hasPermission(PERMISSIONS.fixedAsset.update);
  const canDispose = hasPermission(PERMISSIONS.fixedAsset.dispose);
  const [tab, setTab] = useState('overview');

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">{tx('Loading...')}</div>;
  if (!asset) return <div className="p-8 text-center text-muted-foreground">{tx('Asset not found')}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/fixed-assets')}><ArrowLeft className="h-5 w-5" /></Button>
        <div>
          <h1 className="text-2xl font-bold">{asset.name}</h1>
          <p className="text-sm text-muted-foreground">{asset.assetCode} {asset.serialNumber && `· ${asset.serialNumber}`}</p>
        </div>
        <Badge className={statusColor[asset.status] ?? ''}>{asset.status.replace(/_/g, ' ')}</Badge>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">{tx('Overview')}</TabsTrigger>
          <TabsTrigger value="acquisition">{tx('Acquisition')}</TabsTrigger>
          <TabsTrigger value="assignments">{tx('Assignments')}</TabsTrigger>
          <TabsTrigger value="transfers">{tx('Transfers')}</TabsTrigger>
          <TabsTrigger value="depreciation">{tx('Depreciation')}</TabsTrigger>
          <TabsTrigger value="maintenance">{tx('Maintenance')}</TabsTrigger>
          <TabsTrigger value="warranty">{tx('Warranty')}</TabsTrigger>
          <TabsTrigger value="disposal">{tx('Disposal')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <OverviewTab asset={asset} categories={categories ?? []} />
        </TabsContent>
        <TabsContent value="acquisition"><AcquisitionTab assetId={asset.id} /></TabsContent>
        <TabsContent value="assignments"><AssignmentsTab assetId={asset.id} /></TabsContent>
        <TabsContent value="transfers"><TransfersTab assetId={asset.id} canCreate={canEdit} /></TabsContent>
        <TabsContent value="depreciation"><DepreciationTab assetId={asset.id} /></TabsContent>
        <TabsContent value="maintenance"><MaintenanceTab assetId={asset.id} canCreate={canEdit} /></TabsContent>
        <TabsContent value="warranty"><WarrantyTab assetId={asset.id} canCreate={canEdit} /></TabsContent>
        <TabsContent value="disposal"><DisposalTab assetId={asset.id} assetName={asset.name} canDispose={canDispose} /></TabsContent>
      </Tabs>
    </div>
  );
}

function OverviewTab({ asset, categories }: { asset: Asset; categories: any[] }) {
  const catName = categories.find((c: any) => c.id === asset.categoryId)?.name ?? asset.category?.name ?? '-';
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card><CardHeader><CardTitle className="text-sm font-medium">{tx('Purchase Cost')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{formatCurrency(asset.purchaseCost ?? '0')}</p></CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm font-medium">{tx('Current Value')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{formatCurrency(asset.currentValue ?? '0')}</p></CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm font-medium">{tx('Salvage Value')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{formatCurrency(asset.salvageValue ?? '0')}</p></CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm font-medium">{tx('Useful Life')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{asset.usefulLife ?? 60} {tx('months')}</p></CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm font-medium">{tx('Category')}</CardTitle></CardHeader><CardContent><p className="text-lg">{catName}</p></CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm font-medium">{tx('Location')}</CardTitle></CardHeader><CardContent><p className="text-lg">{asset.location ?? '-'}</p></CardContent></Card>
      <div className="md:col-span-3">
        <Card>
          <CardHeader><CardTitle>{tx('Details')}</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              {asset.description && <><dt className="text-muted-foreground">{tx('Description')}</dt><dd>{asset.description}</dd></>}
              {asset.brand && <><dt className="text-muted-foreground">{tx('Brand')}</dt><dd>{asset.brand}</dd></>}
              {asset.model && <><dt className="text-muted-foreground">{tx('Model')}</dt><dd>{asset.model}</dd></>}
              {asset.manufacturer && <><dt className="text-muted-foreground">{tx('Manufacturer')}</dt><dd>{asset.manufacturer}</dd></>}
              {asset.serialNumber && <><dt className="text-muted-foreground">{tx('Serial #')}</dt><dd>{asset.serialNumber}</dd></>}
              {asset.barcode && <><dt className="text-muted-foreground">{tx('Barcode')}</dt><dd>{asset.barcode}</dd></>}
              {asset.department && <><dt className="text-muted-foreground">{tx('Department')}</dt><dd>{asset.department}</dd></>}
              {asset.purchaseDate && <><dt className="text-muted-foreground">{tx('Purchase Date')}</dt><dd>{new Date(asset.purchaseDate).toLocaleDateString()}</dd></>}
              {asset.supplierId && <><dt className="text-muted-foreground">{tx('Supplier')}</dt><dd>{asset.supplierId}</dd></>}
              {asset.invoiceNumber && <><dt className="text-muted-foreground">{tx('Invoice #')}</dt><dd>{asset.invoiceNumber}</dd></>}
              <dt className="text-muted-foreground">{tx('Acquisition Method')}</dt><dd className="capitalize">{asset.acquisitionMethod?.replace(/_/g, ' ') ?? '-'}</dd>
              {asset.notes && <><dt className="text-muted-foreground">{tx('Notes')}</dt><dd>{asset.notes}</dd></>}
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function AcquisitionTab({ assetId }: { assetId: string }) {
  const { data, isLoading } = useAssetAcquisition(assetId);
  const upsert = useUpsertAcquisition();
  const [open, setOpen] = useState(false);
  const form = useForm({ defaultValues: { vendor: '', taxes: '', freight: '', installationCost: '', otherCosts: '', capitalizedCost: '', acquisitionDate: '', notes: '' } });
  if (isLoading) return <div className="text-muted-foreground">{tx('Loading...')}</div>;
  const acq = data;
  return (
    <div>
      <div className="flex justify-between mb-4"><h3 className="text-lg font-semibold">{tx('Acquisition Details')}</h3><Button size="sm" onClick={() => { form.reset({ vendor: acq?.vendor ?? '', taxes: acq?.taxes ?? '', freight: acq?.freight ?? '', installationCost: acq?.installationCost ?? '', otherCosts: acq?.otherCosts ?? '', capitalizedCost: acq?.capitalizedCost ?? '', acquisitionDate: acq?.acquisitionDate?.split('T')[0] ?? '', notes: acq?.notes ?? '' }); setOpen(true); }}><Plus className="mr-2 h-4 w-4" />{acq ? 'Edit' : 'Add'}</Button></div>
      {acq ? (
        <Card><CardContent className="pt-6">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">{tx('Vendor')}</dt><dd>{acq.vendor ?? '-'}</dd>
            <dt className="text-muted-foreground">{tx('Taxes')}</dt><dd>{acq.taxes ? formatCurrency(acq.taxes) : '-'}</dd>
            <dt className="text-muted-foreground">{tx('Freight')}</dt><dd>{acq.freight ? formatCurrency(acq.freight) : '-'}</dd>
            <dt className="text-muted-foreground">{tx('Installation Cost')}</dt><dd>{acq.installationCost ? formatCurrency(acq.installationCost) : '-'}</dd>
            <dt className="text-muted-foreground">{tx('Capitalized Cost')}</dt><dd className="font-bold">{acq.capitalizedCost ? formatCurrency(acq.capitalizedCost) : '-'}</dd>
            <dt className="text-muted-foreground">{tx('Date')}</dt><dd>{acq.acquisitionDate ? new Date(acq.acquisitionDate).toLocaleDateString() : '-'}</dd>
            {acq.notes && <><dt className="text-muted-foreground">{tx('Notes')}</dt><dd>{acq.notes}</dd></>}
          </dl>
        </CardContent></Card>
      ) : <p className="text-muted-foreground">{tx('No acquisition record.')}</p>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{tx('Acquisition Details')}</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(async (v) => {
            try { await upsert.mutateAsync({ assetId, data: { ...v, taxes: v.taxes ? Number(v.taxes) : undefined, freight: v.freight ? Number(v.freight) : undefined, installationCost: v.installationCost ? Number(v.installationCost) : undefined, otherCosts: v.otherCosts ? Number(v.otherCosts) : undefined, capitalizedCost: v.capitalizedCost ? Number(v.capitalizedCost) : undefined, acquisitionDate: v.acquisitionDate || undefined } }); notify.success(tx('Saved')); setOpen(false); } catch (e: any) { notify.error(e?.response?.data?.message ?? 'Error'); }
          })} className="space-y-3">
            <div className="grid grid-cols-2 gap-3"><div><Label>{tx('Vendor')}</Label><Input {...form.register('vendor')} /></div><div><Label>{tx('Date')}</Label><Input type="date" {...form.register('acquisitionDate')} /></div></div>
            <div className="grid grid-cols-2 gap-3"><div><Label>{tx('Taxes')}</Label><Input type="number" step="0.01" {...form.register('taxes')} /></div><div><Label>{tx('Freight')}</Label><Input type="number" step="0.01" {...form.register('freight')} /></div></div>
            <div className="grid grid-cols-2 gap-3"><div><Label>{tx('Installation Cost')}</Label><Input type="number" step="0.01" {...form.register('installationCost')} /></div><div><Label>{tx('Other Costs')}</Label><Input type="number" step="0.01" {...form.register('otherCosts')} /></div></div>
            <div><Label>{tx('Capitalized Cost')}</Label><Input type="number" step="0.01" {...form.register('capitalizedCost')} /></div>
            <div><Label>{tx('Notes')}</Label><Input {...form.register('notes')} /></div>
            <DialogFooter><Button type="submit">{tx('Save')}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AssignmentsTab({ assetId }: { assetId: string }) {
  const { data, isLoading } = useAssetAssignments(assetId);
  const create = useCreateAssignment();
  const [open, setOpen] = useState(false);
  const form = useForm({ defaultValues: { assignedToId: '', assignedToType: '', assignedToName: '', assignedDate: new Date().toISOString().split('T')[0], notes: '' } });
  if (isLoading) return <div className="text-muted-foreground">{tx('Loading...')}</div>;
  return (
    <div>
      <div className="flex justify-between mb-4"><h3 className="text-lg font-semibold">{tx('Assignments')}</h3><Button size="sm" onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />{tx('Assign')}</Button></div>
      {data?.length ? data.map((a: any) => (
        <Card key={a.id} className="mb-2"><CardContent className="pt-4 flex justify-between">
          <div><p className="font-medium">{a.assignedToName ?? a.assignedToId ?? 'Unknown'}</p><p className="text-sm text-muted-foreground">{a.assignedToType?.replace(/_/g, ' ') ?? ''} · {new Date(a.assignedDate).toLocaleDateString()}{a.returnedDate ? ` → ${new Date(a.returnedDate).toLocaleDateString()}` : ' (Active)'}</p></div>
          {a.conditionBefore && <Badge variant="outline">{a.conditionBefore}</Badge>}
        </CardContent></Card>
      )) : <p className="text-muted-foreground">{tx('No assignments.')}</p>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{tx('Assign Asset')}</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(async (v) => { try { await create.mutateAsync({ assetId, data: { ...v, assignedDate: v.assignedDate || undefined } }); notify.success(tx('Assigned')); setOpen(false); form.reset(); } catch (e: any) { notify.error(e?.response?.data?.message ?? 'Error'); } })} className="space-y-3">
            <div><Label>{tx('Assign To (ID)')}</Label><Input {...form.register('assignedToId')} /></div>
            <div><Label>{tx('Type')}</Label><Select value={form.watch('assignedToType')} onValueChange={(v) => form.setValue('assignedToType', v)}><SelectTrigger><SelectValue placeholder={tx('Type')} /></SelectTrigger><SelectContent>{['employee', 'teacher', 'student', 'department', 'branch', 'room', 'vehicle', 'clinic', 'store'].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>{tx('Name')}</Label><Input {...form.register('assignedToName')} /></div>
            <div><Label>{tx('Date')}</Label><Input type="date" {...form.register('assignedDate')} /></div>
            <div><Label>{tx('Notes')}</Label><Input {...form.register('notes')} /></div>
            <DialogFooter><Button type="submit">{tx('Assign')}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TransfersTab({ assetId, canCreate }: { assetId: string; canCreate: boolean }) {
  const { data, isLoading } = useAssetTransfers(assetId);
  const create = useCreateTransfer();
  const [open, setOpen] = useState(false);
  const form = useForm({ defaultValues: { toLocation: '', reason: '', notes: '' } });
  if (isLoading) return <div className="text-muted-foreground">{tx('Loading...')}</div>;
  return (
    <div>
      <div className="flex justify-between mb-4"><h3 className="text-lg font-semibold">{tx('Transfers')}</h3>{canCreate && <Button size="sm" onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />{tx('Transfer')}</Button>}</div>
      {data?.length ? data.map((t: any) => (
        <Card key={t.id} className="mb-2"><CardContent className="pt-4">
          <div className="flex justify-between"><p className="font-medium">{t.fromLocation ?? '?'} → {t.toLocation ?? '?'}</p><span className="text-sm text-muted-foreground">{new Date(t.transferDate).toLocaleDateString()}</span></div>
          {t.reason && <p className="text-sm text-muted-foreground">{t.reason}</p>}
        </CardContent></Card>
      )) : <p className="text-muted-foreground">{tx('No transfers.')}</p>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{tx('Transfer Asset')}</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(async (v) => { try { await create.mutateAsync({ assetId, data: v }); notify.success(tx('Transferred')); setOpen(false); form.reset(); } catch (e: any) { notify.error(e?.response?.data?.message ?? 'Error'); } })} className="space-y-3">
            <div><Label>{tx('To Location')}</Label><Input {...form.register('toLocation')} /></div>
            <div><Label>{tx('Reason')}</Label><Input {...form.register('reason')} /></div>
            <div><Label>{tx('Notes')}</Label><Input {...form.register('notes')} /></div>
            <DialogFooter><Button type="submit">{tx('Transfer')}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DepreciationTab({ assetId }: { assetId: string }) {
  const { data, isLoading } = useAssetDepreciation(assetId);
  if (isLoading) return <div className="text-muted-foreground">{tx('Loading...')}</div>;
  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">{tx('Depreciation Schedule')}</h3>
      {data?.length ? (
        <div className="space-y-2">
          <div className="grid grid-cols-4 gap-4 text-sm font-medium text-muted-foreground px-2">
            <span>{tx('Period')}</span><span className="text-right">{tx('Amount')}</span><span className="text-right">{tx('Accumulated')}</span><span className="text-right">{tx('Book Value')}</span>
          </div>
          {data.map((d: any) => (
            <div key={d.id} className="grid grid-cols-4 gap-4 text-sm bg-card border rounded-lg px-3 py-2">
              <span>{d.period}{d.isPosted && <Badge className="ml-2 bg-green-100 text-green-800" variant="outline">{tx('Posted')}</Badge>}</span>
              <span className="text-right">{formatCurrency(d.depreciationAmount)}</span>
              <span className="text-right">{formatCurrency(d.accumulatedDepr)}</span>
              <span className="text-right font-medium">{formatCurrency(d.bookValue)}</span>
            </div>
          ))}
        </div>
      ) : <p className="text-muted-foreground">{tx('No depreciation entries. Run depreciation from the dashboard.')}</p>}
    </div>
  );
}

function MaintenanceTab({ assetId, canCreate }: { assetId: string; canCreate: boolean }) {
  const { data, isLoading } = useAssetMaintenance(assetId);
  const create = useCreateMaintenance();
  const [open, setOpen] = useState(false);
  const form = useForm({ defaultValues: { title: '', maintenanceType: 'preventive', scheduledDate: '', cost: '', notes: '' } });
  if (isLoading) return <div className="text-muted-foreground">{tx('Loading...')}</div>;
  return (
    <div>
      <div className="flex justify-between mb-4"><h3 className="text-lg font-semibold">{tx('Maintenance')}</h3>{canCreate && <Button size="sm" onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />{tx('Schedule')}</Button>}</div>
      {data?.length ? data.map((m: any) => (
        <Card key={m.id} className="mb-2"><CardContent className="pt-4 flex justify-between items-center">
          <div><p className="font-medium">{m.title}</p><p className="text-sm text-muted-foreground">{m.maintenanceType.replace(/_/g, ' ')} · {m.scheduledDate ? new Date(m.scheduledDate).toLocaleDateString() : ''}{m.cost ? ` · ${formatCurrency(m.cost)}` : ''}</p></div>
          <Badge>{m.status?.replace(/_/g, ' ')}</Badge>
        </CardContent></Card>
      )) : <p className="text-muted-foreground">{tx('No maintenance records.')}</p>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{tx('Schedule Maintenance')}</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(async (v) => { try { await create.mutateAsync({ assetId, data: { ...v, cost: v.cost ? Number(v.cost) : undefined, scheduledDate: v.scheduledDate || undefined } }); notify.success(tx('Scheduled')); setOpen(false); form.reset(); } catch (e: any) { notify.error(e?.response?.data?.message ?? 'Error'); } })} className="space-y-3">
            <div><Label>{tx('Title *')}</Label><Input {...form.register('title')} /></div>
            <div><Label>{tx('Type')}</Label><Select value={form.watch('maintenanceType')} onValueChange={(v) => form.setValue('maintenanceType', v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{['preventive', 'corrective', 'emergency', 'scheduled', 'calibration'].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>{tx('Date')}</Label><Input type="date" {...form.register('scheduledDate')} /></div>
            <div><Label>{tx('Cost')}</Label><Input type="number" step="0.01" {...form.register('cost')} /></div>
            <div><Label>{tx('Notes')}</Label><Input {...form.register('notes')} /></div>
            <DialogFooter><Button type="submit">{tx('Save')}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WarrantyTab({ assetId, canCreate }: { assetId: string; canCreate: boolean }) {
  const { data, isLoading } = useAssetWarranties(assetId);
  const create = useCreateWarranty();
  const [open, setOpen] = useState(false);
  const form = useForm({ defaultValues: { warrantyStart: '', warrantyEnd: '', vendor: '', coverage: '', notes: '' } });
  if (isLoading) return <div className="text-muted-foreground">{tx('Loading...')}</div>;
  return (
    <div>
      <div className="flex justify-between mb-4"><h3 className="text-lg font-semibold">{tx('Warranties')}</h3>{canCreate && <Button size="sm" onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />{tx('Add Warranty')}</Button>}</div>
      {data?.length ? data.map((w: any) => (
        <Card key={w.id} className="mb-2"><CardContent className="pt-4">
          <div className="flex justify-between"><p className="font-medium">{w.vendor ?? 'Warranty'}</p><span className="text-sm text-muted-foreground">{new Date(w.warrantyStart).toLocaleDateString()} - {new Date(w.warrantyEnd).toLocaleDateString()}</span></div>
          {w.coverage && <p className="text-sm text-muted-foreground">{w.coverage}</p>}
        </CardContent></Card>
      )) : <p className="text-muted-foreground">{tx('No warranties.')}</p>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{tx('Add Warranty')}</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(async (v) => { try { await create.mutateAsync({ assetId, data: v }); notify.success(tx('Saved')); setOpen(false); form.reset(); } catch (e: any) { notify.error(e?.response?.data?.message ?? 'Error'); } })} className="space-y-3">
            <div className="grid grid-cols-2 gap-3"><div><Label>{tx('Start *')}</Label><Input type="date" {...form.register('warrantyStart')} /></div><div><Label>{tx('End *')}</Label><Input type="date" {...form.register('warrantyEnd')} /></div></div>
            <div><Label>{tx('Vendor')}</Label><Input {...form.register('vendor')} /></div>
            <div><Label>{tx('Coverage')}</Label><Input {...form.register('coverage')} /></div>
            <div><Label>{tx('Notes')}</Label><Input {...form.register('notes')} /></div>
            <DialogFooter><Button type="submit">{tx('Save')}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DisposalTab({ assetId, assetName, canDispose }: { assetId: string; assetName: string; canDispose: boolean }) {
  const { data, isLoading } = useAssetDisposal(assetId);
  const create = useCreateDisposal();
  const [open, setOpen] = useState(false);
  const form = useForm({ defaultValues: { disposalMethod: 'sold', disposalDate: new Date().toISOString().split('T')[0], disposalValue: '', reason: '', notes: '' } });
  if (isLoading) return <div className="text-muted-foreground">{tx('Loading...')}</div>;
  if (data) return (
    <Card><CardContent className="pt-6">
      <p className="text-lg font-semibold text-red-600">{tx('Disposed (')}{data.disposalMethod?.replace(/_/g, ' ')})</p>
      <p className="text-sm text-muted-foreground">{new Date(data.disposalDate).toLocaleDateString()}{data.disposalValue ? ` · Value: ${formatCurrency(data.disposalValue)}` : ''}{data.gainLoss ? ` · Gain/Loss: ${formatCurrency(data.gainLoss)}` : ''}</p>
      {data.reason && <p className="text-sm mt-2">{data.reason}</p>}
    </CardContent></Card>
  );
  return (
    <div>
      <p className="text-muted-foreground mb-4">{tx('This asset is not disposed.')}</p>
      {canDispose && <Button variant="destructive" onClick={() => setOpen(true)}>{tx('Dispose Asset')}</Button>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{tx('Dispose "')}{assetName}"</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(async (v) => { try { await create.mutateAsync({ assetId, data: { ...v, disposalValue: v.disposalValue ? Number(v.disposalValue) : undefined } }); notify.success(tx('Disposed')); setOpen(false); } catch (e: any) { notify.error(e?.response?.data?.message ?? 'Error'); } })} className="space-y-3">
            <div><Label>{tx('Method')}</Label><Select value={form.watch('disposalMethod')} onValueChange={(v) => form.setValue('disposalMethod', v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{['sold', 'scrapped', 'donated', 'lost', 'stolen', 'destroyed'].map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>{tx('Date')}</Label><Input type="date" {...form.register('disposalDate')} /></div>
            <div><Label>{tx('Disposal Value')}</Label><Input type="number" step="0.01" {...form.register('disposalValue')} /></div>
            <div><Label>{tx('Reason')}</Label><Input {...form.register('reason')} /></div>
            <div><Label>{tx('Notes')}</Label><Input {...form.register('notes')} /></div>
            <DialogFooter><Button type="submit" variant="destructive">{tx('Dispose')}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
