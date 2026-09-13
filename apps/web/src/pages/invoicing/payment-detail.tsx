import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-error';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { PERMISSIONS } from '@erp/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { money, date, statusLabel } from '@/lib/format';
import { useAuthStore } from '@/stores/auth.store';
import { usePayment, useVoidPayment } from '@/features/invoicing/api';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

export function PaymentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: payment, isLoading } = usePayment(id);
  const voidPayment = useVoidPayment();
  const has = useAuthStore((s) => s.hasPermission);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  // A cash payment from an already-closed shift is corrected in the caller's
  // own open shift on the same drawer; the closed shift is never modified.
  const { data: myOpenShift } = useQuery({
    queryKey: ['cash-session', 'open', 'mine'],
    queryFn: async () => (await api.get<{ id: string; cashRegister?: { name?: string } } | null>('/cash-sessions/open')).data ?? null,
    enabled: voidOpen,
  });

  const confirmVoid = async () => {
    if (!payment || !voidReason.trim()) { toast.error('Enter the reason for voiding this payment'); return; }
    try {
      await voidPayment.mutateAsync({ id: payment.id, reason: voidReason.trim(), correctionSessionId: myOpenShift?.id });
      toast.success('Payment voided');
      setVoidOpen(false);
      setVoidReason('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Void failed'));
    }
  };

  if (isLoading || !payment) {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }

  const isOutbound = payment.direction === 'outbound';
  const title = isOutbound ? 'Payment Voucher' : 'Payment Receipt';
  const partyLabel = isOutbound ? 'Paid to' : 'Received from';
  const amountLabel = isOutbound ? 'Amount paid' : 'Amount received';
  const backTo = isOutbound ? '/supplier-payments' : '/payments';

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <Button variant="outline" onClick={() => navigate(backTo)}>
          Back
        </Button>
        <div className="flex gap-2">
          {payment.status === 'posted' && has(PERMISSIONS.payment.void) && (
            <Button variant="outline" onClick={() => setVoidOpen(true)} disabled={voidPayment.isPending}>
              Void
            </Button>
          )}
          <Button variant="outline" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-6 pt-6">
          <div className="flex items-start justify-between border-b pb-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-semibold">{title}</h1>
                {payment.status === 'cancelled' && <Badge variant="destructive">voided</Badge>}
              </div>
              <p className="text-sm text-muted-foreground">{payment.paymentNumber}</p>
            </div>
            <div className="text-right text-sm text-muted-foreground">{date(payment.paymentDate)}</div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label={partyLabel} value={payment.partner?.name ?? '-'} />
            <Field label="Method" value={statusLabel(payment.paymentMethod)} />
            <Field label="Reference" value={payment.reference ?? '-'} />
            <Field label="Status" value={statusLabel(payment.status)} />
          </div>

          <div className="rounded-md bg-muted/50 p-4 text-center">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{amountLabel}</div>
            <div className="text-3xl font-semibold">{money(payment.amount)}</div>
          </div>

          {payment.allocations.length > 0 && (
            <div>
              <div className="mb-2 text-sm font-medium">Applied to</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead className="text-right">Amount applied</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payment.allocations.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>{a.document?.documentNumber ?? '-'}</TableCell>
                      <TableCell className="text-right">{money(a.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {Number(payment.unallocatedAmount) > 0 && (
            <p className="text-sm text-muted-foreground">
              Unapplied {isOutbound ? 'on account' : 'credit'}: {money(payment.unallocatedAmount)}
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={voidOpen} onOpenChange={(o) => { if (!voidPayment.isPending) setVoidOpen(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Void {payment.paymentNumber}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The payment and its journal are kept and reversed. Settled documents return to unpaid.
            </p>
            {payment.paymentMethod === 'cash' && (
              <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                {myOpenShift
                  ? `If the original shift is already closed, the cash correction is posted in your open shift${myOpenShift.cashRegister?.name ? ` on ${myOpenShift.cashRegister.name}` : ''}.`
                  : 'If the original shift is already closed, open a shift on the same register first; the correction is posted there.'}
              </p>
            )}
            <div className="space-y-1">
              <Label htmlFor="void-reason">Reason</Label>
              <Textarea id="void-reason" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Why is this payment being voided?" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoidOpen(false)} disabled={voidPayment.isPending}>Cancel</Button>
            <Button variant="destructive" onClick={confirmVoid} disabled={voidPayment.isPending || !voidReason.trim()}>Void payment</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
