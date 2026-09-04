import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

/**
 * Bind the POS payment modes to the finance accounts their money lands in.
 *
 * Before PosPaymentMethod existed, "payment mode" and "finance account" were
 * the same thing: the Charge dialog asked the cashier to pick a GL account, and
 * an org that had never created a `mobile_money` account simply could not take
 * mobile money at all. This script gives an existing organisation the accounts
 * and the configuration rows it needs.
 *
 * Per organisation:
 *   1. Ensures one `mobile_money` account per provider (MTN, Airtel by
 *      default), and a `current_asset` Card Clearing account when the
 *      `card_clearing` mapping is unset.
 *   2. Points the `mobile_money` and `card_clearing` AccountMapping rows at
 *      them. These are the fallbacks `resolveTenderAccount` uses when a tender
 *      arrives with no explicit accountId (offline replay, Android, API
 *      clients), so they must exist even though configured tiles always send one.
 *   3. Inserts the PosPaymentMethod rows: cash (no account — the register's own
 *      drawer wins at post time), one per wallet provider, card → clearing, and
 *      one per active bank account.
 *
 * Existing rows are never overwritten: an account matched by code, a mapping
 * already pointed somewhere, or a method code already present is left alone.
 *
 * Dry run by default; pass --apply to write.
 *   --org <id>              limit to one organisation
 *   --providers MTN,Airtel  wallet providers to create (default MTN,Airtel)
 */

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const arg = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes('--apply');
const ONLY_ORG = arg('--org');
const PROVIDERS = (arg('--providers') ?? 'MTN,Airtel').split(',').map((p) => p.trim()).filter(Boolean);

/** Account codes used when a wallet / clearing account has to be created. */
const WALLET_CODE_BASE = 1121;
const CLEARING_CODE = '1131';

type Plan = { kind: 'account' | 'mapping' | 'method'; detail: string; run: (tx: any) => Promise<void> };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** What the provider's wallet is actually called on the street. */
const walletLabel = (provider: string) =>
  /mtn/i.test(provider) ? `${provider} MoMo` : `${provider} Money`;

async function categoryId(key: string) {
  const category = await prisma.accountCategory.findFirst({ where: { key } });
  if (!category) throw new Error(`Account category '${key}' is missing — run prisma/backfill-account-category.ts first`);
  return category;
}

async function planOrg(organizationId: string, orgName: string) {
  const plans: Plan[] = [];
  const log: string[] = [];
  const now = new Date();

  const [walletCat, clearingCat] = await Promise.all([categoryId('mobile_money'), categoryId('current_asset')]);
  const accounts = await prisma.account.findMany({
    where: { organizationId, isActive: true, deletedAt: null },
    include: { category: true },
    orderBy: { code: 'asc' },
  });
  const mappings = await prisma.accountMapping.findMany({ where: { organizationId } });
  const existingMethods = await prisma.posPaymentMethod.findMany({ where: { organizationId, deletedAt: null } });
  const methodCodes = new Set(existingMethods.map((m) => m.code));
  const byCode = new Map(accounts.map((a) => [a.code, a]));

  /** Resolve an account, queueing its creation when it does not exist yet. */
  const ensureAccount = (code: string, name: string, category: { id: string; normalBalance: any }) => {
    const found = byCode.get(code);
    if (found) { log.push(`  account ${code} ${found.name} — exists`); return found.id; }
    const id = randomUUID();
    log.push(`  account ${code} ${name} — CREATE`);
    plans.push({
      kind: 'account', detail: `${code} ${name}`,
      run: async (tx) => {
        await tx.account.create({
          data: {
            id, organizationId, code, name, categoryId: category.id, normalBalance: category.normalBalance,
            cashFlowCategory: 'operating', isActive: true,
          },
        });
      },
    });
    return id;
  };

  const ensureMapping = (key: string, accountId: string) => {
    const existing = mappings.find((m) => m.key === key);
    if (existing?.accountId) { log.push(`  mapping ${key} — already set`); return; }
    log.push(`  mapping ${key} — SET`);
    plans.push({
      kind: 'mapping', detail: key,
      run: async (tx) => {
        await tx.accountMapping.upsert({
          where: { organizationId_key: { organizationId, key } },
          update: { accountId },
          create: { organizationId, key, accountId },
        });
      },
    });
  };

  const ensureMethod = (data: {
    code: string; label: string; kind: string; provider?: string | null; accountId?: string | null;
    sortOrder: number; requiresReference: boolean; trackInShift: boolean;
  }) => {
    if (methodCodes.has(data.code)) { log.push(`  method ${data.code} — exists`); return; }
    methodCodes.add(data.code);
    log.push(`  method ${data.code} "${data.label}" (${data.kind}) — CREATE`);
    plans.push({
      kind: 'method', detail: `${data.code} ${data.label}`,
      run: async (tx) => {
        await tx.posPaymentMethod.create({
          data: {
            organizationId, code: data.code, label: data.label, kind: data.kind,
            provider: data.provider ?? null, accountId: data.accountId ?? null,
            sortOrder: data.sortOrder, isActive: true,
            requiresReference: data.requiresReference, trackInShift: data.trackInShift,
            createdAt: now, updatedAt: now,
          },
        });
      },
    });
  };

  // 1. Cash — no account: the register's own drawer account wins at post time.
  ensureMethod({ code: 'cash', label: 'Cash', kind: 'cash', sortOrder: 0, requiresReference: false, trackInShift: false });

  // 2. Mobile money, one tile (and one account) per provider.
  let walletMappingTarget: string | null = null;
  PROVIDERS.forEach((provider, i) => {
    const code = String(WALLET_CODE_BASE + i);
    // Reuse an existing wallet account with the provider's name before making one.
    const named = accounts.find((a) => a.category?.key === 'mobile_money' && a.name.toLowerCase().includes(provider.toLowerCase()));
    const accountId = named ? named.id : ensureAccount(code, `Mobile Money — ${provider}`, walletCat);
    if (named) log.push(`  account ${named.code} ${named.name} — matched provider ${provider}`);
    walletMappingTarget ??= accountId;
    ensureMethod({
      code: `momo_${slug(provider)}`, label: walletLabel(provider), kind: 'mobile_money', provider,
      accountId, sortOrder: i, requiresReference: false, trackInShift: true,
    });
  });
  if (walletMappingTarget) ensureMapping('mobile_money', walletMappingTarget);

  // 3. Card — the clearing account, creating one only when nothing is mapped.
  const mappedClearing = mappings.find((m) => m.key === 'card_clearing')?.accountId;
  const clearingId = mappedClearing ?? ensureAccount(CLEARING_CODE, 'Card Clearing', clearingCat);
  ensureMapping('card_clearing', clearingId);
  ensureMethod({
    code: 'card', label: 'Card', kind: 'card', accountId: clearingId,
    sortOrder: 0, requiresReference: false, trackInShift: true,
  });

  // 4. One tile per existing bank account (bank transfer / deposit at the till).
  accounts.filter((a) => a.category?.key === 'bank').forEach((bank, i) => {
    ensureMethod({
      code: `bank_${slug(bank.code)}`, label: bank.name, kind: 'bank', provider: bank.bankName ?? null,
      accountId: bank.id, sortOrder: i, requiresReference: false, trackInShift: true,
    });
  });

  return { organizationId, orgName, plans, log };
}

async function main() {
  const orgs = await prisma.organization.findMany({
    where: ONLY_ORG ? { id: ONLY_ORG } : {},
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  if (!orgs.length) throw new Error('No organisations matched');

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — providers: ${PROVIDERS.join(', ')}\n`);
  let total = 0;
  for (const org of orgs) {
    const result = await planOrg(org.id, org.name);
    console.log(`${org.name} (${org.id})`);
    result.log.forEach((l) => console.log(l));
    if (!result.plans.length) { console.log('  nothing to do\n'); continue; }
    total += result.plans.length;
    if (APPLY) {
      // Accounts must land before the mappings and methods that reference them,
      // which is the order they were queued in.
      await prisma.$transaction(async (tx) => { for (const plan of result.plans) await plan.run(tx); });
      console.log(`  applied ${result.plans.length} change(s)\n`);
    } else {
      console.log(`  ${result.plans.length} change(s) pending\n`);
    }
  }

  console.log(APPLY
    ? `Done. ${total} change(s) written.`
    : `Dry run complete. ${total} change(s) pending — re-run with --apply to write.`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
