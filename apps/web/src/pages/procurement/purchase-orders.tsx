import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Truck, CreditCard, X, Receipt } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { useAuthStore } from '@/stores/auth.store';
import { formatMoney } from '@/lib/format';
import { Link, useNavigate } from 'react-router-dom';

interface PurchaseOrder {
  id: string;
  orderNumber: string;
  partnerId: string;
  status: string;
  paymentType: string;
  paymentStatus: string | null;
  totalAmount: number | string;
  totalPaid: number | string;
  orderDate: string;
  currencyCode: string;
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  partially_received: 'Partially received',
  received: 'Received',
  cancelled: 'Cancelled',
};

const PAYMENT_TYPE_LABELS: Record<string, string> = {
  cash: 'Cash',
  credit: 'Credit',
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  not_paid: 'Unpaid',
  paid: 'Paid',
  partial: 'Partial',
};

export function PurchaseOrdersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const org = useAuthStore((s) => s.organization);
  const [status, setStatus] = useState<string>('all');

  const list = useQuery<PurchaseOrder[]>({
    queryKey: ['purchase-orders', status],
    queryFn: async () =>
      (
        await api.get<PurchaseOrder[]>(
          `/procurement/purchase-orders${status !== 'all' ? `?status=${status}` : ''}`,
        )
      ).data,
  });

  const cancelMut = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/procurement/purchase-orders/${id}/cancel`, { reason: '' })).data,
    onSuccess: () => {
      notify.success('Purchase order cancelled');
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t('procurement.purchaseOrders.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('procurement.purchaseOrders.description')}</p>
        </div>
        <Button asChild>
          <Link to="/procurement/purchase-orders/new">
            <Plus className="mr-2 h-4 w-4" />
            New Purchase
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {['all', 'active', 'partially_received', 'received', 'cancelled'].map((s) => (
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
            <Link to="/procurement/purchase-orders/new" className="text-primary underline">
              Create one
            </Link>
            .
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {list.data?.map((po) => (
          <Card
            key={po.id}
            className="cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => navigate(`/procurement/purchase-orders/${po.id}`)}
          >
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base">{po.orderNumber}</CardTitle>
                  <CardDescription>
                    {new Date(po.orderDate).toLocaleDateString()}
                    {' · '}
                    {PAYMENT_TYPE_LABELS[po.paymentType] ?? po.paymentType}
                  </CardDescription>
                </div>
                <Badge
                  variant={
                    po.status === 'cancelled'
                      ? 'destructive'
                      : po.status === 'received'
                        ? 'default'
                        : 'secondary'
                  }
                >
                  {STATUS_LABELS[po.status] ?? po.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total</span>
                <span className="font-semibold">
                  {formatMoney(po.totalAmount, po.currencyCode ?? org?.currencyCode)}
                </span>
              </div>

              {po.paymentType === 'credit' && (
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Payment</span>
                  <Badge variant="outline" className="text-xs">
                    {PAYMENT_STATUS_LABELS[po.paymentStatus ?? 'not_paid']}
                  </Badge>
                </div>
              )}

              <div className="flex flex-wrap gap-1 border-t pt-2">
                {/* Active PO -> Receive */}
                {(po.status === 'active' || po.status === 'partially_received') && (
                  <Button
                    size="sm"
                    variant="default"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/procurement/purchase-orders/${po.id}/receive`);
                    }}
                  >
                    <Truck className="mr-1 h-3 w-3" />
                    Receive
                  </Button>
                )}

                {/* Received credit PO still unpaid -> Pay */}
                {po.status === 'received' &&
                  po.paymentType === 'credit' &&
                  po.paymentStatus !== 'paid' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/procurement/purchase-orders/${po.id}/pay`);
                      }}
                    >
                      <CreditCard className="mr-1 h-3 w-3" />
                      Pay
                    </Button>
                  )}

                {/* Cash purchases are auto-settled on receive */}
                {po.status === 'received' && po.paymentType === 'cash' && (
                  <Badge variant="secondary" className="text-xs">
                    <Receipt className="mr-1 h-3 w-3" />
                    Paid
                  </Badge>
                )}

                {/* Cancel */}
                {!['received', 'cancelled'].includes(po.status) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm('Cancel this purchase order?')) cancelMut.mutate(po.id);
                    }}
                  >
                    <X className="mr-1 h-3 w-3 text-destructive" />
                    Cancel
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
