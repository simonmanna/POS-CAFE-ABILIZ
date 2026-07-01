import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

interface GRN {
  id: string;
  receiptNumber: string;
  status: 'draft' | 'posted' | 'cancelled';
  receivedAt: string;
  notes: string | null;
  order?: { orderNumber: string };
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  posted: 'Posted',
  cancelled: 'Cancelled',
};

export function GoodsReceiptsPage() {
  const list = useQuery<GRN[]>({
    queryKey: ['goods-receipts'],
    queryFn: async () => (await api.get<GRN[]>('/procurement/goods-receipts')).data,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Goods Receipts</h1>
          <p className="text-sm text-muted-foreground">Stock received against purchase orders (auto-generated)</p>
        </div>
      </div>

      {list.isLoading && <Skeleton className="h-32 w-full" />}
      {list.data && list.data.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No goods receipts yet. They are auto-generated when you receive against a purchase order.
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
                <Badge
                  variant={
                    g.status === 'posted'
                      ? 'default'
                      : g.status === 'cancelled'
                        ? 'destructive'
                        : 'secondary'
                  }
                >
                  {STATUS_LABELS[g.status] ?? g.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="border-t pt-3 text-xs text-muted-foreground">
              {g.notes ?? '—'}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
