import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateRepairOrder } from '@/features/repair/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { tx } from '@/lib/i18n/tx';

const TYPES = [
  { value: 'repair', label: 'Repair' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'preventive', label: 'Preventive' },
  { value: 'contract', label: 'Contract (SLA)' },
  { value: 'field_service', label: 'Field service' },
];

const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export function RepairOrderCreatePage() {
  const navigate = useNavigate();
  const create = useCreateRepairOrder();
  const [form, setForm] = useState({
    partnerId: '',
    orderType: 'repair',
    priority: 'medium',
    itemType: '',
    brand: '',
    model: '',
    serialNumber: '',
    imei: '',
    assetTag: '',
    plateNumber: '',
    vin: '',
    problemDescription: '',
    dueDate: '',
    notes: '',
  });
  const [error, setError] = useState('');

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setError('');
    try {
      const order: any = await create.mutateAsync({
        ...form,
        dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : undefined,
        partnerId: form.partnerId || undefined,
      });
      navigate(`/repair/orders/${order.id}`);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? String(e?.message ?? e));
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">{tx('New Repair Order')}</h1>
        <p className="text-sm text-muted-foreground">{tx('Record the incoming item and problem. Diagnosis and quotation come next.')}</p>
      </div>

      <Card>
        <CardHeader className="bg-muted/30 border-b rounded-t-lg"><CardTitle className="text-sm">{tx('Order')}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
          <div>
            <Label>{tx('Order type')}</Label>
            <select value={form.orderType} onChange={(e) => set('orderType', e.target.value)} className="w-full rounded-md border bg-card px-3 py-2 text-sm">
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <Label>{tx('Priority')}</Label>
            <select value={form.priority} onChange={(e) => set('priority', e.target.value)} className="w-full rounded-md border bg-card px-3 py-2 text-sm">
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Label>{tx('Customer (partner ID)')}</Label>
            <Input value={form.partnerId} onChange={(e) => set('partnerId', e.target.value)} placeholder={tx('Partner ID — leave blank for walk-in')} />
          </div>
          <div>
            <Label>{tx('Due date')}</Label>
            <Input type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="bg-muted/30 border-b rounded-t-lg"><CardTitle className="text-sm">{tx('Item / Equipment')}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          <div>
            <Label>{tx('Item type')}</Label>
            <Input value={form.itemType} onChange={(e) => set('itemType', e.target.value)} placeholder={tx('Phone, laptop, vehicle…')} />
          </div>
          <div>
            <Label>{tx('Brand')}</Label>
            <Input value={form.brand} onChange={(e) => set('brand', e.target.value)} placeholder={tx('Samsung, Toyota…')} />
          </div>
          <div>
            <Label>{tx('Model')}</Label>
            <Input value={form.model} onChange={(e) => set('model', e.target.value)} placeholder={tx('S24, Avanza…')} />
          </div>
          <div>
            <Label>{tx('Serial number')}</Label>
            <Input value={form.serialNumber} onChange={(e) => set('serialNumber', e.target.value)} />
          </div>
          <div>
            <Label>IMEI</Label>
            <Input value={form.imei} onChange={(e) => set('imei', e.target.value)} />
          </div>
          <div>
            <Label>{tx('Asset tag')}</Label>
            <Input value={form.assetTag} onChange={(e) => set('assetTag', e.target.value)} />
          </div>
          <div>
            <Label>{tx('Plate number')}</Label>
            <Input value={form.plateNumber} onChange={(e) => set('plateNumber', e.target.value)} />
          </div>
          <div>
            <Label>VIN</Label>
            <Input value={form.vin} onChange={(e) => set('vin', e.target.value)} />
          </div>
          <div className="sm:col-span-3">
            <Label>{tx('Problem description')}</Label>
            <textarea
              value={form.problemDescription}
              onChange={(e) => set('problemDescription', e.target.value)}
              rows={3}
              className="w-full rounded-md border bg-card px-3 py-2 text-sm"
              placeholder={tx('Reported fault, symptoms, customer notes…')}
            />
          </div>
          <div className="sm:col-span-3">
            <Label>{tx('Internal notes')}</Label>
            <textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={2}
              className="w-full rounded-md border bg-card px-3 py-2 text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate('/repair/orders')}>{tx('Cancel')}</Button>
        <Button onClick={submit} disabled={create.isPending}>{tx('Create repair order')}</Button>
      </div>
    </div>
  );
}
