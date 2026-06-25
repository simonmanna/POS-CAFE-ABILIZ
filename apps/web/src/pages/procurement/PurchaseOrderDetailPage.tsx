import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import {
  ArrowLeft, Send, Check, X, Truck, Package,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { formatMoney, date, dateTime } from '@/lib/format';

interface POLine {
  id: string; productId: string | null; description: string;
  quantity: number; unitPrice: number; receivedQuantity: number;
  billedQuantity: number; lineNumber: number; taxRate: number;
  subtotal: number; notes: string | null;
}

interface PO {
  id: string; orderNumber: string; partnerId: string;
  status: string; orderDate: string; description: string | null;
  expectedDeliveryDate: string | null; currencyCode: string;
  totalAmount: number; subtotal: number; taxAmount: number;
  notes: string | null; terms: string | null;
  approvedAt: string | null; approvedById: string | null;
  lines: POLine[];
  receipts?: any[];
  bills?: any[];
  matchStatuses?: any[];
  request?: any;
}

const STATUS_BADGE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  draft: 'secondary', submitted: 'secondary', approved: 'default',
  sent: 'default', partially_received: 'default', received: 'default',
  billed: 'default', closed: 'outline', cancelled: 'destructive',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', submitted: 'Submitted', approved: 'Approved',
  sent: 'Sent to Supplier', partially_received: 'Partially Received',
  received: 'Received', billed: 'Billed', closed: 'Closed', cancelled: 'Cancelled',
};

export function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [rejectReason, setRejectReason] = useState('');
  const [showCancel, setShowCancel] = useState(false);

  const po = useQuery<PO>({
    queryKey: ['purchase-order', id],
    queryFn: async () => (await api.get<PO>(`/procurement/purchase-orders/${id}`)).data,
    enabled: !!id,
  });

  const act = useMutation({
    mutationFn: async (action: string) => {
      if (action === 'cancel') {
        return (await api.patch(`/procurement/purchase-orders/${id}/cancel`, { reason: rejectReason })).data;
      }
      return (await api.patch(`/procurement/purchase-orders/${id}/${action}`)).data;
    },
    onSuccess: () => {
      notify.success('PO updated');
      qc.invalidateQueries({ queryKey: ['purchase-order', id] });
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      setShowCancel(false);
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Action failed'),
  });

  if (po.isLoading) return <Skeleton className="h-96 w-full" />;
  if (po.error || !po.data) return <Card><CardContent className="p-8 text-center text-destructive">Purchase order not found</CardContent></Card>;

  const data = po.data;
  const totalReceived = data.lines.reduce((s, l) => s + Number(l.receivedQuantity), 0);
  const totalOrdered = data.lines.reduce((s, l) => s + Number(l.quantity), 0);
  const receiptCount = data.receipts?.length ?? 0;
  const billCount = data.bills?.length ?? 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/procurement/purchase-orders')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{data.orderNumber}</h1>
              <Badge variant={STATUS_BADGE[data.status] ?? 'secondary'}>
                {STATUS_LABELS[data.status] ?? data.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">Created {date(data.orderDate)}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {data.status === 'draft' && (
            <>
              <Button size="sm" onClick={() => act.mutate('submit')}>
                <Send className="mr-1 h-3 w-3" />Submit
              </Button>
              <Button size="sm" variant="default" onClick={() => act.mutate('approve')}>
                <Check className="mr-1 h-3 w-3" />Approve
              </Button>
            </>
          )}
          {data.status === 'submitted' && (
            <>
              <Button size="sm" onClick={() => act.mutate('approve')}>
                <Check className="mr-1 h-3 w-3" />Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => act.mutate('cancel')}>
                <X className="mr-1 h-3 w-3" />Cancel
              </Button>
            </>
          )}
          {data.status === 'approved' && (
            <Button size="sm" onClick={() => act.mutate('send')}>
              <Send className="mr-1 h-3 w-3" />Send to Supplier
            </Button>
          )}
          {(data.status === 'sent' || data.status === 'partially_received') && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/procurement/goods-receipts/new?poId=${data.id}`)}>
              <Truck className="mr-1 h-3 w-3" />Receive Stock
            </Button>
          )}
          {!['cancelled', 'closed', 'billed'].includes(data.status) && (
            <Button size="sm" variant="ghost" onClick={() => setShowCancel(true)}>
              <X className="mr-1 h-3 w-3 text-destructive" />Cancel
            </Button>
          )}
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total Amount</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <p className="text-2xl font-bold text-amber-700">{formatMoney(data.totalAmount, data.currencyCode)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Items</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <p className="flex items-center gap-2 text-2xl font-bold text-sky-600">
              <Package className="h-5 w-5" />{totalOrdered}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Received</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <p className={`text-2xl font-bold ${totalReceived >= totalOrdered ? 'text-emerald-600' : 'text-amber-600'}`}>
              {totalReceived} / {totalOrdered}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Receipts / Bills</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <p className="text-2xl font-bold text-indigo-600">{receiptCount} / {billCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Main content */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* Left: lines table */}
        <div className="md:col-span-2 space-y-4">
          <Card>
            <CardHeader><CardTitle>Order Lines</CardTitle></CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">Item</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Received</th>
                    <th className="px-3 py-2 text-right">Unit Price</th>
                    <th className="px-3 py-2 text-right">Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((ln) => (
                    <tr key={ln.id} className="border-b hover:bg-muted/30">
                      <td className="px-3 py-2 text-muted-foreground">{ln.lineNumber}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{ln.description}</div>
                        {ln.notes && <div className="text-xs text-muted-foreground">{ln.notes}</div>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{Number(ln.quantity)}</td>
                      <td className="px-3 py-2 text-right font-mono">{Number(ln.receivedQuantity)}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatMoney(ln.unitPrice)}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatMoney(ln.subtotal)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t font-medium">
                    <td colSpan={4}></td>
                    <td className="px-3 py-2 text-right">Subtotal</td>
                    <td className="px-3 py-2 text-right font-mono">{formatMoney(data.subtotal)}</td>
                  </tr>
                  {Number(data.taxAmount) > 0 && (
                    <tr>
                      <td colSpan={4}></td>
                      <td className="px-3 py-2 text-right text-muted-foreground">Tax</td>
                      <td className="px-3 py-2 text-right font-mono">{formatMoney(data.taxAmount)}</td>
                    </tr>
                  )}
                  <tr className="border-t font-bold">
                    <td colSpan={4}></td>
                    <td className="px-3 py-2 text-right">Total</td>
                    <td className="px-3 py-2 text-right font-mono">{formatMoney(data.totalAmount, data.currencyCode)}</td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>

          {data.notes && (
            <Card>
              <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
              <CardContent><p className="text-sm text-muted-foreground whitespace-pre-wrap">{data.notes}</p></CardContent>
            </Card>
          )}
        </div>

        {/* Right: details */}
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge variant={STATUS_BADGE[data.status] ?? 'secondary'}>{STATUS_LABELS[data.status] ?? data.status}</Badge>
              </div>
              {data.description && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Description</span>
                  <span>{data.description}</span>
                </div>
              )}
              {data.expectedDeliveryDate && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Expected Delivery</span>
                  <span>{date(data.expectedDeliveryDate)}</span>
                </div>
              )}
              {data.terms && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Terms</span>
                  <span>{data.terms}</span>
                </div>
              )}
              {data.approvedAt && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Approved</span>
                  <span>{dateTime(data.approvedAt)}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {data.receipts && data.receipts.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Receipts</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {data.receipts.map((r: any) => (
                  <div key={r.id} className="flex justify-between items-center">
                    <span className="font-mono text-xs">{r.receiptNumber}</span>
                    <Badge variant="outline" className="text-xs">{r.status}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {data.request && (
            <Card>
              <CardHeader><CardTitle>Source</CardTitle></CardHeader>
              <CardContent>
                <div className="text-sm">
                  <span className="text-muted-foreground">Purchase Request: </span>
                  <span className="font-mono">{data.request.requestNumber}</span>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Cancel dialog */}
      <Dialog open={showCancel} onOpenChange={setShowCancel}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancel Purchase Order</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Are you sure you want to cancel {data.orderNumber}?</p>
            <Textarea
              placeholder="Reason for cancellation"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCancel(false)}>Keep</Button>
            <Button variant="destructive" onClick={() => act.mutate('cancel')} disabled={act.isPending}>
              Cancel PO
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
