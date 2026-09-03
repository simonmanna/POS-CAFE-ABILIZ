import { useEffect, useState } from 'react';
import { pendingCashOperations, recoverCashOperation } from '@/features/pos/cash-operation';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

export function PendingCashOperations() {
  const [rows, setRows] = useState<ReturnType<typeof pendingCashOperations>>([]);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  useEffect(() => { const refresh = () => setRows(pendingCashOperations()); refresh(); const timer = setInterval(refresh, 3000); return () => clearInterval(timer); }, []);
  if (!rows.length) return null;
  return <aside role="alert" className="fixed right-3 top-16 z-[110] max-w-sm rounded border border-amber-400 bg-amber-50 p-3 text-sm text-slate-900 shadow-lg">
    <strong>Financial operation awaiting confirmation</strong>
    {rows.map(row => <div className="mt-2" key={row.slot}>
      <p>{row.payload.reason ?? row.payload.reference ?? row.endpoint.split('/').pop()} · {row.payload.amount ?? row.payload.grossAmount ?? row.payload.closingCounted ?? row.payload.openingFloat ?? ''}</p>
      <button className="mt-1 rounded border px-2 py-1 disabled:opacity-50" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await recoverCashOperation(row.slot); toast.success('Original financial operation confirmed'); qc.invalidateQueries({ queryKey: ['cash-session'] }); qc.invalidateQueries({ queryKey: ['cash-accounts'] }); }
        catch (e: any) { toast.error(e?.response?.data?.message || e.message); }
        finally { setRows(pendingCashOperations()); setBusy(false); }
      }}>Check original result</button>
    </div>)}
  </aside>;
}
