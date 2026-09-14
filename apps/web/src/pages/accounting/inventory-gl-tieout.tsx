import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ShieldCheck, ShieldAlert, AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useInventoryGlTieOut } from '@/features/accounting/api';
import { money } from '@/lib/format';

const SOURCE_LABELS: Record<string, string> = {
  goods_receipt: 'Goods receipts',
  goods_receipt_reversal: 'Goods receipt reversals',
  direct_stock_in: 'Direct stock in',
  direct_stock_out: 'Direct stock out',
  pos_invoice: 'POS sales',
  menu_recipe: 'POS recipe consumption',
  pos_invoice_combo: 'POS combo components',
  pos_refund: 'POS refunds',
  waste: 'Damages & waste',
  waste_reversal: 'Waste reversals',
  stock_out: 'Stock outs',
  stock_out_reversal: 'Stock-out reversals',
  stock_adjustment: 'Adjustments',
  stock_adjustment_reversal: 'Adjustment reversals',
  stock_adjust: 'Adjustments (legacy)',
  stock_transfer: 'Transfers',
  stock_transfer_reversal: 'Transfer reversals',
  vendor_bill: 'Vendor bills',
  debit_note: 'Supplier returns',
  opening_balance: 'Opening balances',
  opening_backfill: 'Opening balances (backfill)',
  inventory_gl_gap_backfill: 'GL catch-up entries',
  '(none)': 'Unreferenced',
};
const label = (s: string) => SOURCE_LABELS[s] ?? s.replace(/_/g, ' ');

export function InventoryGlTieOutPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const { data, isLoading, isError, error, refetch, isRefetching } = useInventoryGlTieOut(asOf === today ? undefined : asOf);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="border-l-4 border-[#3b82f6] pl-4 space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Inventory GL Tie-out</h1>
          <p className="text-sm text-gray-500">Stock sub-ledger value against the inventory control account, with every difference traced to its source.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching} className="gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-white p-3 shadow-sm">
        <div className="min-w-[150px] space-y-1">
          <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">As Of</Label>
          <Input type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value || today)} className="h-9 text-xs" />
        </div>
        <p className="text-xs text-muted-foreground">
          Today uses on-hand × running average. A past date rebuilds the value from the stock ledger.
        </p>
      </div>

      {isLoading && <Skeleton className="h-40 w-full" />}
      {isError && (
        <Card><CardContent className="p-6 text-sm text-destructive">{(error as any)?.response?.data?.message ?? 'Failed to load tie-out'}</CardContent></Card>
      )}

      {data && (
        <>
          {data.warning && (
            <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4" />{data.warning}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="p-3 pb-1"><CardTitle className="text-[10px] font-bold uppercase text-muted-foreground">Stock sub-ledger</CardTitle></CardHeader>
              <CardContent className="p-3 pt-0"><span className="text-2xl font-bold">{money(data.subledgerValue)}</span></CardContent>
            </Card>
            <Card>
              <CardHeader className="p-3 pb-1">
                <CardTitle className="text-[10px] font-bold uppercase text-muted-foreground">
                  GL {data.accounts.map((a) => a.code).join(', ') || 'inventory account'}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0"><span className="text-2xl font-bold">{money(data.glBalance)}</span></CardContent>
            </Card>
            <Card>
              <CardHeader className="p-3 pb-1"><CardTitle className="text-[10px] font-bold uppercase text-muted-foreground">Variance</CardTitle></CardHeader>
              <CardContent className="p-3 pt-0">
                <span className={`text-2xl font-bold ${data.withinTolerance ? 'text-emerald-600' : 'text-destructive'}`}>{money(data.variance)}</span>
              </CardContent>
            </Card>
            <Card className={data.withinTolerance && data.unpostedMovements.length === 0 ? 'border-emerald-300' : 'border-destructive/40'}>
              <CardContent className="flex h-full items-center gap-3 p-4">
                {data.withinTolerance && data.unpostedMovements.length === 0 ? (
                  <><ShieldCheck className="h-8 w-8 text-emerald-600" /><div><p className="font-semibold text-emerald-700">Ties out</p><p className="text-xs text-muted-foreground">Within ±{money(data.tolerance)}</p></div></>
                ) : (
                  <><ShieldAlert className="h-8 w-8 text-destructive" /><div><p className="font-semibold text-destructive">Needs attention</p><p className="text-xs text-muted-foreground">See the sources below</p></div></>
                )}
              </CardContent>
            </Card>
          </div>

          {data.unpostedMovements.length > 0 && (
            <Card className="border-destructive/40">
              <CardHeader className="border-b bg-destructive/5 px-5 pb-2 pt-4">
                <CardTitle className="text-xs font-bold uppercase tracking-wider text-destructive">Stock movements with no journal entry</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Stock value moved but nothing reached the GL. Post the catch-up with <code className="rounded bg-muted px-1">pnpm --filter @erp/api backfill:inventory-gl-gaps</code> (dry run first).
                  Opening balances are memo rows; post opening inventory through a manual journal against equity.
                </p>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[10px] uppercase">Source</TableHead>
                      <TableHead className="text-[10px] uppercase">Move type</TableHead>
                      <TableHead className="text-right text-[10px] uppercase">Rows</TableHead>
                      <TableHead className="pr-5 text-right text-[10px] uppercase">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.unpostedMovements.map((u) => (
                      <TableRow key={`${u.source}:${u.moveType}`}>
                        <TableCell className="text-xs font-medium">{label(u.source)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{u.moveType.replace(/_/g, ' ')}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{u.rows}</TableCell>
                        <TableCell className="pr-5 text-right text-xs font-semibold tabular-nums">{money(u.value)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="border-b bg-muted/30 px-5 pb-2 pt-4">
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Value by source</CardTitle>
              <p className="text-xs text-muted-foreground">
                Ledger value each source moved vs what it posted to the inventory account. Sources that post as one entry
                (e.g. a receipt voucher) or corrections without a stock row show a difference here by design.
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[10px] uppercase">Source</TableHead>
                    <TableHead className="text-right text-[10px] uppercase">Stock ledger</TableHead>
                    <TableHead className="text-right text-[10px] uppercase">GL</TableHead>
                    <TableHead className="pr-5 text-right text-[10px] uppercase">Difference</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.bySource.length === 0 ? (
                    <TableRow><TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">No inventory activity yet.</TableCell></TableRow>
                  ) : (
                    data.bySource.map((r) => (
                      <TableRow key={r.source}>
                        <TableCell className="text-xs font-medium">{label(r.source)}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{money(r.ledgerValue)}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{money(r.glValue)}</TableCell>
                        <TableCell className={`pr-5 text-right text-xs font-semibold tabular-nums ${Math.abs(r.difference) > data.tolerance ? 'text-destructive' : 'text-muted-foreground'}`}>
                          {money(r.difference)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Per-product value: <Link className="text-primary hover:underline" to="/inventory-valuation">Inventory Valuation</Link> ·
            POS COGS detail: <Link className="text-primary hover:underline" to="/pos-gl-reconciliation">POS → GL Recon</Link>
          </p>
        </>
      )}
    </div>
  );
}
