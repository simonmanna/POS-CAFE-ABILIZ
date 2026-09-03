import { useEffect, useState, type ReactNode } from 'react';
import { useCartStore } from '@/features/pos/cart.store';

/** A browser owns one active selling workspace. A second tab cannot overwrite
 * the same persisted draft or auto-save an older copy of an order. */
export function TerminalWorkspace({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!navigator.locks) {
      setError('Open the POS over HTTPS in a supported browser to protect saved carts.');
      return;
    }
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void navigator.locks.request('pos-selling-workspace', { signal: controller.signal }, async () => {
      if (controller.signal.aborted) return;
      const held = new Promise<void>((resolve) => { release = resolve; });
      await useCartStore.persist.rehydrate();
      if (!controller.signal.aborted) setReady(true);
      await held;
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => { controller.abort(); release?.(); };
  }, []);
  if (!ready) return <main className="mx-auto max-w-lg p-8 text-center" role="status">
    <h1 className="text-lg font-semibold">Protecting your selling workspace</h1>
    <p className="mt-3">{error || 'If another POS tab is open, finish there or close it. This tab will then restore your saved cart automatically.'}</p>
  </main>;
  return <>{children}</>;
}
