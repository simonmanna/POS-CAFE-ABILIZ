/**
 * Collect every phrase passed to tx(...) in the web sources and report
 * coverage per locale. Source of truth for the phrase maps in
 * src/lib/i18n/phrases/<lng>.json.
 *
 *   node scripts/i18n-phrases.cjs            # coverage report
 *   node scripts/i18n-phrases.cjs --write    # add missing keys (value = "")
 *   node scripts/i18n-phrases.cjs --prune    # drop keys no longer in source
 *   node scripts/i18n-phrases.cjs --list ti  # print untranslated phrases
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const PHRASE_DIR = path.join(SRC, 'lib', 'i18n', 'phrases');
const LOCALES = ['ti', 'lg', 'sw'];

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(p)) files.push(p);
  }
})(SRC);

const phrases = new Set();
const RE = /\btx\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = RE.exec(src))) {
    const lit = m[1];
    const body = lit.slice(1, -1);
    phrases.add(body.replace(/\\(['"\\])/g, '$1'));
  }
}
const all = [...phrases].sort((a, b) => a.localeCompare(b));

const listFor = process.argv.includes('--list') ? process.argv[process.argv.indexOf('--list') + 1] : null;
const write = process.argv.includes('--write');
const prune = process.argv.includes('--prune');

console.log('phrases in source:', all.length);
for (const lng of LOCALES) {
  const file = path.join(PHRASE_DIR, lng + '.json');
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  const missing = all.filter((p) => !map[p] || !String(map[p]).trim());
  const stale = Object.keys(map).filter((k) => !phrases.has(k));
  console.log(
    `  ${lng}: ${all.length - missing.length}/${all.length} translated` +
    ` (${Math.round(((all.length - missing.length) / all.length) * 100)}%)` +
    `, missing ${missing.length}, stale ${stale.length}`,
  );
  if (listFor === lng) missing.forEach((p) => console.log(p));
  if (write || prune) {
    // Only real translations are written; a missing key falls back to English.
    const next = {};
    for (const p of all) if (map[p] && String(map[p]).trim()) next[p] = map[p];
    if (!prune) for (const k of stale) next[k] = map[k];
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  }
}
if (write || prune) console.log('phrase maps updated');
