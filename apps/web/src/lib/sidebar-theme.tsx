/**
 * App theme system — two customer-selectable themes.
 *
 *   • luxurySky     — pearl canvas, midnight-sapphire sidebar, sky accents
 *   • lightCharcoal — warm ivory canvas, graphite sidebar, charcoal accents
 *
 * The active theme is written to `<html data-theme="sky|charcoal">`, which
 * swaps every design token in index.css (including the Tailwind sky / blue /
 * cyan ramps). The sidebar needs gradients Tailwind can't express, so its
 * palette also lives here and is exposed as `--sb-*` CSS variables.
 *
 * Persisted to localStorage; index.html applies it before first paint.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type SidebarThemeKey = 'luxurySky' | 'lightCharcoal';

export interface SidebarTheme {
  key: SidebarThemeKey;
  /** Value written to <html data-theme>. */
  dataTheme: 'sky' | 'charcoal';
  label: string;
  swatch: string;
  /** Background of the sidebar (linear-gradient string). */
  sidebar: string;
  /** Divider lines inside the sidebar. */
  sidebarBorder: string;
  /** Default text color. */
  sidebarText: string;
  /** Muted text color (sub-items, hints). */
  sidebarMuted: string;
  /** Hover background. */
  sidebarHover: string;
  /** Text color when a nav item is active. */
  sidebarActive: string;
  /** Background for active nav item. */
  sidebarActiveBg: string;
  /** Accent bar on the left edge of the active item. */
  sidebarActiveBar: string;
  /** Brand-tile background (logo box). */
  brandBg: string;
  /** Primary accent (buttons, badges, focus rings). */
  accent: string;
  accentHover: string;
  accentText: string;
  badgeBg: string;
}

const CHAMPAGNE = '#d9b872';

export const SIDEBAR_THEMES: Record<SidebarThemeKey, SidebarTheme> = {
  luxurySky: {
    key: 'luxurySky',
    dataTheme: 'sky',
    label: 'Luxury Sky',
    swatch: 'linear-gradient(135deg, #7dd3fc 0%, #0284c7 55%, #0b2545 100%)',
    sidebar: 'linear-gradient(180deg, #0b2545 0%, #0c3a66 52%, #0d5689 100%)',
    sidebarBorder: 'rgba(186, 230, 253, 0.12)',
    sidebarText: 'rgba(234, 244, 253, 0.86)',
    sidebarMuted: 'rgba(173, 214, 245, 0.62)',
    sidebarHover: 'rgba(255, 255, 255, 0.07)',
    sidebarActive: '#ffffff',
    sidebarActiveBg: 'linear-gradient(90deg, rgba(125, 211, 252, 0.24) 0%, rgba(125, 211, 252, 0.05) 100%)',
    sidebarActiveBar: CHAMPAGNE,
    brandBg: 'linear-gradient(135deg, #38bdf8 0%, #0369a1 100%)',
    accent: '#0284c7',
    accentHover: '#0369a1',
    accentText: '#075985',
    badgeBg: '#38bdf8',
  },
  lightCharcoal: {
    key: 'lightCharcoal',
    dataTheme: 'charcoal',
    label: 'Light Charcoal',
    swatch: 'linear-gradient(135deg, #b9b7b1 0%, #4a4d52 55%, #1f2023 100%)',
    sidebar: 'linear-gradient(180deg, #3a3d42 0%, #303236 52%, #26282b 100%)',
    sidebarBorder: 'rgba(255, 255, 255, 0.08)',
    sidebarText: 'rgba(241, 240, 237, 0.84)',
    sidebarMuted: 'rgba(214, 211, 204, 0.55)',
    sidebarHover: 'rgba(255, 255, 255, 0.06)',
    sidebarActive: '#ffffff',
    sidebarActiveBg: 'linear-gradient(90deg, rgba(217, 184, 114, 0.18) 0%, rgba(217, 184, 114, 0.03) 100%)',
    sidebarActiveBar: CHAMPAGNE,
    brandBg: 'linear-gradient(135deg, #5a5d63 0%, #1f2023 100%)',
    accent: '#2f3136',
    accentHover: '#1f2023',
    accentText: '#2a2b2e',
    badgeBg: '#b39150',
  },
};

interface SidebarThemeContextValue {
  key: SidebarThemeKey;
  theme: SidebarTheme;
  setKey: (k: SidebarThemeKey) => void;
}

const Ctx = createContext<SidebarThemeContextValue | null>(null);

const STORAGE_KEY = 'poscafe.theme';
const DEFAULT_KEY: SidebarThemeKey = 'luxurySky';

const keyFromDataTheme = (v: string | null): SidebarThemeKey | null =>
  v === 'charcoal' ? 'lightCharcoal' : v === 'sky' ? 'luxurySky' : null;

export function SidebarThemeProvider({ children }: { children: React.ReactNode }) {
  const [key, setKeyState] = useState<SidebarThemeKey>(() => {
    if (typeof window === 'undefined') return DEFAULT_KEY;
    try {
      return keyFromDataTheme(window.localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_KEY;
    } catch {
      return DEFAULT_KEY;
    }
  });

  // Push the palette onto <html>: data-theme swaps the design tokens, the
  // --sb-* variables feed the sidebar and anything styled outside React.
  useEffect(() => {
    const t = SIDEBAR_THEMES[key];
    const root = document.documentElement;
    root.dataset.theme = t.dataTheme;
    root.style.setProperty('--sb-accent', t.accent);
    root.style.setProperty('--sb-accent-hover', t.accentHover);
    root.style.setProperty('--sb-accent-text', t.accentText);
    root.style.setProperty('--sb-sidebar', t.sidebar);
    root.style.setProperty('--sb-text', t.sidebarText);
    root.style.setProperty('--sb-muted', t.sidebarMuted);
    root.style.setProperty('--sb-hover', t.sidebarHover);
    root.style.setProperty('--sb-active', t.sidebarActive);
    root.style.setProperty('--sb-active-bg', t.sidebarActiveBg);
    root.style.setProperty('--sb-active-bar', t.sidebarActiveBar);
  }, [key]);

  const setKey = useCallback((k: SidebarThemeKey) => {
    setKeyState(k);
    try { window.localStorage.setItem(STORAGE_KEY, SIDEBAR_THEMES[k].dataTheme); } catch { /* ignore */ }
  }, []);

  const value = useMemo<SidebarThemeContextValue>(
    () => ({ key, theme: SIDEBAR_THEMES[key], setKey }),
    [key, setKey],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSidebarTheme(): SidebarThemeContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSidebarTheme must be used within SidebarThemeProvider');
  return v;
}
