import { useState } from 'react';
import { useCartStore } from '@/features/pos/cart.store';
import { recoverSaleOperation } from '@/features/pos/offline-queue';
import { toast } from 'sonner';

export function PendingSaleRecovery() {
  const pending = useCartStore((s) => s.operationPending);
  const [busy, setBusy] = useState(false);
  if (!pending) return null;
  return <div role="alert" className="fixed bottom-3 left-3 right-3 z-[100] rounded border border-amber-400 bg-amber-50 p-4 text-sm text-slate-900 shadow-lg">
    Payment is awaiting confirmation. Your original cart and payment are saved.
    <button className="ml-3 rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const result = await recoverSaleOperation(useCartStore.getState().idempotencyKey);
        useCartStore.getState().clear();
        toast.success(`Confirmed ${result.invoiceNumber ?? result.invoiceId}. Receipt is available in Sales.`);
      } catch (e: any) { toast.error(e?.response?.data?.message || e?.message || 'Still pending. The original operation is preserved.'); }
      finally { setBusy(false); }
    }}>{busy ? 'Checking…' : 'Recover original payment'}</button>
  </div>;
}
