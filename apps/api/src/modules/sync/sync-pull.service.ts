import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { SYNC_PULL_SCOPES, type SyncPullScope } from './dto/sync.dto';
import { terminalPaymentMethods } from '../accounting/treasury/pos-payment-method.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * P1 offline sync — incremental pull.
 *
 * Cursor = opaque base64(JSON) with one ISO watermark per scope, computed from
 * the SERVER clock only (device clocks never participate). Each scope returns
 * rows with `updatedAt > watermark - overlap`; the 5s overlap re-sends rows
 * committed around the watermark, which is harmless because clients upsert by
 * id. Rows with `deletedAt != null` are tombstones — the client deletes them
 * locally. MenuItem is pulled as a full aggregate (variants, modifier links,
 * accompaniments) so child edits without their own updatedAt still reach the
 * device once the parent is touched.
 */
@Injectable()
export class SyncPullService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  private static readonly OVERLAP_MS = 5_000;
  /** Messages page size (append-only, high-volume — must be bounded). */
  private static readonly MESSAGE_PAGE = 200;
  /**
   * Commit-lag hold-back for the seq cursor. BIGSERIAL is assigned at INSERT but
   * visible at COMMIT, so txn B(seq=101) can commit before txn A(seq=100) — a
   * cursor advanced to 101 would skip 100 forever. We only advance the cursor
   * past rows older than this window; newer rows are still RETURNED (the device
   * upserts by id, so redelivery is free). Correct as long as no Message insert
   * stays open longer than this — single-row inserts always do.
   */
  private static readonly SEQ_COMMIT_LAG_MS = 2_000;

  async pull(cursorRaw: string | undefined, scopesRaw: string | undefined) {
    const scopes = this.parseScopes(scopesRaw);
    const cursor = this.parseCursor(cursorRaw);
    // The next watermark is stamped BEFORE reading so writes that land during
    // the read are re-delivered on the next pull instead of being skipped.
    const serverTime = new Date();

    const data: Record<string, unknown[]> = {};
    const nextCursor: Record<string, string> = { ...cursor };

    for (const scope of scopes) {
      // `messages` uses a monotonic seq cursor, not the time watermark — see
      // readMessagesPaged. Everything else is time-based.
      if (scope === 'messages') {
        const { rows, nextSeq, hasMore } = await this.readMessagesPaged(cursor.messagesSeq);
        data.messages = rows;
        nextCursor.messagesSeq = nextSeq;
        nextCursor.messagesHasMore = hasMore ? '1' : '0';
        continue;
      }
      const since = cursor[scope]
        ? new Date(new Date(cursor[scope]).getTime() - SyncPullService.OVERLAP_MS)
        : undefined;
      data[scope] = await this.readScope(scope, since);
      nextCursor[scope] = serverTime.toISOString();
    }

    return {
      data,
      cursor: Buffer.from(JSON.stringify(nextCursor), 'utf8').toString('base64url'),
      serverTime: serverTime.toISOString(),
    };
  }

  /**
   * A seq-ordered page of device-visible messages. Only conversations flagged
   * `syncToDevices` (channels, never DMs/customer threads) are included — a
   * shared till must not hold private conversations. `syncSequence` is emitted as
   * a string (BigInt is not JSON-serializable).
   */
  private async readMessagesPaged(
    sinceSeqRaw: string | undefined,
  ): Promise<{ rows: unknown[]; nextSeq: string; hasMore: boolean }> {
    const c = this.prisma.client as any;
    const sinceSeq = sinceSeqRaw ? BigInt(sinceSeqRaw) : 0n;
    const rows: any[] = await c.message.findMany({
      where: {
        seq: { gt: sinceSeq },
        deletedAt: null,
        conversation: { syncToDevices: true, deletedAt: null },
      },
      orderBy: { seq: 'asc' },
      take: SyncPullService.MESSAGE_PAGE,
      select: {
        id: true,
        conversationId: true,
        senderType: true,
        senderUserId: true,
        body: true,
        contentType: true,
        occurredAt: true,
        seq: true,
        createdAt: true,
      },
    });

    // Advance the cursor only past rows old enough that no concurrent insert can
    // still be holding a lower, uncommitted seq. Newer rows are returned now and
    // re-arrive next pull (free — the device upserts by id).
    const safeBefore = Date.now() - SyncPullService.SEQ_COMMIT_LAG_MS;
    const safe = rows.filter((r) => r.createdAt.getTime() < safeBefore);
    const nextSeq = (safe.length > 0 ? safe[safe.length - 1].seq : sinceSeq).toString();

    const serialized = rows.map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      senderType: r.senderType,
      senderUserId: r.senderUserId,
      body: r.body,
      contentType: r.contentType,
      occurredAt: r.occurredAt.toISOString(),
      syncSequence: r.seq.toString(),
    }));
    return { rows: serialized, nextSeq, hasMore: rows.length === SyncPullService.MESSAGE_PAGE };
  }

  private parseScopes(raw: string | undefined): SyncPullScope[] {
    if (!raw) return [...SYNC_PULL_SCOPES];
    const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const invalid = requested.filter((s) => !(SYNC_PULL_SCOPES as readonly string[]).includes(s));
    if (invalid.length > 0) {
      throw new BadRequestException(`Unknown sync scope(s): ${invalid.join(', ')}`);
    }
    return requested as SyncPullScope[];
  }

  private parseCursor(raw: string | undefined): Record<string, string> {
    if (!raw) return {};
    try {
      const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      return typeof decoded === 'object' && decoded !== null ? decoded : {};
    } catch {
      throw new BadRequestException('Malformed sync cursor — pull from scratch (omit the cursor)');
    }
  }

  private async readScope(scope: SyncPullScope, since?: Date): Promise<unknown[]> {
    const c = this.prisma.client as any;
    const changed = since ? { updatedAt: { gt: since } } : {};

    switch (scope) {
      case 'menuItems':
        return c.menuItem.findMany({
          where: { ...changed },
          include: {
            variants: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
            modifierGroups: {
              where: { deletedAt: null },
              orderBy: { sortOrder: 'asc' },
              include: {
                modifierGroup: {
                  include: { modifiers: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } } },
                },
              },
            },
            accompanimentGroups: {
              where: { deletedAt: null },
              orderBy: { sortOrder: 'asc' },
              include: {
                accompanimentGroup: {
                  include: { options: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } } },
                },
              },
            },
          },
          orderBy: { updatedAt: 'asc' },
        });
      case 'menuCategories':
        return c.menuCategory.findMany({ where: { ...changed }, orderBy: { updatedAt: 'asc' } });
      case 'modifierGroups':
        return c.modifierGroup.findMany({
          where: { ...changed },
          include: { modifiers: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } } },
          orderBy: { updatedAt: 'asc' },
        });
      case 'taxes':
        return c.tax.findMany({ where: { ...changed }, orderBy: { updatedAt: 'asc' } });
      case 'posTables':
        return c.posTable.findMany({ where: { ...changed }, orderBy: { updatedAt: 'asc' } });
      case 'cashRegisters':
        return c.cashRegister.findMany({ where: { ...changed }, orderBy: { updatedAt: 'asc' } });
      case 'staff':
        // Offline PIN login: the device verifies bcrypt locally against
        // pinHash. Deliberately narrow projection — no password hashes, no
        // emails beyond what receipts/attribution need.
        //
        // Reads through `prisma.raw`, NOT `prisma.client`, and does not filter
        // on isActive. Both of those were revocation holes: the tenancy
        // extension force-injects `deletedAt: null` for User, and the old
        // `isActive: true` filter excluded deactivated accounts — so a
        // suspended or terminated cashier could never appear in a delta. The
        // device kept their bcrypt PIN hash and full permission set forever,
        // and could still take payments offline. Tombstones are the entire
        // point of this scope (see the class doc), so the org is scoped by
        // hand here and revoked rows are allowed through.
        return this.prisma.raw.user
          .findMany({
            where: { organizationId: this.tenant.organizationId, ...changed },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              pinHash: true,
              isActive: true,
              deletedAt: true,
              updatedAt: true,
              roles: { select: { name: true, permissions: true } },
            },
            orderBy: { updatedAt: 'asc' },
          })
          .then((rows) =>
            rows.map((u) => ({
              ...u,
              // Never ship a usable credential for an account that can no
              // longer log in. A device that has not yet applied the tombstone
              // still cannot authenticate the revoked PIN.
              pinHash: u.isActive && !u.deletedAt ? u.pinHash : null,
            })),
          );
      case 'products':
        return c.product.findMany({
          where: { ...changed },
          include: {
            category: { select: { id: true, name: true } },
            uom: { select: { id: true, name: true, code: true } },
            tax: { select: { id: true, rate: true } },
          },
          orderBy: { updatedAt: 'asc' },
        });
      case 'productCategories':
        return c.productCategory.findMany({
          where: { ...changed },
          orderBy: { updatedAt: 'asc' },
        });
      case 'productPackagings':
        // Multipack barcodes: scanning a case barcode adds `quantity` base
        // units of the product. No deletedAt on this model — a deactivated pack
        // (isActive=false) is removed on the device.
        return c.productPackaging.findMany({
          where: { ...changed },
          select: {
            id: true,
            productId: true,
            name: true,
            quantity: true,
            barcode: true,
            isActive: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: 'asc' },
        });
      case 'settings':
        // Push org-level POS + inventory settings to devices (inventory toggles
        // like negative-stock affect the terminal). Scoped overrides stay server-side.
        return c.setting.findMany({
          where: {
            ...changed,
            scopeType: 'organization',
            OR: [{ key: { startsWith: 'pos.' } }, { key: { startsWith: 'inventory.' } }],
          },
          orderBy: { updatedAt: 'asc' },
        });
      case 'partners':
        // Customers only — suppliers/employees never reach POS devices.
        // Loyalty rides in customFields.loyaltyPoints (no dedicated column).
        return c.partner.findMany({
          where: { ...changed, isCustomer: true },
          select: {
            id: true,
            code: true,
            name: true,
            phone: true,
            email: true,
            notes: true,
            customFields: true,
            createdAt: true,
            updatedAt: true,
            deletedAt: true,
          },
          orderBy: { updatedAt: 'asc' },
        });
      case 'conversations':
        // Device-visible conversations only — `syncToDevices` is settable solely
        // on kind='channel', so DMs and customer threads never reach a shared
        // till. Master-data-shaped (has updatedAt), so the time watermark applies.
        return c.conversation.findMany({
          where: { ...changed, syncToDevices: true },
          select: {
            id: true,
            kind: true,
            name: true,
            contextType: true,
            contextId: true,
            updatedAt: true,
            deletedAt: true,
          },
          orderBy: { updatedAt: 'asc' },
        });
      case 'messages':
        // Handled by readMessagesPaged (seq cursor) — never reached via readScope.
        return [];
      // ---- Cash & inventory reference data: full snapshots, `since` ignored ----
      case 'paymentMethods':
        return terminalPaymentMethods(c, this.tenant.organizationId);
      case 'ledgerAccounts':
        return this.readLedgerAccounts();
      case 'expenseCategories':
        return this.readExpenseCategories();
      case 'stockLocations':
        return c.inventoryLocation.findMany({
          where: { organizationId: this.tenant.organizationId, isActive: true, deletedAt: null, type: { not: 'transit' } },
          select: { id: true, code: true, name: true, type: true },
          orderBy: { code: 'asc' },
        });
      // ---- Inventory deltas ----
      case 'stockLevels':
        return c.stockItem
          .findMany({
            where: { organizationId: this.tenant.organizationId, ...changed },
            select: { id: true, productId: true, variantId: true, locationId: true, quantity: true, updatedAt: true },
            orderBy: { updatedAt: 'asc' },
          })
          .then((rows: any[]) => rows.map((r) => ({ ...r, quantity: Number(r.quantity) })));
      case 'suppliers':
        return c.partner.findMany({
          where: { organizationId: this.tenant.organizationId, ...changed, isSupplier: true },
          select: { id: true, name: true, phone: true, notes: true, updatedAt: true, deletedAt: true },
          orderBy: { updatedAt: 'asc' },
        });
      case 'reservations':
        // Upcoming/active bookings for the floor. A rolling 24h floor bounds the
        // backfill; the device treats terminal statuses (cancelled/no_show/
        // completed) as tombstones and drops them locally.
        return c.posTableReservation.findMany({
          where: { ...changed, startAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
          select: {
            id: true,
            tableId: true,
            customerName: true,
            phone: true,
            partySize: true,
            startAt: true,
            endAt: true,
            status: true,
            notes: true,
            seatedOrderId: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: 'asc' },
        });
      default:
        return [];
    }
  }

  /**
   * Every account a device may book cash against, with the roles the till
   * needs to pick the right one offline:
   *   - `drawer`: a register's cash account (the device matches it to its register);
   *   - `cash_short_over`: the only valid counterpart of a drawer adjustment;
   *   - `float_source`: a safe/bank that may fund an opening float;
   *   - `pay_in` / `pay_out`: the same eligibility `assertMovementCounterpart` enforces.
   * Cash-equivalent rows carry their ledger balance so the device can pre-check
   * the opening-float rule (count vs drawer ledger) and payout sufficiency.
   */
  private async readLedgerAccounts(): Promise<unknown[]> {
    const c = this.prisma.client as any;
    // Explicit organization filters on top of the tenancy extension: this data
    // steers where a till books money, so it must never cross a tenant.
    const organizationId = this.tenant.organizationId;
    const [accounts, registers, mappings] = await Promise.all([
      c.account.findMany({
        where: { organizationId, isActive: true, deletedAt: null, isPostable: true },
        select: {
          id: true, code: true, name: true,
          category: { select: { key: true, classification: true, isCashEquivalent: true } },
        },
        orderBy: { code: 'asc' },
      }),
      c.cashRegister.findMany({ where: { organizationId, deletedAt: null }, select: { defaultAccountId: true } }),
      c.accountMapping.findMany({ where: { organizationId, key: { in: ['cash_short_over', 'default_expense'] } }, select: { key: true, accountId: true } }),
    ]);
    const drawers = new Set<string>(registers.map((r: any) => r.defaultAccountId));
    const mappedRoles = new Map<string, string[]>();
    for (const m of mappings as any[]) {
      if (!m.accountId) continue;
      mappedRoles.set(m.accountId, [...(mappedRoles.get(m.accountId) ?? []), m.key]);
    }
    const cashIds = accounts.filter((a: any) => a.category?.isCashEquivalent).map((a: any) => a.id);
    const balances = cashIds.length
      ? await c.journalLine.groupBy({
          by: ['accountId'],
          where: { organizationId, accountId: { in: cashIds }, entry: { status: { in: ['posted', 'reversed'] } } },
          _sum: { baseDebit: true, baseCredit: true },
        })
      : [];
    const balance = new Map<string, number>(
      balances.map((b: any) => [b.accountId, Number(b._sum.baseDebit ?? 0) - Number(b._sum.baseCredit ?? 0)]),
    );

    const out: unknown[] = [];
    for (const a of accounts as any[]) {
      const key = a.category?.key ?? null;
      const classification = a.category?.classification ?? null;
      const cashEq = !!a.category?.isCashEquivalent;
      const isDrawer = drawers.has(a.id);
      const roles = [...(mappedRoles.get(a.id) ?? [])];
      if (isDrawer) roles.push('drawer');
      if (!isDrawer) {
        if (cashEq && ['cash', 'petty_cash', 'bank'].includes(key)) roles.push('float_source');
        if (cashEq || ['equity', 'liability'].includes(classification)) roles.push('pay_in');
        if (cashEq || ['expense', 'liability', 'equity'].includes(classification)) roles.push('pay_out');
        if (cashEq) roles.push('expense_payment');
      }
      // Revenue/receivable accounts are never valid for a device; skip rows with no role.
      if (!roles.length) continue;
      out.push({
        id: a.id, code: a.code, name: a.name,
        categoryKey: key, classification, isCashEquivalent: cashEq,
        balance: cashEq ? (balance.get(a.id) ?? 0) : null,
        roles,
      });
    }
    return out;
  }

  /**
   * Active expense categories with the GL account a drawer pay-out for them
   * must debit — resolved exactly as ExpensesService does (category ledger,
   * else the first postable expense account), so a till expense and a back-office
   * expense of the same category hit the same account.
   */
  private async readExpenseCategories(): Promise<unknown[]> {
    const c = this.prisma.client as any;
    const organizationId = this.tenant.organizationId;
    const [categories, validExpense, mapping, fallback] = await Promise.all([
      c.expenseCategory.findMany({
        where: { organizationId, isActive: true, deletedAt: null },
        select: { id: true, name: true, ledgerAccountId: true },
        orderBy: { name: 'asc' },
      }),
      c.account.findMany({
        where: { organizationId, isPostable: true, isActive: true, category: { classification: 'expense' } },
        select: { id: true },
      }),
      c.accountMapping.findFirst({ where: { organizationId, key: 'default_expense' }, select: { accountId: true } }),
      c.account.findFirst({
        where: { organizationId, category: { classification: 'expense' }, isPostable: true, isActive: true, deprecatedAt: null },
        select: { id: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
    ]);
    const valid = new Set<string>(validExpense.map((a: any) => a.id));
    const orgDefault = mapping?.accountId ?? fallback?.id ?? null;
    return categories.map((cat: any) => ({
      ...cat,
      accountId: cat.ledgerAccountId && valid.has(cat.ledgerAccountId) ? cat.ledgerAccountId : orgDefault,
    }));
  }
}
