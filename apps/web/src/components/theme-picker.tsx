/**
 * ThemePicker — compact two-way switch between the app's themes
 * (Luxury Sky / Light Charcoal), shown in the header.
 *
 * A thumb slides under the active option. Switching reveals the new theme as
 * a circle growing from the button (View Transitions API); browsers without
 * it — or users who prefer reduced motion — get a short colour crossfade.
 */
import { useRef } from 'react';
import { flushSync } from 'react-dom';
import { cn } from '@/lib/utils';
import { useSidebarTheme, SIDEBAR_THEMES, type SidebarThemeKey } from '@/lib/sidebar-theme';

const ORDER: SidebarThemeKey[] = ['luxurySky', 'lightCharcoal'];

type ViewTransitionDoc = Document & {
  startViewTransition?: (cb: () => void) => { ready: Promise<void> };
};

export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const { key, setKey } = useSidebarTheme();
  const busy = useRef(false);
  const activeIndex = ORDER.indexOf(key);

  const choose = (next: SidebarThemeKey, e: React.MouseEvent<HTMLButtonElement>) => {
    if (next === key || busy.current) return;
    const doc = document as ViewTransitionDoc;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!doc.startViewTransition || reduce) {
      const root = document.documentElement;
      root.classList.add('theme-anim');
      setKey(next);
      window.setTimeout(() => root.classList.remove('theme-anim'), 380);
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

    busy.current = true;
    const vt = doc.startViewTransition(() => flushSync(() => setKey(next)));
    vt.ready
      .then(() =>
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
          { duration: 560, easing: 'cubic-bezier(0.77, 0, 0.175, 1)', pseudoElement: '::view-transition-new(root)' },
        ).finished,
      )
      .catch(() => undefined)
      .finally(() => { busy.current = false; });
  };

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="relative grid grid-cols-[1fr_1fr] items-center rounded-full border border-border/80 bg-muted/60 p-0.5 shadow-[inset_0_1px_2px_hsl(var(--shadow)/0.06)]"
    >
      {/* Sliding thumb */}
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-full bg-card shadow-[0_1px_2px_hsl(var(--shadow)/0.10),0_4px_12px_-4px_hsl(var(--shadow)/0.22)] ring-1 ring-gold/40"
        style={{
          width: 'calc(50% - 2px)',
          transform: `translateX(${activeIndex * 100}%)`,
          transition: 'transform 320ms cubic-bezier(0.77, 0, 0.175, 1)',
        }}
      />
      {ORDER.map((k) => {
        const t = SIDEBAR_THEMES[k];
        const active = k === key;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={active}
            title={t.label}
            onClick={(e) => choose(k, e)}
            className={cn(
              'press relative z-10 flex items-center justify-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-black/10"
              style={{ background: t.swatch, boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.45)' }}
            />
            <span className={cn('whitespace-nowrap', compact ? 'sr-only' : 'hidden lg:inline')}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
