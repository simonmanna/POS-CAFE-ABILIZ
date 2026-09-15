import { Link } from 'react-router-dom';
import { shiftTrackedAccounts, usePosPaymentMethods } from '@/features/pos/payment-accounts';

/**
 * Wallet / bank / card-clearing balances observed at shift open or close.
 *
 * Rows come from the configured POS payment methods, deduped by account — two
 * tiles pointed at one wallet are counted once — so the cashier only ever sees
 * accounts this till actually collects into. Physical drawer cash is counted
 * separately and never appears here.
 */
export function FinancialAccountCounts({ value, onChange, stage }: { value: Record<string, number>; onChange: (value: Record<string, number>) => void; stage: 'opening' | 'closing' }) {
  const { data: methods = [] } = usePosPaymentMethods();
  const accounts = shiftTrackedAccounts(methods);
  return <fieldset className="space-y-2 rounded border p-3">
    <legend className="text-sm font-semibold">{stage === 'opening' ? 'Opening' : 'Closing'} bank and wallet balances</legend>
    <p className="text-xs text-slate-500">Record the balances shown by each provider. These are separate from physical cash. Leave accounts you did not check blank.</p>
    <div className="max-h-44 overflow-y-auto space-y-2">
      {accounts.map((a) => <label key={a.accountId} className="flex items-center justify-between gap-2 text-xs">
        <span>
          <span className="font-semibold">{a.label}</span>
          <span className="text-slate-500"> · {a.accountName}{a.accountCode ? ` · ${a.accountCode}` : ''}</span>
        </span>
        <input aria-label={`${stage} balance ${a.label}`} type="number" min="0" step="any" className="w-32 border rounded p-1.5 text-right" value={value[a.accountId] ?? ''} onChange={(e) => { const next = { ...value }; if (e.target.value === '') delete next[a.accountId]; else next[a.accountId] = Number(e.target.value); onChange(next); }} />
      </label>)}
      {!accounts.length && <p className="text-xs">
        No wallet or bank accounts are bound to a POS payment method yet.{' '}
        <Link to="/settings/payment-methods" className="font-semibold text-sky-700 underline">Connect them in Settings → Payment methods.</Link>
      </p>}
    </div>
  </fieldset>;
}
