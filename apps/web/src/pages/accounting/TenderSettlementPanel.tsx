import { submitCashOperation } from '@/features/pos/cash-operation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccounts } from '@/features/accounting/api';
import { api } from '@/lib/api';
import { toast } from 'sonner';

export function TenderSettlementPanel() {
  const { data } = useAccounts();
  const accounts = data?.data?.filter((a) => a.isActive && !a.isGroup) ?? [];
  const [source, setSource] = useState(''), [destination, setDestination] = useState('');
  const [gross, setGross] = useState(''), [fee, setFee] = useState('0'), [feeAccount, setFeeAccount] = useState('');
  const [reference, setReference] = useState(''), [sessionId, setSessionId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const qc = useQueryClient();
  const { data: sessions } = useQuery({ queryKey: ['settlement-sessions'], queryFn: async () => (await api.get('/cash-sessions/history', { params: { perPage: 100 } })).data });
  const save = useMutation({ mutationFn: async () => submitCashOperation('/cash-sessions/tender-settlements', {
    sourceAccountId: source, destinationAccountId: destination, grossAmount: Number(gross), feeAmount: Number(fee), feeAccountId: Number(fee) ? feeAccount : undefined,
    reference, cashSessionId: sessionId || undefined, settledAt: new Date(`${date}T12:00:00`).toISOString(),
  }),
  onSuccess: () => { toast.success('Provider settlement posted'); setGross(''); setReference(''); qc.invalidateQueries({ queryKey: ['cash-accounts'] }); qc.invalidateQueries({ queryKey: ['session-reconciliation'] }); },
  onError: (e: any) => toast.error(e?.response?.data?.message ?? 'Settlement failed; keep this reference and resolve the original attempt'), });
  const select = (label: string, value: string, onChange: (v: string) => void, filter: (a: typeof accounts[number]) => boolean) => <label className="text-sm">{label}<select aria-label={label} className="block w-full border rounded p-2" value={value} onChange={(e) => onChange(e.target.value)}><option value="">Choose account</option>{accounts.filter(filter).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></label>;
  return <details className="rounded border bg-white p-4">
    <summary className="cursor-pointer font-semibold">Reconcile card and mobile-money settlement</summary>
    <p className="text-sm text-slate-500 my-3">Move the provider’s gross collection into the bank, recording fees separately. Use the actual settlement date and provider reference. Physical drawer cash is unaffected.</p>
    <div className="grid sm:grid-cols-2 gap-3">
      {select('Provider or clearing account', source, setSource, (a) => ['bank', 'mobile_money', 'current_asset'].includes(a.category?.key ?? ''))}
      {select('Destination bank', destination, setDestination, (a) => a.category?.key === 'bank')}
      <label className="text-sm">Gross settlement<input aria-label="Gross settlement" className="block w-full border rounded p-2" type="number" min="0" value={gross} onChange={(e) => setGross(e.target.value)} /></label>
      <label className="text-sm">Provider fee<input aria-label="Provider fee" className="block w-full border rounded p-2" type="number" min="0" value={fee} onChange={(e) => setFee(e.target.value)} /></label>
      {Number(fee) > 0 && select('Fee expense account', feeAccount, setFeeAccount, (a) => a.category?.classification === 'expense')}
      <label className="text-sm">Provider reference<input aria-label="Provider reference" className="block w-full border rounded p-2" value={reference} onChange={(e) => setReference(e.target.value)} /></label>
      <label className="text-sm">Settlement date<input aria-label="Settlement date" className="block w-full border rounded p-2" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <label className="text-sm">Register session<select aria-label="Settlement register session" className="block w-full border rounded p-2" value={sessionId} onChange={(e) => setSessionId(e.target.value)}><option value="">Multiple sessions / account transfer</option>{(sessions?.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.cashRegister?.name} · {new Date(s.openedAt).toLocaleString()}</option>)}</select></label>
    </div>
    <p className="text-sm my-3">Net bank receipt: {(Number(gross || 0) - Number(fee || 0)).toLocaleString()}</p>
    <button className="rounded bg-indigo-600 text-white px-4 py-2 disabled:opacity-50" disabled={save.isPending || !source || !destination || !reference || !(Number(gross) > 0)} onClick={() => save.mutate()}>{save.isPending ? 'Posting…' : 'Post settlement'}</button>
  </details>;
}
