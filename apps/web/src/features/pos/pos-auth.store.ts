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

export interface PosAuthUser {
  userId: string;
  firstName: string;
  lastName: string | null;
  email: string;
  permissions: string[];
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
          set({ user, loading: false, error: null });
          return user;
        } catch (e: any) {
          const msg = e?.response?.data?.message || 'Invalid PIN or user not found';
          set({ loading: false, error: msg });
          throw new Error(msg);
        }
      },

      logout: () => set({ user: null, error: null }),

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
