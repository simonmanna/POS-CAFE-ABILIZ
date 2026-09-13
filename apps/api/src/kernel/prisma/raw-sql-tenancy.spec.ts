import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Release gate: raw SQL bypasses the Prisma tenancy extension, so every raw
 * query that touches an organization-scoped table must carry its own
 * organization predicate. Cross-organization workers are an explicit allowlist.
 */
const SRC = join(__dirname, '../..');

/** Raw statements that are organization-agnostic by design, with the reason. */
const ALLOWED: Array<{ file: string; table: string; why: string }> = [
  { file: 'kernel/events/outbox.worker.ts', table: 'EventOutbox', why: 'cross-org outbox claim worker' },
  { file: 'modules/communication/outbound/message-dispatch.worker.ts', table: 'MessageDelivery', why: 'cross-org dispatch claim worker' },
  { file: 'modules/communication/providers/whatsapp/baileys/baileys-session.manager.ts', table: 'CommunicationChannel', why: 'cross-org session lease' },
  { file: 'modules/pos/billing/stock-posting.worker.ts', table: 'StockPostingJob', why: 'cross-org stock posting claim worker' },
  { file: 'modules/pos/billing/pos-invoice.service.ts', table: 'StockPostingJob', why: 'row lock by id on a job already loaded through the tenant-scoped client' },
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });
}

describe('raw SQL tenancy', () => {
  const tenancy = readFileSync(join(__dirname, 'tenancy.extension.ts'), 'utf8');
  const scoped = new Set([...tenancy.slice(0, tenancy.indexOf(']);')).matchAll(/'([A-Z][A-Za-z]+)'/g)].map((m) => m[1]));

  it('every raw query on an organization-scoped table is scoped by organization', () => {
    const violations: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (rel.startsWith('scripts/')) continue; // operator tools run per organization explicitly
      const text = readFileSync(file, 'utf8');
      const re = /\$(queryRaw|executeRaw)(Unsafe)?\s*(<[^>]*>)?\s*(\(|`)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const snippet = text.slice(m.index, m.index + 1600);
        const end = snippet.search(/\)\s*;|`\s*;|`\s*\)/);
        const statement = end > 0 ? snippet.slice(0, end + 2) : snippet;
        const tables = [...statement.matchAll(/"([A-Z][A-Za-z]+)"/g)].map((t) => t[1]).filter((t) => scoped.has(t));
        if (!tables.length) continue;
        if (/organizationId|organization_id|app\.org_id/.test(statement)) continue;
        for (const table of new Set(tables)) {
          if (ALLOWED.some((a) => a.file === rel && a.table === table)) continue;
          const line = text.slice(0, m.index).split('\n').length;
          violations.push(`${rel}:${line} → "${table}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
