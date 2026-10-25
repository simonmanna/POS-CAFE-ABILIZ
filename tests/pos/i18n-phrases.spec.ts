/**
 * Guards the translation contract the UI relies on:
 *  - every tx('…') phrase in the sources exists in each locale map (or is
 *    deliberately left English, which must still render as English),
 *  - no locale map contains an empty value, which would blank a label,
 *  - placeholders survive translation, so `{{name}}` never goes missing.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WEB = resolve(__dirname, '../../apps/web');
const SRC = join(WEB, 'src');
const PHRASE_DIR = join(SRC, 'lib', 'i18n', 'phrases');
const LOCALES = ['ti', 'lg', 'sw'] as const;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });

const phrases = (() => {
  const found = new Set<string>();
  const re = /\btx\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      found.add(m[1].slice(1, -1).replace(/\\(['"\\])/g, '$1'));
    }
  }
  return [...found];
})();

const maps = Object.fromEntries(
  LOCALES.map((lng) => [lng, JSON.parse(readFileSync(join(PHRASE_DIR, `${lng}.json`), 'utf8')) as Record<string, string>]),
) as Record<(typeof LOCALES)[number], Record<string, string>>;

describe('phrase maps', () => {
  it('finds the wrapped phrases in the sources', () => {
    expect(phrases.length).toBeGreaterThan(1000);
  });

  for (const lng of LOCALES) {
    it(`${lng}: no empty translations (an empty value would blank the UI)`, () => {
      const blank = Object.entries(maps[lng]).filter(([, v]) => typeof v !== 'string' || !v.trim());
      expect(blank.map(([k]) => k)).toEqual([]);
    });

    it(`${lng}: no stale keys that the sources no longer use`, () => {
      const known = new Set(phrases);
      expect(Object.keys(maps[lng]).filter((k) => !known.has(k))).toEqual([]);
    });

    it(`${lng}: keeps every {{placeholder}} of the source phrase`, () => {
      const broken: string[] = [];
      for (const [en, translated] of Object.entries(maps[lng])) {
        const want = (en.match(/\{\{\w+\}\}/g) ?? []).sort();
        const got = (translated.match(/\{\{\w+\}\}/g) ?? []).sort();
        if (want.join('|') !== got.join('|')) broken.push(en);
      }
      expect(broken).toEqual([]);
    });

    it(`${lng}: covers at least 95% of the phrases`, () => {
      const covered = phrases.filter((p) => maps[lng][p]).length;
      expect(covered / phrases.length).toBeGreaterThan(0.95);
    });
  }
});
