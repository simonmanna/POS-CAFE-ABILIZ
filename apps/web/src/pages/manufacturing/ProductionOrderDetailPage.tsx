import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Play, PackageCheck, XCircle, ClipboardCheck, ShieldCheck, Undo2, Hammer, Pause } from 'lucide-react';
import { PERMISSIONS } from '@erp/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuthStore } from '@/stores/auth.store';
import { notify } from '@/lib/notify';
import {
  useProductionAction,
  useProductionOrder,
  useWorkOrders,
  useGenerateWorkOrders,
  useWorkOrderAction,
} from '@/features/manufacturing/api';
import { ORDER_STATUS_VARIANT } from './ProductionOrdersPage';
import { tx } from '@/lib/i18n/tx';

export function ProductionOrderDetailPage() {
  const { id = '' } = useParams();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const { data: order, isLoading } = useProductionOrder(id);

  const confirm = useProductionAction('confirm');
  const start = useProductionAction('start');
  const complete = useProductionAction('complete');
  const cancel = useProductionAction('cancel');
  const qcAction = useProductionAction('qc');
  const reverse = useProductionAction('reverse');

  const { data: workOrders } = useWorkOrders(id);
  const generateWo = useGenerateWorkOrders();
  const woStart = useWorkOrderAction('start');
  const woPause = useWorkOrderAction('pause');
  const woComplete = useWorkOrderAction('complete');

  const [completeOpen, setCompleteOpen] = useState(false);
  const [qtyProduced, setQtyProduced] = useState('');
  const [scrapQty, setScrapQty] = useState('');
  const [qcOpen, setQcOpen] = useState(false);
  const [passedQty, setPassedQty] = useState('');
  const [failedQty, setFailedQty] = useState('');

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">{tx('Loading…')}</div>;
  if (!order) return <div className="p-6 text-sm text-muted-foreground">{tx('Order not found.')}</div>;

  const act = async (m: { mutateAsync: (a: { id: string; body?: Record<string, unknown> }) => Promise<unknown> }, body?: Record<string, unknown>, ok?: string) => {
    try {
      await m.mutateAsync({ id, body });
      if (ok) notify.success(ok);
    } catch (e: any) {
      notify.error(tx('Action failed'), e?.response?.data?.message ?? e?.message);
    }
  };

  const doComplete = async () => {
    if (!(Number(qtyProduced) > 0)) {
      notify.error(tx('Enter the actual quantity produced.'));
      return;
    }
    await act(complete, { qtyProduced: Number(qtyProduced), scrapQty: scrapQty ? Number(scrapQty) : undefined }, 'Order completed — finished goods received.');
    setCompleteOpen(false);
    setQtyProduced('');
    setScrapQty('');
  };

  const doQc = async () => {
    if (!(Number(passedQty) >= 0)) return;
    await act(qcAction, { passedQty: Number(passedQty), failedQty: failedQty ? Number(failedQty) : undefined, wasteCategory: 'qc_rejection' }, 'QC recorded.');
    setQcOpen(false);
    setPassedQty('');
    setFailedQty('');
  };

  const canConfirm = hasPermission(PERMISSIONS.productionOrder.create) && order.status === 'draft';
  const canStart = hasPermission(PERMISSIONS.productionOrder.start) && order.status === 'confirmed';
  const canComplete = hasPermission(PERMISSIONS.productionOrder.complete) && order.status === 'in_progress';
  const canQc = hasPermission(PERMISSIONS.productionOrder.qc) && order.status === 'qc_hold';
  const canReverse = hasPermission(PERMISSIONS.productionOrder.cancel) && order.status === 'completed' && Number(order.producedQty) > 0;
  const canCancel = hasPermission(PERMISSIONS.productionOrder.cancel) && ['draft', 'confirmed', 'in_progress'].includes(order.status);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon"><Link to="/manufacturing/orders"><ArrowLeft className="h-4 w-4" /></Link></Button>
        <div className="flex-1">
          <h1 className="font-mono text-xl font-semibold">{order.orderCode}</h1>
          <p className="text-sm text-muted-foreground">{tx('Planned')} {Number(order.plannedQty)} {tx('· created')} {new Date(order.createdAt).toLocaleDateString()}</p>
        </div>
        <Badge variant={ORDER_STATUS_VARIANT[order.status]}>{order.status.replace('_', ' ')}</Badge>
      </div>

      <div className="flex flex-wrap gap-2">
        {canConfirm && <Button variant="outline" onClick={() => act(confirm, undefined, 'Order confirmed.')}><ClipboardCheck className="mr-2 h-4 w-4" /> {tx('Confirm')}</Button>}
        {canStart && <Button onClick={() => act(start, undefined, 'Started — materials consumed into WIP.')}><Play className="mr-2 h-4 w-4" /> {tx('Start')}</Button>}
        {canComplete && <Button onClick={() => setCompleteOpen(true)}><PackageCheck className="mr-2 h-4 w-4" /> {tx('Complete')}</Button>}
        {canQc && <Button onClick={() => setQcOpen(true)}><ShieldCheck className="mr-2 h-4 w-4" /> {tx('Record QC')}</Button>}
        {canReverse && <Button variant="outline" onClick={() => act(reverse, { reason: 'reversed from UI' }, 'Order reversed.')}><Undo2 className="mr-2 h-4 w-4" /> {tx('Reverse')}</Button>}
        {canCancel && <Button variant="destructive" onClick={() => act(cancel, { reason: 'cancelled from UI' }, 'Order cancelled.')}><XCircle className="mr-2 h-4 w-4" /> {tx('Cancel')}</Button>}
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label={tx('Material cost')} value={Number(order.materialCost).toFixed(2)} />
        <Stat label={tx('Produced')} value={Number(order.producedQty)} />
        <Stat label={tx('Unit cost')} value={order.status === 'completed' ? Number(order.outputUnitCost).toFixed(2) : '—'} />
        <Stat label={tx('Yield variance')} value={Number(order.yieldVariance).toFixed(2)} />
      </div>

      <Card>
        <CardHeader><CardTitle>{tx('Materials')}</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tx('Product')}</TableHead>
                <TableHead className="text-right">{tx('Planned')}</TableHead>
                <TableHead className="text-right">{tx('Consumed')}</TableHead>
                <TableHead className="text-right">{tx('Unit cost')}</TableHead>
                <TableHead className="text-right">{tx('Total')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.materials.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.productName}</TableCell>
                  <TableCell className="text-right">{Number(m.qtyPlanned)}</TableCell>
                  <TableCell className="text-right">{Number(m.qtyConsumed)}</TableCell>
                  <TableCell className="text-right">{Number(m.unitCost).toFixed(2)}</TableCell>
                  <TableCell className="text-right">{Number(m.totalCost).toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{tx('Outputs')}</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tx('Product')}</TableHead>
                <TableHead>{tx('Kind')}</TableHead>
                <TableHead className="text-right">{tx('Expected')}</TableHead>
                <TableHead className="text-right">{tx('Produced')}</TableHead>
                <TableHead>{tx('Batch')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.outputs.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>{o.productName}</TableCell>
                  <TableCell><Badge variant="outline">{o.kind}</Badge></TableCell>
                  <TableCell className="text-right">{Number(o.qtyExpected)}</TableCell>
                  <TableCell className="text-right">{Number(o.qtyProduced)}</TableCell>
                  <TableCell className="font-mono text-xs">{o.batchNumber ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{tx('Work Orders')}</CardTitle>
          {!workOrders?.length && ['confirmed', 'in_progress'].includes(order.status) && (
            <Button size="sm" variant="outline" onClick={async () => {
              try { await generateWo.mutateAsync(id); notify.success(tx('Work orders generated from routing.')); }
              catch (e: any) { notify.error(tx('No routing'), e?.response?.data?.message ?? e?.message); }
            }}><Hammer className="mr-1 h-3 w-3" /> {tx('Generate')}</Button>
          )}
        </CardHeader>
        <CardContent>
          {!workOrders?.length ? (
            <p className="text-sm text-muted-foreground">{tx('No work orders. Generate them from the BOM\'s routing (Phase 4).')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>{tx('Operation')}</TableHead>
                  <TableHead>{tx('Work centre')}</TableHead>
                  <TableHead className="text-right">{tx('Labour (min)')}</TableHead>
                  <TableHead>{tx('Status')}</TableHead>
                  <TableHead className="text-right">{tx('Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workOrders.map((w: any) => (
                  <TableRow key={w.id}>
                    <TableCell>{w.operationSequence}</TableCell>
                    <TableCell>{w.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{w.workCenter?.name ?? '—'}</TableCell>
                    <TableCell className="text-right">{w.labourMins}</TableCell>
                    <TableCell><Badge variant="outline">{w.status.replace('_', ' ')}</Badge></TableCell>
                    <TableCell className="text-right space-x-1">
                      {(w.status === 'pending' || w.status === 'paused') && (
                        <Button size="icon" variant="ghost" onClick={() => woStart.mutate({ id: w.id, orderId: id })}><Play className="h-3 w-3" /></Button>
                      )}
                      {w.status === 'in_progress' && (
                        <>
                          <Button size="icon" variant="ghost" onClick={() => woPause.mutate({ id: w.id, orderId: id })}><Pause className="h-3 w-3" /></Button>
                          <Button size="icon" variant="ghost" onClick={() => woComplete.mutate({ id: w.id, orderId: id, body: {} })}><PackageCheck className="h-3 w-3" /></Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={qcOpen} onOpenChange={setQcOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{tx('Record QC ·')} {order.orderCode}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{tx('Passed units move to the sale location; failed units are scrapped from quarantine.')}</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1"><Label>{tx('Passed')}</Label><Input type="number" value={passedQty} onChange={(e) => setPassedQty(e.target.value)} /></div>
              <div className="space-y-1"><Label>{tx('Failed')}</Label><Input type="number" value={failedQty} onChange={(e) => setFailedQty(e.target.value)} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQcOpen(false)}>{tx('Cancel')}</Button>
            <Button onClick={doQc}>{tx('Record')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{tx('Complete')} {order.orderCode}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>{tx('Actual quantity produced')}</Label>
              <Input type="number" value={qtyProduced} onChange={(e) => setQtyProduced(e.target.value)} placeholder={String(Number(order.plannedQty))} />
              <p className="text-xs text-muted-foreground">{tx('Unit cost = material cost ÷ this quantity, so under-yield raises the cost.')}</p>
            </div>
            <div className="space-y-1">
              <Label>{tx('Scrap quantity (optional)')}</Label>
              <Input type="number" value={scrapQty} onChange={(e) => setScrapQty(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleteOpen(false)}>{tx('Cancel')}</Button>
            <Button onClick={doComplete} disabled={complete.isPending}>{tx('Receive finished goods')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}

export default ProductionOrderDetailPage;
