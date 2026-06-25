import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Truck, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';

interface GRN {
  id: string;
  receiptNumber: string;
  status: 'draft' | 'posted' | 'cancelled';
  receivedAt: string;
  postedAt: string | null;
  notes: string | null;
  order?: { orderNumber: string };
}

export function GoodsReceiptsPage() {
  const qc = useQueryClient();
  const list = useQuery<GRN[]>({
    queryKey: ['goods-receipts'],
    queryFn: async () => (await api.get<GRN[]>('/procurement/goods-receipts')).data,
  });
  const post = useMutation({
    mutationFn: async (id: string) => (await api.patch(`/procurement/goods-receipts/${id}/post`)).data,
    onSuccess: () => {
      notify.success('Posted');
      qc.invalidateQueries({ queryKey: ['goods-receipts'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Goods Receipts</h1>
          <p className="text-sm text-muted-foreground">Records of stock received against purchase orders</p>
        </div>
        <Button asChild>
          <Link to="/procurement/goods-receipts/new"><Truck className="mr-2 h-4 w-4" />New receipt</Link>
        </Button>
      </div>

      {list.isLoading && <Skeleton className="h-32 w-full" />}
      {list.data && list.data.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No goods receipts yet.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {list.data?.map((g) => (
          <Card key={g.id}>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base">{g.receiptNumber}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Received {new Date(g.receivedAt).toLocaleDateString()}
                    {g.order?.orderNumber && ` · ${g.order.orderNumber}`}
                  </p>
                </div>
                <Badge variant={g.status === 'posted' ? 'default' : g.status === 'cancelled' ? 'destructive' : 'secondary'}>
                  {g.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex items-center justify-between border-t pt-3">
              <p className="text-xs text-muted-foreground">{g.notes ?? '—'}</p>
              {g.status === 'draft' && (
                <Button size="sm" onClick={() => post.mutate(g.id)}>
                  <CheckCircle2 className="mr-1 h-3 w-3" />Post
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
