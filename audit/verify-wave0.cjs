/**
 * Wave-0 live verification: A-001 closed on the running build.
 * Replays the EXACT attack from evidence-a001.json against the same audit org:
 *   1. Cashier mints → must now be 403 (pos:override gate)
 *   2. Manager mints without funding → 400 (funding required)
 *   3. Manager mints with funding while cap unset → 403 (disabled by default)
 *   4. Cap set + funded mint → 201 + funding GL + audit row + balanced books
 *   5. notes field → no 500 (A-100)
 * Usage: node audit/verify-wave0.cjs <orgFile>
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require(path.join(process.cwd(), 'node_modules', 'pg'));

const BASE = 'http://localhost:3001/api/v1';
const CONN = 'postgresql://cafe-pos:cafe-pos@localhost:5432/cafe-pos';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ORG, emails = {}, tokens = {};
const results = [];
function record(check, pass, detail) { results.push({ check, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}${detail ? ' — ' + JSON.stringify(detail) : ''}`); }
async function db(sql, params = []) { const c = new Client({ connectionString: CONN }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } }
async function login(who) {
  for (let i = 0; i < 8; i++) {
    const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emails[ORG.users[who]], password: ORG.passwords[who], organizationCode: ORG.code }) });
    if (res.status === 429) { await sleep(20000); continue; }
    const j = await res.json(); if (!j.accessToken) throw new Error(`login ${who}: ${res.status} ${JSON.stringify(j).slice(0,150)}`); tokens[who] = j.accessToken; return;
  }
  throw new Error('throttled');
}
async function api(who, method, p, body) {
  const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, ok: res.ok, body: json };
}

main();
async function main() {
  ORG = JSON.parse(fs.readFileSync(path.join(process.cwd(), process.argv[2]), 'utf8'));
  if (!ORG.code) ORG.code = (await db(`SELECT code FROM "Organization" WHERE id=$1`, [ORG.orgId]))[0].code;
  const orgId = ORG.orgId;
  for (const u of await db(`SELECT id, email FROM "User" WHERE "organizationId"=$1`, [orgId])) emails[u.id] = u.email;
  await login('cashier'); await login('manager'); await login('admin');

  const before = {
    gl: Number((await db(`SELECT count(*)::int n FROM "JournalEntry" WHERE "organizationId"=$1`, [orgId]))[0].n),
    balance: Number((await db(`SELECT COALESCE(balance,0) b FROM "StoreCredit" WHERE "organizationId"=$1 AND "partnerId"=$2`, [orgId, ORG.creditCustomer]))[0].b),
  };
  console.log('baseline:', JSON.stringify(before));

  // 1. The original attack: cashier mints
  const cashierMint = await api('cashier', 'POST', '/pos/loyalty/credit/issue', { partnerId: ORG.creditCustomer, amount: 100000, source: 'cashier_test' });
  record('A-001: cashier mint → 403 (pos:override gate)', cashierMint.status === 403, { httpStatus: cashierMint.status, message: cashierMint.body.message });

  // 2. Manager mints WITHOUT funding account
  const noFunding = await api('manager', 'POST', '/pos/loyalty/credit/issue', { partnerId: ORG.creditCustomer, amount: 10000, source: 'gift_card' });
  record('A-001: manager mint without funding → 400 (funding required)', noFunding.status === 400, { httpStatus: noFunding.status, message: Array.isArray(noFunding.body.message) ? noFunding.body.message[0] : noFunding.body.message });

  // 3. Manager mints WITH funding while cap unset (default 0 = disabled)
  const disabled = await api('manager', 'POST', '/pos/loyalty/credit/issue', { partnerId: ORG.creditCustomer, amount: 10000, source: 'gift_card', fundingAccountId: ORG.accounts.bank });
  record('A-001: funded mint with cap=0 → 403 (issuance disabled by default)', disabled.status === 403, { httpStatus: disabled.status, message: disabled.body.message });

  // 4. Raise the cap (admin), then funded mint — expect 201 + GL + audit
  const setCap = await api('admin', 'PUT', '/settings/pos.storeCreditIssueLimit', { value: 50000, scopeType: 'organization' });
  if (!setCap.ok) {
    // try the settings POST surface used by the admin UI
    const alt = await api('admin', 'POST', '/settings', { key: 'pos.storeCreditIssueLimit', value: 50000, scopeType: 'organization', scopeId: '' });
    record('A-001: cap setting raised', alt.ok, { httpStatus: alt.status, body: alt.body.message ?? 'ok' });
  } else {
    record('A-001: cap setting raised', true, null);
  }
  await db(`DELETE FROM "Setting" WHERE "organizationId"=$1 AND key='pos.storeCreditIssueLimit'`, [orgId]).catch(()=>{});
  await db(`INSERT INTO "Setting" (id, "organizationId", scope, "scopeType", "scopeId", key, value, "updatedAt") VALUES (gen_random_uuid(), $1, 'accounting', 'organization', '', 'pos.storeCreditIssueLimit', '50000', NOW())`, [orgId]);

  const funded = await api('manager', 'POST', '/pos/loyalty/credit/issue', { partnerId: ORG.creditCustomer, amount: 10000, source: 'gift_card', fundingAccountId: ORG.accounts.expense, notes: 'wave0 verify' });
  record('A-001: funded mint within cap → 201', funded.status === 201 || funded.ok, { httpStatus: funded.status, body: funded.body });

  const after = {
    gl: Number((await db(`SELECT count(*)::int n FROM "JournalEntry" WHERE "organizationId"=$1`, [orgId]))[0].n),
    balance: Number((await db(`SELECT COALESCE(balance,0) b FROM "StoreCredit" WHERE "organizationId"=$1 AND "partnerId"=$2`, [orgId, ORG.creditCustomer]))[0].b),
  };
  const fundEntry = await db(`SELECT je."entryNumber", a.code, sum(l.debit) dr, sum(l.credit) cr FROM "JournalEntry" je JOIN "JournalLine" l ON l."journalEntryId"=je.id JOIN "Account" a ON a.id=l."accountId" WHERE je."organizationId"=$1 AND je."sourceType"='store_credit_issue' GROUP BY 1,2 ORDER BY 2`, [orgId]);
  const auditRow = await db(`SELECT entity, action FROM "AuditLog" WHERE "organizationId"=$1 AND entity='StoreCredit' AND action='issue' ORDER BY "createdAt" DESC LIMIT 1`, [orgId]);
  record('A-001: funding GL posted (Dr expense / Cr liability, balanced)', fundEntry.length === 2 && fundEntry.some(g => g.code === '5200' && Number(g.dr) === 10000) && fundEntry.some(g => g.code === '2350' && Number(g.cr) === 10000), fundEntry);
  record('A-001: AuditLog row written', auditRow.length === 1, auditRow);
  record('A-001: balance moved by exactly the minted amount', after.balance === before.balance + 10000, { before: before.balance, after: after.balance });

  // 5. A-100: notes no longer 500s (the funded mint above carried notes and 201'd)
  record('A-100: notes field accepted without PrismaClientValidationError', funded.status === 201, { httpStatus: funded.status });

  // cleanup: zero the credit back out for a clean org state
  await db(`UPDATE "StoreCredit" SET balance = $1 WHERE "organizationId"=$2 AND "partnerId"=$3`, [before.balance, orgId, ORG.creditCustomer]);

  const summary = { passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, results, at: new Date().toISOString() };
  fs.writeFileSync(path.join(process.cwd(), 'audit', 'evidence-wave0-verification.json'), JSON.stringify(summary, null, 2));
  console.log(`\nWAVE-0 LIVE VERIFICATION: ${summary.passed} passed / ${summary.failed} failed`);
  process.exitCode = summary.failed > 0 ? 1 : 0;
}
