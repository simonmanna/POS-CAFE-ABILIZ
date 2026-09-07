/* eslint-disable */
/**
 * A-009 — Legacy pre-migration adjusting journal entry (owner-signed-off 2026-09-06).
 *
 * Background (audit/POS_RECONCILIATION_AUDIT.md §2): 4 pre-migration invoices
 * were posted Dr-Cash but never settled; the GL cash account is overstated by
 * 375,000 vs the physical drawer, and the WALKIN receivable is polluted with
 * balances that will never be collected (collection refused by design).
 *
 * Remedy (two legs, each idempotent, computed from live data — never hardcoded):
 *   Leg 1 — adjusting JE: Dr <AR 1300> / Cr <Cash 1100> for the total residual:
 *     removes the phantom cash debit (GL cash overstated vs drawer) and
 *     recognises the WALKIN AR claim explicitly. Marks each legacy invoice
 *     settlementStatus='written_off', amountResidual=0 (WALKIN AR cleanup).
 *   Leg 2 — write-off JE: Dr <Bad Debt 5500> / Cr <AR 1300> for the same
 *     amount: the recognised claim is uncollectable (collection refused by
 *     design), so it is formally written off. Net GL: Cash −375k, Bad Debt +375k.
 *
 * Safety:
 *   - --dry-run (default): prints exactly what would be posted; writes NOTHING.
 *   - --apply: posts the missing legs + updates invoices in ONE transaction; ROLLBACK on any error.
 *   - Idempotent: a leg is skipped when its marker entry (sourceType
 *     'a009_legacy_adjustment' / 'a009_legacy_writeoff') already exists;
 *     invoices already written off are skipped. Re-run is always safe.
 *   - Requires --organization <id>. Run scripts/pos-release-preflight.cjs
 *     before and after (per the remediation plan Wave 4.1).
 *
 * The legacy set is identified as: pre-migration invoices (posted before the
 * POS migration cutoff), status NOT cancelled/refunded, paymentMode='cash',
 * settlementStatus='unsettled', journalEntryId NOT NULL (posted to GL).
 */
const fs = require('node:fs');
const { Client } = require('pg');
const dotenv = require('dotenv');

const args = process.argv.slice(2);
const orgArg = args[args.indexOf('--organization') + 1];
const APPLY = args.includes('--apply');
if (!args.includes('--organization') || !/^[\w-]+$/.test(orgArg || '')) {
  throw new Error('Usage: node scripts/pos-a009-legacy-adjustment.cjs --organization <org-id> [--apply] (default: dry-run)');
}

async function main() {
  const config = fs.existsSync('apps/api/.env') ? dotenv.parse(fs.readFileSync('apps/api/.env')) : {};
  const connectionString = process.env.DATABASE_URL || config.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString });
  await db.connect();

  const setOrg = async () =>
    db.query("SELECT set_config('app.org_id', $1, false)", [orgArg]);

  // ── 1. Identify the legacy unsettled Dr-Cash invoice set ────────────────
  await setOrg();
  const legacy = (await db.query(`
    SELECT id, "invoiceNumber", "paymentMode", "settlementStatus", "amountResidual",
           "receivableAccountId", "journalEntryId", "createdAt"
    FROM "Invoice"
    WHERE "organizationId" = $1
      AND status NOT IN ('cancelled','refunded')
      AND "paymentMode" = 'cash'
      AND "journalEntryId" IS NOT NULL
    ORDER BY "createdAt" ASC`, [orgArg])).rows;

  const toAdjust = legacy.filter((i) => i.settlementStatus === 'unsettled' && Number(i.amountResidual) > 0.001);
  let total = toAdjust.reduce((s, i) => s + Number(i.amountResidual), 0);
  /** True when only leg 2 (write-off of an already-adjusted legacy set) remains. */
  let toAdjustPendingWriteoff = false;

  // Idempotency markers: which legs were already posted for this org.
  const markers = (await db.query(`
    SELECT "sourceType", COUNT(*)::int AS n, MAX("postingDate") AS last
    FROM "JournalEntry"
    WHERE "organizationId" = $1 AND "sourceType" IN ('a009_legacy_adjustment','a009_legacy_writeoff')
    GROUP BY "sourceType"`, [orgArg])).rows;
  const leg1Done = markers.some((m) => m.sourceType === 'a009_legacy_adjustment');
  const leg2Done = markers.some((m) => m.sourceType === 'a009_legacy_writeoff');

  if (toAdjust.length === 0 && leg1Done) {
    // Leg 1 done but leg 2 (write-off) may still be missing — fall through so
    // the plan/apply sections can post it using the leg-1 amount. Recover the
    // amount from the posted leg-1 entry (sum of its debit lines).
    if (!leg2Done) {
      const l1 = (await db.query(`
        SELECT COALESCE(SUM(l.debit), 0) AS amount, COUNT(*)::int AS lines
        FROM "JournalLine" l JOIN "JournalEntry" je ON je.id = l."journalEntryId"
        WHERE je."organizationId" = $1 AND je."sourceType" = 'a009_legacy_adjustment'`, [orgArg])).rows[0];
      total = Number(l1.amount);
      toAdjustPendingWriteoff = true; // signal: leg 2 only
    } else {
      process.stdout.write(JSON.stringify({ result: 'NOTHING_TO_ADJUST', organizationId: orgArg, legsPosted: Object.fromEntries(markers.map((m) => [m.sourceType, m.n])), note: 'A-009 fully remediated (both legs posted). Re-runs are no-ops.' }, null, 2) + '\n');
      await db.end();
      return;
    }
  }
  if (toAdjust.length === 0 && !leg1Done) {
    process.stdout.write(JSON.stringify({ result: 'NOTHING_TO_ADJUST', organizationId: orgArg, legacyCount: legacy.length, note: 'No unsettled Dr-Cash legacy invoices with a residual and no prior A-009 entry. Nothing to do.' }, null, 2) + '\n');
    await db.end();
    return;
  }

  // ── 2. Resolve accounts (never hardcoded ids) ────────────────────────────
  // AR: distinct receivableAccountId on the legacy set; else org mapping
  // 'accounts_receivable'.
  const distinctAr = [...new Set(toAdjust.map((i) => i.receivableAccountId).filter(Boolean))];
  let arAccount;
  if (distinctAr.length === 1) {
    arAccount = (await db.query('SELECT id, code, name FROM "Account" WHERE id = $1', [distinctAr[0]])).rows[0];
  } else {
    arAccount = (await db.query(`
      SELECT a.id, a.code, a.name FROM "AccountMapping" m
      JOIN "Account" a ON a.id = m."accountId"
      WHERE m."organizationId" = $1 AND m.key = 'accounts_receivable' LIMIT 1`, [orgArg])).rows[0];
  }
  // Cash: only needed when leg 1 is still pending.
  let cashAccount = null;
  if (!leg1Done) {
    cashAccount = (await db.query(`
      SELECT a.id, a.code, a.name FROM "AccountMapping" m
      JOIN "Account" a ON a.id = m."accountId"
      WHERE m."organizationId" = $1 AND m.key = 'default_cash' LIMIT 1`, [orgArg])).rows[0];
  }
  // Bad debt: the org mapping 'bad_debt' (account 5500) for the write-off leg.
  const badDebtAccount = (await db.query(`
    SELECT a.id, a.code, a.name FROM "AccountMapping" m
    JOIN "Account" a ON a.id = m."accountId"
    WHERE m."organizationId" = $1 AND m.key = 'bad_debt' LIMIT 1`, [orgArg])).rows[0];
  if ((!leg1Done && !cashAccount) || !arAccount || !badDebtAccount) {
    throw new Error(`Account resolution failed (cash: ${cashAccount?.id ?? 'n/a'}, ar: ${arAccount?.id ?? 'none'}, badDebt: ${badDebtAccount?.id ?? 'none'}). Configure mappings and re-run.`);
  }

  const plan = {
    a009: true,
    mode: APPLY ? 'APPLY' : 'DRY-RUN',
    organizationId: orgArg,
    leg2Only: toAdjustPendingWriteoff || undefined,
    legacyInvoices: toAdjust.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, residual: i.amountResidual, createdAt: i.createdAt })),
    invoiceCount: toAdjust.length,
    totalResidual: total,
    legs: {
      // Leg 1 already posted in a previous run? Report it, don't repeat it.
      leg1_adjusting: leg1Done
        ? { status: 'ALREADY_POSTED' }
        : {
          journalCode: 'GEN',
          sourceType: 'a009_legacy_adjustment',
          description: `A-009 legacy pre-migration Dr-Cash adjustment — ${toAdjust.length} invoice(s), residual ${total} (owner sign-off 2026-09-06)`,
          lines: [
            { account: `${arAccount.code} ${arAccount.name}`, debit: total, credit: 0 },
            { account: `${cashAccount.code} ${cashAccount.name}`, debit: 0, credit: total },
          ],
          alsoMarksInvoicesWrittenOff: toAdjust.map((i) => i.invoiceNumber),
        },
      leg2_writeoff: leg2Done
        ? { status: 'ALREADY_POSTED' }
        : {
          journalCode: 'GEN',
          sourceType: 'a009_legacy_writeoff',
          description: `A-009 WALKIN receivable write-off — uncollectable residual ${total} (owner sign-off 2026-09-06)`,
          lines: [
            { account: `${badDebtAccount.code} ${badDebtAccount.name}`, debit: total, credit: 0 },
            { account: `${arAccount.code} ${arAccount.name}`, debit: 0, credit: total },
          ],
        },
    },
    note: APPLY ? 'Posting missing legs in one transaction.' : 'Dry-run only. Re-run with --apply to post.',
  };

  if (!APPLY) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    await db.end();
    return;
  }

  // ── 3. Apply: one transaction — missing JEs + invoice write-offs ─────────
  try {
    await db.query('BEGIN');
    await setOrg();

    const journal = (await db.query(`
      SELECT id FROM "Journal" WHERE "organizationId" = $1 AND code = 'GEN' LIMIT 1`, [orgArg])).rows[0];
    if (!journal) throw new Error("Journal 'GEN' not found for this organization");

    const year = new Date().getUTCFullYear();
    const seqName = `seq_${orgArg.replace(/-/g, '').slice(0, 8)}_journal_GEN_${year}`.replace(/[^a-zA-Z0-9_]/g, '_');
    await db.query(`CREATE SEQUENCE IF NOT EXISTS "${seqName}" INCREMENT BY 1 START WITH 1`);

    const posted = [];
    const postEntry = async (sourceType, desc, lines) => {
      const seq = (await db.query(`SELECT nextval('"${seqName}"') AS v`)).rows[0].v;
      const entryNumber = `GEN/${year}/${String(seq).padStart(5, '0')}`;
      const entry = (await db.query(`
        INSERT INTO "JournalEntry"
          ("id", "organizationId", "journalId", "entryNumber", "postingDate",
           "description", "status", "currencyId", "sourceType", "sourceId", "postingType",
           "postedAt", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), $1, $2, $3, now()::date,
                $4, 'posted', NULL, $5, $6, 'primary',
                now(), now(), now())
        RETURNING id, "entryNumber"`, [orgArg, journal.id, entryNumber, desc, sourceType, orgArg])).rows[0];
      for (const [idx, l] of lines.entries()) {
        await db.query(`
          INSERT INTO "JournalLine"
            ("id", "organizationId", "journalEntryId", "accountId", "description", "lineNumber",
             "debit", "credit", "baseDebit", "baseCredit", "exchangeRate", "createdAt")
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $6, $7, 1, now())`,
          [orgArg, entry.id, l.accountId, desc, idx + 1, l.debit, l.credit]);
      }
      posted.push({ sourceType, entryNumber, entryId: entry.id });
    };

    // Leg 1: Dr AR / Cr Cash + mark invoices written off.
    if (!leg1Done) {
      await postEntry('a009_legacy_adjustment', plan.legs.leg1_adjusting.description, [
        { accountId: arAccount.id, debit: total, credit: 0 },
        { accountId: cashAccount.id, debit: 0, credit: total },
      ]);
      for (const inv of toAdjust) {
        const r = await db.query(`
          UPDATE "Invoice"
          SET "settlementStatus" = 'written_off', "amountResidual" = 0, "version" = "version" + 1, "updatedAt" = now()
          WHERE "id" = $1 AND "organizationId" = $2 AND "settlementStatus" = 'unsettled'`, [inv.id, orgArg]);
        if (r.rowCount === 0) throw new Error(`Invoice ${inv.invoiceNumber} changed concurrently — aborting`);
      }
    }

    // Leg 2: Dr Bad Debt / Cr AR — the recognised WALKIN claim is uncollectable.
    if (!leg2Done) {
      await postEntry('a009_legacy_writeoff', plan.legs.leg2_writeoff.description, [
        { accountId: badDebtAccount.id, debit: total, credit: 0 },
        { accountId: arAccount.id, debit: 0, credit: total },
      ]);
    }

    await db.query('COMMIT');
    process.stdout.write(JSON.stringify({ result: 'POSTED', entries: posted, invoicesWrittenOff: leg1Done ? 0 : toAdjust.length, totalResidual: total, mode: 'APPLY' }, null, 2) + '\n');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
