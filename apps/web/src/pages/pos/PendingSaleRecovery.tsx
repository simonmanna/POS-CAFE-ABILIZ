import { useEffect } from 'react';
import { useCartStore } from '@/features/pos/cart.store';
import { recoverSaleOperation } from '@/features/pos/offline-queue';
import { toast } from 'sonner';

/** Grace period before retrying: a normal settle is still in flight by then. */
const RETRY_AFTER_MS = 10_000;

/**
 * Silent recovery for a payment whose response never arrived. `operationPending`
 * is raised for every settle while its request is in flight, so no banner is
 * shown — if it is still pending after the grace period, the saved original
 * operation is replayed under its idempotency key (the server returns the
 * committed sale instead of charging twice) until it confirms.
 */
export function PendingSaleRecovery() {
  const pending = useCartStore((s) => s.operationPending);
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = async () => {
      const { operationPending, idempotencyKey } = useCartStore.getState();
      if (stopped || !operationPending) return;
      try {
        const result = await recoverSaleOperation(idempotencyKey);
        if (stopped) return;
        useCartStore.getState().clear();
        toast.success(`Confirmed ${result.invoiceNumber ?? result.invoiceId}. Receipt is available in Sales.`);
      } catch (e: any) {
        if (stopped) return;
        // Rejected before any sale committed: the cart is unlocked, say why once.
        if (e?.response?.data?.safeToRetry) { toast.error(e.response.data.message || e.message); return; }
        timer = setTimeout(attempt, RETRY_AFTER_MS);
      }
    };
    timer = setTimeout(attempt, RETRY_AFTER_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [pending]);
  return null;
}
