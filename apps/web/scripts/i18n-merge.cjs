/**
 * Merge a translation chunk into the phrase maps.
 *
 *   node scripts/i18n-merge.cjs <chunk.json>
 *
 * Chunk shape: { "ti": { "English": "…" }, "lg": {…}, "sw": {…} }
 * Only non-empty values are written; keys absent from the source phrase list
 * are reported so typos do not silently pile up.
 */
const fs = require('fs');
const path = require('path');

const PHRASE_DIR = path.resolve(__dirname, '..', 'src', 'lib', 'i18n', 'phrases');
const chunkPath = process.argv[2];
if (!chunkPath) {
  console.error('usage: node scripts/i18n-merge.cjs <chunk.json>');
  process.exit(1);
}
const chunk = JSON.parse(fs.readFileSync(chunkPath, 'utf8'));

for (const [lng, entries] of Object.entries(chunk)) {
  const file = path.join(PHRASE_DIR, lng + '.json');
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  let added = 0, unknown = 0;
  for (const [en, tr] of Object.entries(entries)) {
    if (!tr || !String(tr).trim()) continue;
    if (!(en in map)) { unknown++; }
    map[en] = tr;
    added++;
  }
  const sorted = {};
  for (const k of Object.keys(map).sort((a, b) => a.localeCompare(b))) sorted[k] = map[k];
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n');
  const done = Object.values(sorted).filter((v) => String(v).trim()).length;
  console.log(`${lng}: +${added} (${unknown} not in source list) → ${done}/${Object.keys(sorted).length} translated`);
}
