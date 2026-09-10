import { useQuery } from '@tanstack/react-query';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatMoney, dateTime } from '@/lib/format';
import { referenceLabel, sourceRoute, type LedgerSourceRef } from '@/lib/ledger-links';

interface LedgerLine {
  id: string;
  ledgerCode: string;
  productId: string;
  type: string;
  qtyBefore: number;
  quantityChange: number;
  balanceAfter: number;
  unitCost: number;
  totalValue: number;
  referenceType: string | null;
  referenceId: string | null;
  notes: string | null;
  performedBy: string | null;
  createdAt: string;
  product: { id: string; code: string; name: string; uom?: { code: string } | null };
  variant: { id: string; name: string } | null;
  location: { id: string; code: string; name: string };
  batch: { id: string; batchNumber: string; expiryDate: string | null } | null;
}

interface LedgerDetail {
  entry: LedgerLine;
  lines: LedgerLine[];
  totals: { lines: number; quantityIn: number; quantityOut: number; totalValue: number };
  source: LedgerSourceRef | null;
}

/** Kinds that own a real detail page — we send the user straight there. */
const REDIRECT_KINDS = new Set([
  'pos_invoice',
  'invoice',
  'credit_note',
  'goods_receipt',
  'purchase_order',
  'production_order',
  'rental_agreement',
  'repair_order',
]);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

/**
 * Drill-down target for a stock-ledger row. When the movement came from a
 * document that has its own page (a POS sale, a goods receipt, a production
 * order…) we redirect there. Otherwise — direct stock in/out, adjustments and
 * other code-only references — this page *is* the transaction detail: it shows
 * every ledger line posted under the same reference.
 */
export function StockMovementDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const detail = useQuery<LedgerDetail>({
    queryKey: ['inventory-ledger-entry', id],
    queryFn: async () => (await api.get<LedgerDetail>(`/inventory/ledger/${id}`)).data,
    enabled: Boolean(id),
  });

  if (detail.isLoading) return <Skeleton className="h-64 w-full" />;

  if (detail.isError || !detail.data) {
    return (
      <Card className="p-8 text-center text-muted-foreground">
        Movement not found.
        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={() => navigate('/inventory/ledger')}>
            Back to Stock Ledger
          </Button>
        </div>
      </Card>
    );
  }

  const { entry, lines, totals, source } = detail.data;
  const route = sourceRoute(source);
  if (source && route && REDIRECT_KINDS.has(source.kind)) {
    return <Navigate to={route} replace />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/inventory/ledger')}>
            <ArrowLeft className="mr-2 h-4 w-4" />Stock Ledger
          </Button>
          <h1 className="text-2xl font-semibold">
            {source?.label ?? referenceLabel(entry.referenceType)}
          </h1>
        </div>
        {route && (
          <Button variant="outline" size="sm" onClick={() => navigate(route)}>
            <ExternalLink className="mr-2 h-3 w-3" />Open source document
          </Button>
        )}
      </div>

      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Transaction">{referenceLabel(entry.referenceType)}</Field>
        <Field label="Reference">
          <span className="font-mono text-xs">{source?.code ?? entry.referenceId ?? '—'}</span>
        </Field>
        <Field label="Date">{dateTime(entry.createdAt)}</Field>
        <Field label="Status">{source?.status ? <Badge variant="outline">{source.status}</Badge> : '—'}</Field>
        <Field label="Location">{entry.location.name} ({entry.location.code})</Field>
        <Field label="Partner">{source?.partnerName ?? '—'}</Field>
        <Field label="Performed by">{entry.performedBy ?? '—'}</Field>
        <Field label="Total value">{formatMoney(totals.totalValue)}</Field>
      </Card>

      <Card className="grid gap-4 p-4 sm:grid-cols-3">
        <Field label="Lines">{totals.lines}</Field>
        <Field label="Quantity in"><span className="text-emerald-600">+{totals.quantityIn}</span></Field>
        <Field label="Quantity out"><span className="text-destructive">-{totals.quantityOut}</span></Field>
      </Card>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Code</th>
              <th className="px-3 py-2 text-left font-medium">Product</th>
              <th className="px-3 py-2 text-left font-medium">Location</th>
              <th className="px-3 py-2 text-left font-medium">Batch</th>
              <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Qty Before</th>
              <th className="px-3 py-2 text-right font-medium">Change</th>
              <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Qty After</th>
              <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Unit Cost</th>
              <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Total Value</th>
              <th className="px-3 py-2 text-left font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr
                key={line.id}
                className={`border-b hover:bg-muted/30 ${line.id === entry.id ? 'bg-muted/40' : ''}`}
              >
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{line.ledgerCode}</td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    className="font-medium hover:text-primary hover:underline"
                    onClick={() => navigate(`/inventory/items/${line.productId}`)}
                  >
                    {line.product.name}
                  </button>
                  {line.variant && <span className="text-muted-foreground"> · {line.variant.name}</span>}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{line.location.code}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{line.batch?.batchNumber ?? '—'}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{line.qtyBefore}</td>
                <td
                  className={`px-3 py-2 text-right font-mono tabular-nums ${
                    line.quantityChange > 0 ? 'text-emerald-600' : line.quantityChange < 0 ? 'text-destructive' : ''
                  }`}
                >
                  {line.quantityChange > 0 ? '+' : ''}{line.quantityChange}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{line.balanceAfter}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{formatMoney(line.unitCost)}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{formatMoney(line.totalValue)}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{line.notes ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
