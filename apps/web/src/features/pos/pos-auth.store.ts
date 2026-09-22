/**
 * POS PIN authentication store — tracks which cashier is logged into the
 * terminal. Separate from the web auth store because a POS terminal may have
 * a different operator than the person who logged into the back office.
 *
 * Persisted to sessionStorage so a refresh preserves the POS session.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { api } from '@/lib/api';
import { onPosSessionRevoked, setPosToken } from './pos-session';

export interface PosAuthUser {
  userId: string;
  firstName: string;
  lastName: string | null;
  email: string;
  permissions: string[];
  /** Short-lived POS token sent on `X-Pos-User` for server-side attribution. */
  posToken?: string;
}

interface PosAuthState {
  user: PosAuthUser | null;
  /** True while a login request is in flight. */
  loading: boolean;
  /** Last login error message (cleared on next attempt). */
  error: string | null;
  /** Authenticate with POS PIN. Returns the user on success. */
  login: (userId: string, pin: string) => Promise<PosAuthUser>;
  /** Clear the POS session (logout / switch user). */
  logout: () => void;
  /** Check if the current POS user has a permission. */
  hasPermission: (perm: string) => boolean;
}

export const usePosAuthStore = create<PosAuthState>()(
  persist(
    (set, get) => ({
      user: null,
      loading: false,
      error: null,

      login: async (userId: string, pin: string) => {
        set({ loading: true, error: null });
        try {
          const res = await api.post('/pos/auth/pin-login', { userId, pin });
          const user = res.data as PosAuthUser;
          // Make the cashier token available to the axios interceptor BEFORE any
          // subsequent POS request fires, so every write is attributed correctly.
          setPosToken(user.posToken ?? null);
          set({ user, loading: false, error: null });
          return user;
        } catch (e: any) {
          const msg = e?.response?.data?.message || 'Invalid PIN or user not found';
          set({ loading: false, error: msg });
          throw new Error(msg);
        }
      },

      logout: () => {
        // Tell the server the cashier left, so HR can clock them out. Sent with
        // the outgoing cashier's token explicitly, because the token is cleared
        // below before the request goes out. Fire-and-forget: a failed call
        // must never keep a cashier signed in.
        const token = get().user?.posToken;
        if (token) {
          api.post('/pos/auth/logoff', {}, { headers: { 'X-Pos-User': token } }).catch(() => {});
        }
        setPosToken(null);
        set({ user: null, error: null });
      },

      hasPermission: (perm: string) => {
        const { user } = get();
        if (!user) return false;
        return user.permissions.includes(perm);
      },
    }),
    {
      name: 'pos-auth',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ user: state.user }),
    },
  ),
);

// Server revoked the cashier token: back to the PIN screen. Clears the state
// directly rather than via logout(), which would post a log-off with the very
// token the server just refused.
onPosSessionRevoked(() => usePosAuthStore.setState({ user: null, error: null }));
