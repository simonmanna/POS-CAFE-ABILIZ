import { usePaymentAccounts } from '@/features/pos/payment-accounts';

export function FinancialAccountCounts({ value, onChange, stage }: { value: Record<string, number>; onChange: (value: Record<string, number>) => void; stage: 'opening' | 'closing' }) {
  const { data = [] } = usePaymentAccounts();
  const accounts = data.filter((a) => ['bank', 'mobile_money', 'current_asset'].includes(a.accountType));
  return <fieldset className="space-y-2 rounded border p-3">
    <legend className="text-sm font-semibold">{stage === 'opening' ? 'Opening' : 'Closing'} bank and wallet balances</legend>
    <p className="text-xs text-slate-500">Record the balances shown by each provider. These are separate from physical cash. Leave accounts you did not check blank.</p>
    <div className="max-h-44 overflow-y-auto space-y-2">
      {accounts.map((a) => <label key={a.id} className="flex items-center justify-between gap-2 text-xs">
        <span>{a.name} · {a.code}</span>
        <input aria-label={`${stage} balance ${a.name}`} type="number" min="0" step="any" className="w-32 border rounded p-1.5 text-right" value={value[a.id] ?? ''} onChange={(e) => { const next = { ...value }; if (e.target.value === '') delete next[a.id]; else next[a.id] = Number(e.target.value); onChange(next); }} />
      </label>)}
      {!accounts.length && <p className="text-xs">Create named bank or mobile-money accounts in Accounting → Cash Accounts.</p>}
    </div>
  </fieldset>;
}
