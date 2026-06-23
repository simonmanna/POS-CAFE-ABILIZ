import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Send, Check, X, Truck, ClipboardList, FileText } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { useAuthStore } from '@/stores/auth.store';
import { formatMoney } from '@/lib/format';
import { Link } from 'react-router-dom';

interface PurchaseOrder {
  id: string;
  orderNumber: string;
  partnerId: string;
  status: string;
  orderDate: string;
  expectedDeliveryDate: string | null;
  totalAmount: number | string;
  currencyCode: string;
  _count?: { receipts: number; bills: number };
  matchStatuses?: Array<{ status: string }>;
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  sent: 'Sent to supplier',
  acknowledged: 'Acknowledged',
  partially_received: 'Partially received',
  received: 'Received',
  billed: 'Billed',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export function PurchaseOrdersPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const org = useAuthStore((s) => s.organization);
  const [status, setStatus] = useState<string>('all');
  const list = useQuery<PurchaseOrder[]>({
    queryKey: ['purchase-orders', status],
    queryFn: async () => (await api.get<PurchaseOrder[]>(`/procurement/purchase-orders${status !== 'all' ? `?status=${status}` : ''}`)).data,
  });
  const act = useMutation({
    mutationFn: async (vars: { id: string; action: 'submit' | 'approve' | 'send' | 'cancel' }) => {
      if (vars.action === 'cancel') return (await api.patch(`/procurement/purchase-orders/${vars.id}/cancel`, { reason: '' })).data;
      return (await api.patch(`/procurement/purchase-orders/${vars.id}/${vars.action}`)).data;
    },
    onSuccess: () => {
      notify.success('Updated');
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });
  const recompute = useMutation({
    mutationFn: async (id: string) => (await api.post(`/procurement/purchase-orders/${id}/recompute-match`)).data,
    onSuccess: () => {
      notify.success('Three-way match recomputed');
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t('procurement.purchaseOrders.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('procurement.purchaseOrders.description')}</p>
        </div>
        <Button asChild>
          <Link to="/procurement/purchase-orders/new"><Plus className="mr-2 h-4 w-4" />New PO</Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {['all', 'draft', 'approved', 'sent', 'partially_received', 'received', 'cancelled'].map((s) => (
          <Button
            key={s}
            variant={status === s ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatus(s)}
          >
            {s === 'all' ? 'All' : STATUS_LABELS[s] ?? s}
          </Button>
        ))}
      </div>

      {list.isLoading && <Skeleton className="h-32 w-full" />}
      {list.data && list.data.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {t('procurement.purchaseOrders.noData')}{' '}
            <Link to="/procurement/purchase-orders/new" className="text-primary underline">Create one</Link>.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {list.data?.map((po) => {
          const blocked = (po.matchStatuses ?? []).filter((m) => m.status === 'blocked').length;
          return (
            <Card key={po.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base">{po.orderNumber}</CardTitle>
                    <CardDescription>
                      {new Date(po.orderDate).toLocaleDateString()}
                      {po.expectedDeliveryDate && ` · ETA ${new Date(po.expectedDeliveryDate).toLocaleDateString()}`}
                    </CardDescription>
                  </div>
                  <Badge variant={po.status === 'cancelled' ? 'destructive' : po.status === 'received' ? 'default' : 'secondary'}>
                    {STATUS_LABELS[po.status] ?? po.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-semibold">{formatMoney(po.totalAmount, po.currencyCode ?? org?.currencyCode)}</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{po._count?.receipts ?? 0} receipt(s)</span>
                  <span>{po._count?.bills ?? 0} bill(s)</span>
                  {blocked > 0 && (
                    <Badge variant="destructive">{blocked} match(es) blocked</Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-1 border-t pt-2">
                  {po.status === 'draft' && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => act.mutate({ id: po.id, action: 'submit' })}>
                        <FileText className="mr-1 h-3 w-3" />Submit
                      </Button>
                      <Button size="sm" onClick={() => act.mutate({ id: po.id, action: 'approve' })}>
                        <Check className="mr-1 h-3 w-3" />Approve
                      </Button>
                    </>
                  )}
                  {po.status === 'approved' && (
                    <Button size="sm" onClick={() => act.mutate({ id: po.id, action: 'send' })}>
                      <Send className="mr-1 h-3 w-3" />Send
                    </Button>
                  )}
                  {(po.status === 'sent' || po.status === 'partially_received') && (
                    <Button size="sm" variant="outline" asChild>
                      <Link to={`/procurement/goods-receipts/new?poId=${po.id}`}>
                        <Truck className="mr-1 h-3 w-3" />Receive
                      </Link>
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => recompute.mutate(po.id)}>
                    <ClipboardList className="mr-1 h-3 w-3" />Re-check match
                  </Button>
                  {!['cancelled', 'closed', 'billed'].includes(po.status) && (
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: po.id, action: 'cancel' })}>
                      <X className="mr-1 h-3 w-3 text-destructive" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
