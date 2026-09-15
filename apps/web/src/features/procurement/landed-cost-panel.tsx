import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, CheckCircle2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { idempotentPost } from '@/lib/idempotent-request';
import { notify } from '@/lib/notify';
import { date, money } from '@/lib/format';
import { useAccounts } from '@/features/accounting/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface LandedCost {
  id: string;
  code: string;
  status: 'draft' | 'posted' | 'cancelled';
  allocationMethod: 'value' | 'quantity' | 'equal';
  date: string;
  totalAmount: string;
  capitalizedAmount: string;
  expensedAmount: string;
  notes: string | null;
  charges: Array<{ id: string; kind: string; description: string | null; amount: string }>;
}

const KINDS = ['freight', 'duty', 'insurance', 'handling', 'other'] as const;
type Charge = { kind: (typeof KINDS)[number]; description: string; amount: string };

/**
 * Freight, duty and insurance capitalised onto a posted goods receipt. The share
 * of the goods still on hand raises their cost; the share already sold or used
 * is expensed to COGS when the landed cost is posted.
 */
export function LandedCostPanel({ goodsReceiptId, canCreate, canPost, canCancel }: { goodsReceiptId: string; canCreate: boolean; canPost: boolean; canCancel: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<LandedCost['allocationMethod']>('value');
  const [creditAccountId, setCreditAccountId] = useState('');
  const [notes, setNotes] = useState('');
  const [charges, setCharges] = useState<Charge[]>([{ kind: 'freight', description: '', amount: '' }]);
  const accounts = useAccounts();

  const list = useQuery<LandedCost[]>({
    queryKey: ['landed-costs', goodsReceiptId],
    queryFn: async () => (await api.get<LandedCost[]>('/procurement/landed-costs', { params: { goodsReceiptId } })).data,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['landed-costs', goodsReceiptId] });
    qc.invalidateQueries({ queryKey: ['inventory-product-stock-levels'] });
  };

  const create = useMutation({
    mutationFn: async () =>
      idempotentPost<LandedCost>('/procurement/landed-costs', {
        goodsReceiptId,
        creditAccountId,
        allocationMethod: method,
        notes: notes.trim() || undefined,
        charges: charges.filter((c) => Number(c.amount) > 0).map((c) => ({ kind: c.kind, description: c.description.trim() || undefined, amount: Number(c.amount) })),
      }),
    onSuccess: (lc) => {
      notify.success(`${lc.code} saved as draft — post it to apply the cost`);
      setOpen(false);
      setCharges([{ kind: 'freight', description: '', amount: '' }]);
      setNotes('');
      refresh();
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Could not save landed cost'),
  });
  const post = useMutation({
    mutationFn: async (id: string) => await idempotentPost<LandedCost>(`/procurement/landed-costs/${id}/post`),
    onSuccess: (lc) => {
      notify.success(`${lc.code} posted — ${money(Number(lc.capitalizedAmount))} capitalised, ${money(Number(lc.expensedAmount))} to COGS`);
      refresh();
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Could not post landed cost'),
  });
  const cancel = useMutation({
    mutationFn: async (id: string) => await idempotentPost<LandedCost>(`/procurement/landed-costs/${id}/cancel`),
    onSuccess: () => { notify.success('Landed cost cancelled'); refresh(); },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Could not cancel landed cost'),
  });

  const total = charges.reduce((s, c) => s + (Number(c.amount) > 0 ? Number(c.amount) : 0), 0);
  const accountRows = ((accounts.data as any)?.data ?? []) as Array<{ id: string; code: string; name: string; isPostable?: boolean; isActive?: boolean }>;
  const rows = list.data ?? [];

  return (
    <section aria-labelledby="landed-cost-heading" className="mt-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="landed-cost-heading" className="text-sm font-semibold">Landed costs</h2>
          <p className="text-xs text-muted-foreground">Freight, duty and insurance added to the cost of these goods.</p>
        </div>
        {canCreate && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />Add landed cost
          </Button>
        )}
      </div>

      {rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-2">Code</th>
                <th scope="col" className="py-1 pr-2">Date</th>
                <th scope="col" className="py-1 pr-2">Charges</th>
                <th scope="col" className="py-1 pr-2 text-right">Total</th>
                <th scope="col" className="py-1 pr-2 text-right">Capitalised</th>
                <th scope="col" className="py-1 pr-2 text-right">To COGS</th>
                <th scope="col" className="py-1 pr-2">Status</th>
                <th scope="col" className="py-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((lc) => (
                <tr key={lc.id} className="border-b last:border-0">
                  <td className="py-1.5 pr-2 font-mono text-xs">{lc.code}</td>
                  <td className="py-1.5 pr-2">{date(lc.date)}</td>
                  <td className="py-1.5 pr-2 text-xs">{lc.charges.map((c) => c.kind).join(', ')} · by {lc.allocationMethod}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{money(Number(lc.totalAmount))}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{lc.status === 'posted' ? money(Number(lc.capitalizedAmount)) : '—'}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{lc.status === 'posted' ? money(Number(lc.expensedAmount)) : '—'}</td>
                  <td className="py-1.5 pr-2"><Badge variant={lc.status === 'posted' ? 'default' : lc.status === 'cancelled' ? 'destructive' : 'outline'}>{lc.status}</Badge></td>
                  <td className="py-1.5 text-right whitespace-nowrap">
                    {lc.status === 'draft' && canPost && (
                      <Button size="sm" variant="outline" disabled={post.isPending} onClick={() => post.mutate(lc.id)}>
                        <CheckCircle2 className="mr-1 h-3.5 w-3.5" />Post
                      </Button>
                    )}
                    {lc.status === 'draft' && canCancel && (
                      <Button size="sm" variant="ghost" aria-label={`Cancel ${lc.code}`} disabled={cancel.isPending} onClick={() => cancel.mutate(lc.id)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Add landed cost</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium" htmlFor="lc-method">Allocate by</label>
                <select id="lc-method" className="block h-9 w-full rounded-md border bg-background px-2 text-sm" value={method} onChange={(e) => setMethod(e.target.value as LandedCost['allocationMethod'])}>
                  <option value="value">Line value</option>
                  <option value="quantity">Quantity</option>
                  <option value="equal">Equally per line</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium" htmlFor="lc-account">Credit account <span className="text-destructive">*</span></label>
                <select id="lc-account" className="block h-9 w-full rounded-md border bg-background px-2 text-sm" value={creditAccountId} onChange={(e) => setCreditAccountId(e.target.value)}>
                  <option value="">Freight accrual, payable or bank…</option>
                  {accountRows.filter((a) => a.isPostable !== false && a.isActive !== false).map((a) => (
                    <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              {charges.map((c, idx) => {
                const set = (patch: Partial<Charge>) => setCharges((cur) => cur.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
                return (
                  <div key={idx} className="flex flex-wrap items-center gap-2">
                    <select aria-label="Charge type" className="h-9 rounded-md border bg-background px-2 text-sm" value={c.kind} onChange={(e) => set({ kind: e.target.value as Charge['kind'] })}>
                      {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                    <Input aria-label="Charge description" className="h-9 min-w-[140px] flex-1" placeholder="Description" value={c.description} onChange={(e) => set({ description: e.target.value })} />
                    <Input aria-label="Charge amount" type="number" min="0" step="any" inputMode="decimal" className="h-9 w-32 text-right" placeholder="Amount" value={c.amount} onChange={(e) => set({ amount: e.target.value })} />
                    <Button size="icon" variant="ghost" aria-label="Remove charge" disabled={charges.length === 1} onClick={() => setCharges((cur) => cur.filter((_, i) => i !== idx))}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                );
              })}
              <Button size="sm" variant="outline" onClick={() => setCharges((cur) => [...cur, { kind: 'duty', description: '', amount: '' }])}>
                <Plus className="mr-1 h-3 w-3" />Add charge
              </Button>
            </div>
            <Input aria-label="Notes" placeholder="Notes (carrier invoice, customs entry…)" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <p className="text-sm">Total <span className="font-semibold tabular-nums">{money(total)}</span></p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!creditAccountId || total <= 0 || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Saving…' : 'Save draft'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
