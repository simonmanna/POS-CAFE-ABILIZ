import { BarChart3, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useReport } from '@/features/manufacturing/api';
import { tx } from '@/lib/i18n/tx';

export function ManufacturingReportsPage() {
  const wip = useReport('wip-reconciliation');
  const kpis = useReport('kpis');
  const trends = useReport('trends');
  const usage = useReport('ingredient-usage');
  const capacity = useReport('capacity'); // served under work-centers; harmless if 404 → empty

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><BarChart3 className="h-6 w-6" /> {tx('Manufacturing Reports')}</h1>
        <p className="text-sm text-muted-foreground">{tx('Costing controls and production analytics.')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2">{tx('WIP Reconciliation')}
            {wip.data && (wip.data.balanced
              ? <Badge variant="default"><CheckCircle2 className="mr-1 h-3 w-3" /> {tx('Balanced')}</Badge>
              : <Badge variant="destructive"><AlertTriangle className="mr-1 h-3 w-3" /> {tx('Drift')}</Badge>)}
          </CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label={tx('GL WIP balance')} value={wip.data?.glBalance} />
            <Row label={tx('Open orders\' WIP')} value={wip.data?.openOrdersWip} />
            <Row label={tx('Drift')} value={wip.data?.drift} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{tx('KPIs')}</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label={tx('Completed orders')} value={kpis.data?.orders} />
            <Row label={tx('Yield %')} value={kpis.data?.yieldPct} />
            <Row label={tx('Waste %')} value={kpis.data?.wastePct} />
            <Row label={tx('Avg cost / batch')} value={kpis.data?.avgCostPerBatch} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>{tx('Production trends')}</CardTitle></CardHeader>
        <CardContent>
          {!trends.data?.length ? <p className="text-sm text-muted-foreground">{tx('No completed orders yet.')}</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>{tx('Date')}</TableHead><TableHead className="text-right">{tx('Orders')}</TableHead><TableHead className="text-right">{tx('Produced')}</TableHead><TableHead className="text-right">{tx('Cost')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {trends.data.map((t: any) => (
                  <TableRow key={t.date}>
                    <TableCell>{t.date}</TableCell>
                    <TableCell className="text-right">{t.orders}</TableCell>
                    <TableCell className="text-right">{Number(t.produced)}</TableCell>
                    <TableCell className="text-right">{Number(t.cost).toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{tx('Ingredient usage')}</CardTitle></CardHeader>
        <CardContent>
          {!usage.data?.length ? <p className="text-sm text-muted-foreground">{tx('Nothing consumed yet.')}</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>{tx('Ingredient')}</TableHead><TableHead className="text-right">{tx('Qty consumed')}</TableHead><TableHead className="text-right">{tx('Cost')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {usage.data.map((u: any) => (
                  <TableRow key={u.productId}>
                    <TableCell>{u.name}</TableCell>
                    <TableCell className="text-right">{Number(u.qtyConsumed)}</TableCell>
                    <TableCell className="text-right">{Number(u.cost).toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {!!capacity.data?.length && (
        <Card>
          <CardHeader><CardTitle>{tx('Work-centre capacity')}</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>{tx('Work centre')}</TableHead><TableHead className="text-right">{tx('Load (min)')}</TableHead><TableHead className="text-right">{tx('Capacity/day')}</TableHead><TableHead className="text-right">{tx('Utilisation')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {capacity.data.map((c: any) => (
                  <TableRow key={c.workCenterId}>
                    <TableCell>{c.name}</TableCell>
                    <TableCell className="text-right">{c.loadMins}</TableCell>
                    <TableCell className="text-right">{c.capacityMinsPerDay}</TableCell>
                    <TableCell className="text-right">{c.utilizationPct != null ? `${c.utilizationPct}%` : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number | undefined }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value ?? '—'}</span>
    </div>
  );
}

export default ManufacturingReportsPage;
