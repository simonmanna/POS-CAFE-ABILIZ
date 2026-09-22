/**
 * POS cashier token holder.
 *
 * Minted by `pinLogin` and sent on the `X-Pos-User` header (see lib/api.ts) so
 * the backend attributes POS writes to the cashier who PINned in — not the
 * back-office user whose JWT opened the terminal.
 *
 * Kept in its own tiny module (no React, no `api` import) so the axios request
 * interceptor can read it without a circular dependency on the auth store.
 * Persisted to sessionStorage so a page refresh keeps the cashier signed in.
 */
const STORAGE_KEY = 'pos-token';

let posToken: string | null = (() => {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null;
  } catch {
    return null;
  }
})();

export function getPosToken(): string | null {
  return posToken;
}

/**
 * Called when the server refuses the cashier token because the cashier was
 * disabled or taken off the tills (401 + `X-Pos-Session: revoked`). The POS
 * auth store registers here, which keeps this module free of imports.
 */
let revokedHandler: (() => void) | null = null;

export function onPosSessionRevoked(handler: () => void): void {
  revokedHandler = handler;
}

export function posSessionRevoked(): void {
  setPosToken(null);
  revokedHandler?.();
}

export function setPosToken(token: string | null): void {
  posToken = token;
  try {
    if (token) sessionStorage.setItem(STORAGE_KEY, token);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* sessionStorage unavailable (private mode / SSR) — in-memory is enough */
  }
}
