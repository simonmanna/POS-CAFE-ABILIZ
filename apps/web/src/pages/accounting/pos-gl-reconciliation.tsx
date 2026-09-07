import { RefreshCw, CheckCircle2, AlertTriangle, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { usePosGlReconciliation } from '@/features/accounting/api';
import { money } from '@/lib/format';
import { format } from 'date-fns';

export function PosGlReconciliationPage() {
  const { data, isLoading, refetch, isRefetching } = usePosGlReconciliation();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="border-l-4 border-[#3b82f6] pl-4 space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">POS → GL Reconciliation</h1>
          <p className="text-sm text-gray-500">
            Independently re-derives sales from POS invoices and the GL ledger, and monitors the
            inventory/COGS posting lag.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.window && (
            <span className="text-xs text-muted-foreground">
              {format(new Date(data.window.from), 'MMM d')} – {format(new Date(data.window.to), 'MMM d, yyyy')}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isRefetching}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : !data ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <p className="font-medium">No reconciliation data available</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Revenue */}
          <Card className={data.variance.revenueBalanced ? 'border-emerald-200' : 'border-amber-200'}>
            <CardHeader
              className={`pb-2 pt-4 px-5 border-b rounded-t-lg ${
                data.variance.revenueBalanced ? 'bg-emerald-50/50' : 'bg-amber-50/50'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {data.variance.revenueBalanced ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-amber-500" />
                  )}
                  <CardTitle className="text-sm font-bold uppercase tracking-wider">Revenue</CardTitle>
                </div>
                <Badge variant={data.variance.revenueBalanced ? 'secondary' : 'destructive'} className="text-[10px]">
                  {data.variance.revenueBalanced ? 'Balanced' : `Variance ${money(data.variance.revenue)}`}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-5 space-y-2 text-sm">
              <Row label="POS gross subtotal" value={money(data.pos.grossSubtotal)} />
              <Row label="POS discounts" value={`− ${money(data.pos.discounts)}`} />
              <Row label="Refunded revenue" value={`− ${money(data.pos.refundedRevenue)}`} />
              {data.pos.refundCount > 0 && (
                <Row label="Refund events" value={`${data.pos.refundCount} · ${money(data.pos.refundedTotal)} (rev ${money(data.pos.refundedRevenue)} + tax ${money(data.pos.refundedTax)})`} />
              )}
              <Row label="POS expected net revenue" value={money(data.pos.expectedNetRevenue)} bold />
              <div className="border-t pt-2 space-y-2">
                <Row label="GL net revenue" value={money(data.gl.actualNetRevenue)} />
                <Row
                  label="Variance"
                  value={money(data.variance.revenue)}
                  className={data.variance.revenueBalanced ? 'text-emerald-600' : 'text-red-500'}
                  bold
                />
              </div>
              <p className="text-[10px] text-muted-foreground italic">
                {data.pos.invoiceCount} invoice(s) in window. Unexplained variance usually means a
                manual journal touched a revenue account.
              </p>
            </CardContent>
          </Card>

          {/* Tax */}
          <Card className={data.variance.taxBalanced ? 'border-emerald-200' : 'border-amber-200'}>
            <CardHeader
              className={`pb-2 pt-4 px-5 border-b rounded-t-lg ${
                data.variance.taxBalanced ? 'bg-emerald-50/50' : 'bg-amber-50/50'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {data.variance.taxBalanced ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-amber-500" />
                  )}
                  <CardTitle className="text-sm font-bold uppercase tracking-wider">Tax</CardTitle>
                </div>
                <Badge variant={data.variance.taxBalanced ? 'secondary' : 'destructive'} className="text-[10px]">
                  {data.variance.taxBalanced ? 'Balanced' : `Variance ${money(data.variance.tax)}`}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-5 space-y-2 text-sm">
              <Row label="POS tax charged" value={money(data.pos.tax)} />
              <Row label="Refunded tax" value={`− ${money(data.pos.refundedTax)}`} />
              <Row label="POS expected net tax" value={money(data.pos.expectedNetTax)} bold />
              <Row label="GL tax payable movement" value={money(data.gl.tax)} />
              <div className="border-t pt-2">
                <Row
                  label="Variance"
                  value={money(data.variance.tax)}
                  className={data.variance.taxBalanced ? 'text-emerald-600' : 'text-red-500'}
                  bold
                />
              </div>
              <p className="text-[10px] text-muted-foreground italic">
                Refund revenue and tax portions are derived from the recorded refund line fractions, not
                the invoice refund header — both sides move together.
              </p>
            </CardContent>
          </Card>

          {/* Inventory / COGS (C-08) */}
          <Card className={data.inventory.unpostedJobs > 0 ? 'border-amber-200' : 'border-emerald-200'}>
            <CardHeader
              className={`pb-2 pt-4 px-5 border-b rounded-t-lg ${
                data.inventory.unpostedJobs > 0 ? 'bg-amber-50/50' : 'bg-emerald-50/50'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Package className="h-5 w-5 text-muted-foreground" />
                  <CardTitle className="text-sm font-bold uppercase tracking-wider">
                    Inventory / COGS
                  </CardTitle>
                </div>
                <Badge
                  variant={data.inventory.unpostedJobs > 0 ? 'destructive' : 'secondary'}
                  className="text-[10px]"
                >
                  {data.inventory.unpostedJobs > 0
                    ? `${data.inventory.unpostedJobs} unposted`
                    : 'Queue clear'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-5 space-y-2 text-sm">
              <Row label="Stock issue value (POS)" value={money(data.inventory.stockCogsValue)} />
              <Row label="GL COGS posted" value={money(data.inventory.glCogs)} />
              <div className="border-t pt-2">
                <Row
                  label="COGS variance"
                  value={money(data.inventory.cogsVariance)}
                  className={data.inventory.cogsBalanced ? 'text-emerald-600' : 'text-amber-600'}
                  bold
                />
              </div>
              <div className="text-[10px] text-muted-foreground">
                Jobs:{' '}
                {Object.entries(data.inventory.jobCounts).length === 0
                  ? 'none in window'
                  : Object.entries(data.inventory.jobCounts)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(' · ')}
              </div>
              <p className="text-[10px] text-muted-foreground italic">{data.inventory.note}</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  className,
}: {
  label: string;
  value: string;
  bold?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex justify-between ${bold ? 'font-bold' : ''}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className={className}>{value}</span>
    </div>
  );
}
