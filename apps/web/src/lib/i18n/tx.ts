/**
 * Phrase translation — natural-language keys.
 *
 * `tx('Open Shift')` looks the English source string up in the active
 * locale's phrase map and falls back to the English string itself when no
 * translation exists. A missing phrase therefore degrades to the original UI
 * instead of showing a key, which is what makes a partially translated build
 * safe to ship.
 *
 * It is a plain function, not a hook, so it also works in toasts, helpers and
 * non-component modules. Phrase maps are code-split and fetched only for the
 * locale in use (English needs none); the app tree remounts once a map
 * arrives — see `useAppLanguage`.
 */
import i18n from './i18n';

type PhraseMap = Record<string, string>;

/** Dynamic imports keep each locale in its own chunk (precached by the SW). */
const LOADERS: Record<string, () => Promise<{ default: PhraseMap }>> = {
  ti: () => import('./phrases/ti.json'),
  lg: () => import('./phrases/lg.json'),
  sw: () => import('./phrases/sw.json'),
};

const MAPS: Record<string, PhraseMap> = {};
const pending = new Set<string>();
const listeners = new Set<() => void>();

export const currentLang = (): string =>
  (i18n.resolvedLanguage ?? i18n.language ?? 'en').slice(0, 2);

/** Called by useAppLanguage so a late-arriving phrase map re-renders the tree. */
export function onPhrasesLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fetch the phrase map for a locale once. Safe to call repeatedly. */
export function ensurePhrases(lang = currentLang()): void {
  const code = lang.slice(0, 2);
  if (MAPS[code] || pending.has(code) || !LOADERS[code]) return;
  pending.add(code);
  void LOADERS[code]()
    .then((mod) => {
      MAPS[code] = mod.default;
      listeners.forEach((fn) => fn());
    })
    .catch(() => {
      /* Offline and not precached: English stays on screen. */
    })
    .finally(() => pending.delete(code));
}

/** Interpolate `{{name}}` placeholders. */
const interpolate = (s: string, vars?: Record<string, unknown>): string =>
  vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? `{{${k}}}`)) : s;

export function tx(phrase: string, vars?: Record<string, unknown>): string {
  const hit = MAPS[currentLang()]?.[phrase];
  // An empty value means "not translated yet" — fall back to the source text.
  return interpolate(hit && hit.trim() ? hit : phrase, vars);
}

/** True once the active locale needs no further fetch (English included). */
export const phrasesReady = (lang = currentLang()): boolean =>
  !LOADERS[lang.slice(0, 2)] || Boolean(MAPS[lang.slice(0, 2)]);

// Start fetching the detected locale immediately, before the first render.
ensurePhrases();
i18n.on('languageChanged', (lng: string) => ensurePhrases(lng));
