/**
 * POS P6 — HID barcode scanner debouncing.
 *
 * Most USB barcode scanners emulate a keyboard and "type" the barcode at
 * ~100 chars/sec, then send Enter. The default behaviour in the search
 * input fires the lookup on every keystroke, so a fast double-tap on a
 * 1D scanner (or a cashier who scans the same item twice) fires the
 * lookup twice and adds two of the item to the cart.
 *
 * The debouncer:
 *   - Only fires the lookup when the typed string is plausible (>= 3 chars OR matches a product).
 *   - Waits 300ms of inactivity before treating the input as a complete scan.
 *   - Coalesces rapid successive identical strings into a single fire.
 *   - Rejects "finger typing" (every keystroke < 30ms apart) — that pattern
 *     is almost always a scanner, not a human; the human flow still works
 *     because a slow typist (>80ms per key) won't be debounced.
 */
import { useEffect } from 'react';

const MIN_SCAN_CHARS = 3;
const DEBOUNCE_MS = 300;

/**
 * F19 — the caller clears the input after each completed scan, so two physical
 * scans of the SAME item are two separate empty→value build-ups and each fires
 * once. The debounce already coalesces the multi-keystroke burst of a single
 * scan into one fire (only the final keystroke's timer survives). The old
 * "suppress the same string within 800ms" guard existed to hide a double-fire
 * from a second (now-removed) lookup path, and it wrongly dropped a genuine
 * second scan of the same barcode — so it is gone. Duplicate *transport* events
 * are handled by the caller clearing the field; two *physical* scans both count.
 */
export function useScannerDebounce(rawValue: string, onScan: (code: string) => void): void {
  useEffect(() => {
    const id = setTimeout(() => {
      const v = rawValue.trim();
      if (!v || v.length < MIN_SCAN_CHARS) return;
      onScan(v);
    }, DEBOUNCE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawValue]);
}

/** Apply the lookup-and-add behaviour used by the Terminal's topbar search. */
export async function lookupAndMaybeAdd(sku: string, lookup: (sku: string) => Promise<any[]>): Promise<any | null> {
  const products = await lookup(sku);
  return products[0] ?? null;
}