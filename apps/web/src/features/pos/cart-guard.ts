import { toast } from 'sonner';
import type { CartLine } from './types';

/**
 * A numpad-cleared line sits on the order at quantity 0 (see OrderPanel) — it is
 * a line the cashier still has to resolve, deliberately kept visible instead of
 * being deleted behind their back. Nothing that commits the order (KOT, bill,
 * split, payment, settle) may proceed while one exists, or the kitchen gets a
 * ticket for nothing and the bill prints a free item.
 *
 * The button states already say so; this is the guard for the keyboard
 * shortcuts (F2 / F8) and every other door into the same actions.
 *
 * @returns true when the cart is fit to commit; toasts and returns false otherwise.
 */
export function cartReadyToCommit(lines: CartLine[]): boolean {
  if (lines.length === 0) {
    toast.error('Cart is empty');
    return false;
  }
  const zero = lines.filter((l) => !(l.quantity > 0));
  if (zero.length) {
    toast.error(
      `Set a quantity for ${zero.map((l) => l.name).join(', ')} — or void the line — before continuing`,
    );
    return false;
  }
  return true;
}
