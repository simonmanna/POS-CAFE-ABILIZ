import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { PERMISSIONS } from '@erp/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, } from '@/components/ui/table';
import { money, date } from '@/lib/format';
import { useAuthStore } from '@/stores/auth.store';
import {
  useCancelInvoice,
  useCreatePayment,
  useInvoice,
  usePostInvoice,
} from '@/features/invoicing/api';
import { Skeleton } from '@/components/ui/skeleton';

const selectClass =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

function SummaryRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between gap-8 ${bold ? 'font-bold text-sm' : ''}`}>
      <span className={bold ? '' : 'text-muted-foreground'}>{label}</span>
      <span className={bold ? '' : ''}>{value}</span>
    </div>
  );
}

export function InvoiceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: inv, isLoading } = useInvoice(id);
  const postInvoice = usePostInvoice();
  const cancelInvoice = useCancelInvoice();
  const createPayment = useCreatePayment();
  const has = useAuthStore((s) => s.hasPermission);

  const [payOpen, setPayOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');

  const receiptRows = (inv?.allocations ?? [])
    .filter(a => a.payment?.direction === 'inbound')
    .sort((a, b) =>
      new Date(b.payment!.paymentDate).getTime() -
      new Date(a.payment!.paymentDate).getTime()
    )
    .map(a => ({
      id: a.paymentId,
      paymentDate: a.payment!.paymentDate,
      paymentMethod: a.payment!.paymentMethod,
      reference: a.payment!.reference ?? null,
      amount: a.amount,
      paymentNumber: (a.payment! as any).paymentNumber,
    }));

  if (isLoading) {
    return (
      <div className="max-w-5xl mx-auto space-y-4 px-4">
        <div className="flex items-center gap-3">
          <div className="h-4 w-20 bg-sky-200 rounded" />
          <Skeleton className="h-6 w-64" />
        </div>
        <div className="rounded-lg border border-sky-100 bg-white shadow-sm">
          <div className="flex divide-x divide-sky-100">
            <div className="w-1/2 p-6 space-y-3">
              <div className="h-3 w-24 bg-sky-100 rounded" />
              <div className="h-4 w-48 bg-sky-200 rounded" />
              <div className="h-3 w-full bg-sky-50 rounded mt-4" />
              <div className="h-3 w-3/4 bg-sky-50 rounded" />
            </div>
            <div className="w-1/2 p-6 space-y-3">
              <div className="h-3 w-24 bg-sky-100 rounded" />
              <div className="h-4 w-32 bg-sky-200 rounded" />
              <div className="h-3 w-full bg-sky-50 rounded mt-2" />
              <div className="h-3 w-2/3 bg-sky-50 rounded" />
            </div>
          </div>
          <div className="border-t border-sky-100 p-0">
            <div className="p-4 space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex gap-4 items-center">
                  <Skeleton className="h-3 w-8 shrink-0 bg-sky-50" />
                  <Skeleton className="h-3 flex-1 bg-sky-50" />
                  <Skeleton className="h-3 w-16 bg-sky-50" />
                  <Skeleton className="h-3 w-20 bg-sky-50" />
                  <Skeleton className="h-3 w-16 bg-sky-50" />
                  <Skeleton className="h-3 w-20 bg-sky-50" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!inv) {
    return (
      <div className="max-w-5xl mx-auto space-y-4 px-4">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/invoices')} className="flex items-center text-sm text-sky-700 hover:text-sky-900 gap-1">
            <ArrowLeft className="h-4 w-4" /> Invoices
          </button>
        </div>
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
          <h1 className="text-xl font-semibold text-destructive">Not Found</h1>
          <p className="mt-2 text-sm text-muted-foreground">Invoice not found or you don't have permission to view it.</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate('/invoices')}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Back to Invoices
          </Button>
        </div>
      </div>
    );
  }

  const isDraft = inv.status === 'draft';
  const residual = Number(inv.amountResidual);
  const canPay = inv.status === 'posted' && residual > 0;
  const canModify = inv.status !== 'cancelled';

  const openPay = () => {
    setAmount(inv.amountResidual);
    setMethod('cash');
    setPayOpen(true);
  };

  const submitPayment = async (e: FormEvent) => {
    e.preventDefault();
    await createPayment.mutateAsync({
      partnerId: inv.partnerId,
      paymentDate: new Date().toISOString().slice(0, 10),
      amount: Number(amount),
      paymentMethod: method,
      allocations: [{ documentId: inv.id, amount: Number(amount) }],
    });
    setPayOpen(false);
  };

  const printRef = (e: React.MouseEvent) => {
    e.preventDefault();
    window.print();
  };

  return (
    <div className="max-w-[1600px] mx-auto space-y-0 px-1 md:px-2">
      {/* Top bar */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => navigate('/invoices')}
          className="flex items-center gap-1 text-sm text-sky-700 hover:text-sky-900"
        >
          <ArrowLeft className="h-4 w-4" /> Invoices
        </button>
        <span className="text-sky-300">/</span>
        <span className="font-mono text-sm text-sky-900 font-semibold">{inv.documentNumber}</span>
      </div>

      {/* Title bar — light sky blue */}
      <div className="rounded-t-lg bg-gradient-to-r from-sky-400 to-sky-500 px-6 py-3 flex items-center justify-between shadow-sm">
        <h1 className="text-white font-bold text-base tracking-wide">INVOICE</h1>
        <div className="flex gap-2">
          <button
            onClick={printRef}
            className="flex items-center gap-1.5 text-sky-50 hover:bg-white/20 rounded px-3 py-1.5 text-sm transition-colors"
          >
            <Printer className="h-4 w-4" /> Print
          </button>
          {isDraft && has(PERMISSIONS.invoice.post) && (
            <Button
              size="sm"
              className="bg-white text-sky-700 hover:bg-sky-50 font-semibold shadow-sm"
              onClick={() => postInvoice.mutate(inv.id)}
              disabled={postInvoice.isPending}
            >
              {postInvoice.isPending ? 'Posting...' : 'Post'}
            </Button>
          )}
          {canPay && has(PERMISSIONS.payment.create) && (
            <Button size="sm" className="bg-sky-700 hover:bg-sky-800 text-white shadow-sm" onClick={openPay}>
              Register Payment
            </Button>
          )}
          {canModify && has(PERMISSIONS.invoice.cancel) && (
            <Button
              size="sm"
              variant="outline"
              className="border-white/60 text-sky-800 hover:bg-white/30 bg-white/60"
              onClick={() => cancelInvoice.mutate(inv.id)}
              disabled={cancelInvoice.isPending}
            >
              {cancelInvoice.isPending ? 'Voiding...' : 'Void'}
            </Button>
          )}
        </div>
      </div>

      {/* Invoice Document Card */}
      <div className="bg-white border border-t-0 border-sky-100 shadow-sm rounded-b-lg overflow-hidden">
        {/* Invoice header: Customer info left, document info right */}
        <div className="grid grid-cols-1 md:grid-cols-2 divide-x divide-sky-100">
          {/* Invoice To */}
          <div className="p-4 bg-sky-50/30">
            <p className="text-xs text-sky-500 font-bold uppercase tracking-wider mb-1">Invoice To</p>
            <p className="font-bold text-base text-sky-900">{inv.partner?.name ?? '—'}</p>
            <p className="text-xs text-sky-400 mt-1">Customer</p>
          </div>

          {/* Invoice info table */}
          <div className="p-4 bg-sky-50/20">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-sky-100">
                <tr>
                  <th className="text-left text-sky-600 font-medium py-2 w-28 align-top">Invoice No</th>
                  <td className="text-right font-bold text-sky-900 py-2">{inv.documentNumber}</td>
                </tr>
                <tr>
                  <th className="text-left text-sky-600 font-medium py-2 align-top">Invoice Date</th>
                  <td className="text-right text-sky-800 py-2">{date(inv.issueDate)}</td>
                </tr>
                <tr>
                  <th className="text-left text-sky-600 font-medium py-2 align-top">SO #</th>
                  <td className="text-right text-sky-800 py-2">{inv.reference ?? '-'}</td>
                </tr>
                <tr>
                  <th className="text-left text-sky-600 font-medium py-2 align-top">Order Date</th>
                  <td className="text-right text-sky-800 py-2">{date(inv.issueDate)}</td>
                </tr>
                <tr>
                  <th className="text-left text-sky-600 font-medium py-2 align-top">Due Date</th>
                  <td className="text-right text-sky-800 py-2 font-semibold">{inv.dueDate ? date(inv.dueDate) : '-'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Line items */}
        <div className="border-t border-sky-100">
          <Table>
            <TableHeader>
              <TableRow className="bg-sky-50 hover:bg-sky-50">
                <TableHead className="w-16 text-sky-700 font-bold text-xs uppercase tracking-wider">Sr.</TableHead>
                <TableHead className="text-sky-700 font-bold text-xs uppercase tracking-wider">Description</TableHead>
                <TableHead className="w-28 text-right text-sky-700 font-bold text-xs uppercase tracking-wider">Quantity</TableHead>
                <TableHead className="w-36 text-right text-sky-700 font-bold text-xs uppercase tracking-wider">Unit Price</TableHead>
                <TableHead className="w-28 text-right text-sky-700 font-bold text-xs uppercase tracking-wider">Taxes</TableHead>
                <TableHead className="w-32 text-right text-sky-700 font-bold text-xs uppercase tracking-wider">Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inv.lines.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sky-400">
                    No line items found.
                  </TableCell>
                </TableRow>
              ) : inv.lines.map((l, index) => (
                <TableRow key={l.id} className="hover:bg-sky-50/40">
                  <TableCell className="text-sky-600 text-sm font-mono">{index + 1}</TableCell>
                  <TableCell className="font-semibold text-sm text-sky-900">{l.description}</TableCell>
                  <TableCell className="text-right text-sm text-sky-800">{money(l.quantity)}</TableCell>
                  <TableCell className="text-right text-sm text-sky-800">{money(l.unitPrice)}</TableCell>
                  <TableCell className="text-right text-sm text-sky-700">{l.taxAmount && Number(l.taxAmount) > 0 ? money(l.taxAmount) : '-'}</TableCell>
                  <TableCell className="text-right text-sm font-bold text-sky-900">{money(l.total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Totals */}
        <div className="border-t border-sky-100 bg-gradient-to-r from-sky-50/60 to-sky-100/40">
          <div className="flex justify-end">
            <div className="w-80 space-y-2 pt-3 pb-3 pr-4">
              <SummaryRow label="SubTotal" value={money(inv.subtotal)} />
              <SummaryRow label="Taxes" value={inv.taxAmount && Number(inv.taxAmount) > 0 ? money(inv.taxAmount) : '0.00'} />
              <div className="border-t-2 border-sky-200 pt-2">
                <SummaryRow label="TOTAL" value={money(inv.totalAmount)} bold />
              </div>
              <SummaryRow label="Total Paid" value={money(inv.amountPaid)} />
              <SummaryRow label="Balance Due" value={money(inv.amountResidual)} />
            </div>
          </div>
        </div>

        {/* Receipts / Payment History */}
        <div className="border-t border-sky-100">
          <div className="px-4 py-2 bg-sky-50/50 border-b border-sky-100 flex items-center justify-between">
            <h3 className="text-xs font-bold text-sky-700 uppercase tracking-widest">Receipts</h3>
            <span className="text-xs text-sky-400">{receiptRows.length} receipt(s)</span>
          </div>
          {receiptRows.length === 0 ? (
          <div className="px-4 py-4 text-sm text-sky-400">No receipts recorded for this invoice.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-sky-50/60 hover:bg-sky-50/60">
                <TableHead className="w-16 text-sky-700 font-bold text-xs uppercase tracking-wider">Sr.</TableHead>
                <TableHead className="text-sky-700 font-bold text-xs uppercase tracking-wider">Date</TableHead>
                <TableHead className="text-sky-700 font-bold text-xs uppercase tracking-wider">Method</TableHead>
                <TableHead className="text-sky-700 font-bold text-xs uppercase tracking-wider">Ref.</TableHead>
                <TableHead className="w-36 text-right text-sky-700 font-bold text-xs uppercase tracking-wider">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receiptRows.map((p, i) => (
                <TableRow key={p.id} className="hover:bg-sky-50/40">
                  <TableCell className="text-sky-600 text-sm font-mono">{i + 1}</TableCell>
                  <TableCell className="text-sm text-sky-800">{date(p.paymentDate || '')}</TableCell>
                  <TableCell className="text-sm text-sky-800 capitalize">{p.paymentMethod?.replace(/_/g, ' ') ?? p.paymentMethod}</TableCell>
                  <TableCell className="font-mono text-xs text-sky-700">{p.paymentNumber ?? p.reference ?? '-'}</TableCell>
                  <TableCell className="text-right text-sm font-bold text-sky-900">{money(p.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      </div>
      {/* / Invoice Document Card */}
      {/* Payment Dialog */}
      {canModify && (
        <Dialog open={payOpen} onOpenChange={setPayOpen}>
          <DialogContent className="border-sky-100">
            <DialogHeader className="border-b border-sky-100 pb-3">
              <DialogTitle className="text-sky-900">Register Payment</DialogTitle>
              <DialogDescription className="text-sky-600">Record a payment against {inv.documentNumber}.</DialogDescription>
            </DialogHeader>
            <form onSubmit={submitPayment} className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label htmlFor="amount" className="text-sky-800">Amount</Label>
                <Input
                  id="amount"
                  type="number"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                  className="border-sky-200 focus-visible:ring-sky-400"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="method" className="text-sky-800">Method</Label>
                <select id="method" className={selectClass + ' border-sky-200'} value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="cash">Cash</option>
                  <option value="bank">Bank</option>
                  <option value="mobile_money">Mobile Money</option>
                  <option value="card">Card</option>
                </select>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createPayment.isPending} className="bg-sky-600 hover:bg-sky-700 text-white">
                  {createPayment.isPending ? 'Saving...' : 'Save Payment'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
