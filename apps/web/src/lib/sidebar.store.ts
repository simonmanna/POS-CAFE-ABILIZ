import { create } from 'zustand';

interface SidebarState {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  toggle: () => void;
}

/**
 * Shared sidebar collapse state.
 *
 * AppShell owns the sidebar, but the POS Terminal renders outside AppShell
 * (full-screen cashier route) and still needs to toggle the sidebar — so the
 * state lives here instead of in AppShell's local useState.
 */
export const useSidebarStore = create<SidebarState>((set) => ({
  collapsed: false,
  setCollapsed: (v) => set({ collapsed: v }),
  toggle: () => set((s) => ({ collapsed: !s.collapsed })),
}));
