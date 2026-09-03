import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function SessionReconciliation({ sessionId }: { sessionId?: string }) {
  const { data, error } = useQuery({ queryKey: ['session-reconciliation', sessionId], enabled: !!sessionId, queryFn: async () => (await api.get(`/cash-sessions/${sessionId}/reconciliation`)).data, refetchInterval: 15_000 });
  if (error) return <p className="text-sm text-red-700">Could not load reconciliation. Check the connection before closing.</p>;
  if (!data) return <p className="text-sm">Checking pending work…</p>;
  return <div className="rounded border p-3 space-y-2 text-sm">
    <p className="font-semibold">Close readiness</p>
    <p>{data.unsettledOrders} open orders · {data.pendingPayments} pending payments · {data.pendingPostings} pending stock postings</p>
    {(data.issues ?? []).map((issue: string) => <p key={issue} className="text-red-700">{issue}</p>)}
    <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-left"><th>Account</th><th>Received</th><th>Refunded</th><th>Net collection</th></tr></thead><tbody>{(data.accounts ?? []).map((a: any) => <tr key={a.accountId}><td>{a.name}</td><td>{Number(a.receipts).toLocaleString()}</td><td>{Number(a.refunds).toLocaleString()}</td><td>{Number(a.net).toLocaleString()}</td></tr>)}</tbody></table></div>
    <p className="text-xs text-slate-500">House-account credit stays in receivables. Bank and wallet settlement is reviewed separately under Financial Accounts.</p>
  </div>;
}
