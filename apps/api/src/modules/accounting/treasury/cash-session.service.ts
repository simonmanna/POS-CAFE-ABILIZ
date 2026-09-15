import { accountLedgerBalance, accountObservations, reconcileSession, sessionProviderExpectations, settleTender } from './session-reconciliation';
import { lockFloorExclusive } from '../../pos/table-status.util';
import { assertNotDrawerAccount, lockAccounts, operationId, requireAccount } from './treasury-guards';
import { terminalPaymentMethods } from './pos-payment-method.service';
import { recordBusinessOutcome } from '../../../kernel/idempotency/business-outcome';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { dec, ZERO } from '../../../kernel/common/money';
import { resolveOccurredAt } from '../../../kernel/common/occurred-at';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { AuditService } from '../../../kernel/audit/audit.service';
import { PasswordService } from '../../../kernel/auth/password.service';
import { PostingService } from '../../accounting/posting/posting.service';
import { AccountDeterminationService } from '../../accounting/posting/account-determination.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OpenSessionDto {
  openingSourceAccountId?: string;
  openingAccounts?: Record<string, number>;
  cashRegisterId: string;
  openingFloat?: number | string;
  notes?: string;
  openingDenomination?: Record<string, number>;
  /** Offline-first: when the drawer was actually opened on the device. */
  occurredAt?: string;
}

export interface CloseSessionDto {
  closingAccounts?: Record<string, number>;
  /** Tracked tender accounts deliberately not counted: accountId → reason. Needs manager approval. */
  uncountedAccounts?: Record<string, string>;
  pendingSyncCount?: number;
  closingCounted: number | string;
  notes?: string;
  varianceReason?: string;
  varianceStatus?: string;
  /** Manager who approves a large variance. Required over threshold. */
  approvedById?: string;
  approverEmail?: string;
  managerPin?: string;
  closingDenomination?: Record<string, number>;
  /** Offline-first: when the drawer was actually closed on the device. */
  occurredAt?: string;
  /** Optional session ID to close a session opened by another cashier on a shared terminal. */
  sessionId?: string;
}

export interface RecordMovementDto {
  counterpartAccountId?: string;
  /** Adjustment that corrects an earlier, already-closed shift. */
  correctionOfSessionId?: string;
  movementType: 'pay_in' | 'pay_out' | 'adjustment';
  amount: number | string;
  reason?: string;
  /** Offline-first: when the movement actually happened on the device. */
  occurredAt?: string;
  /** For pay_out (cash leaving the drawer): approving manager + PIN. */
  approvedById?: string;
  approverEmail?: string;
  managerPin?: string;
}

export interface BankDepositDto {
  destinationAccountId?: string;
  amount: number | string;
  bankName: string;
  reference?: string;
  remainingFloat?: number | string;
  notes?: string;
}

export interface VarianceUpdateDto {
  reason: string;
  status?: 'pending_review' | 'approved' | 'rejected';
  approvedById?: string;
}

export interface DailyReconciliationRow {
  sessionId: string;
  cashRegisterName: string;
  cashierName: string;
  openedAt: Date;
  closedAt: Date | null;
  openingFloat: string;
  salesTotal: string;
  payInsTotal: string;
  payOutsTotal: string;
  refundsTotal: string;
  expectedCash: string;
  actualCash: string | null;
  variance: string | null;
  varianceReason: string | null;
  bankedAmount: string | null;
}

/** Offset (ms) of an IANA time zone at a given instant. */
function tzOffsetMs(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour === '24' ? '0' : map.hour), Number(map.minute), Number(map.second),
  );
  return asUTC - date.getTime();
}

/** UTC instants bounding a calendar day (YYYY-MM-DD) in the given time zone. */
function zonedDayRange(dateStr: string, timeZone: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) throw new BadRequestException('Invalid date — expected YYYY-MM-DD');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const startGuess = Date.UTC(y, mo - 1, d, 0, 0, 0);
  const start = new Date(startGuess - tzOffsetMs(timeZone, new Date(startGuess)));
  const endGuess = Date.UTC(y, mo - 1, d + 1, 0, 0, 0);
  const end = new Date(endGuess - tzOffsetMs(timeZone, new Date(endGuess)));
  return { start, end };
}

/**
 * CashSessionService — opens / closes a cashier shift and records every
 * in/out during the shift. M5 foundation for POS and School canteen.
 *
 * Each open session knows its cash register, its opening float, the user
 * (cashier) running it. Cash movements link to Payment rows for sales /
 * refunds so the session reconciles with the ledger at close.
 *
 * Every cash movement, bank deposit, and closing variance also posts to the
 * general ledger (double-entry) inside the SAME transaction as the drawer
 * write, so the books never diverge from the till. The register's own cash GL
 * account (`CashRegister.defaultAccountId`) is the cash leg. GL posting is
 * best-effort: a missing account mapping is logged + audited rather than
 * trapping the cashier — the entry can be back-filled once mappings exist.
 */
@Injectable()
export class CashSessionService {
  private readonly logger = new Logger('CashSessionService');

  /**
   * Variance at or above this (absolute, base currency) requires manager sign-off
   * at close time. Configurable via CASH_VARIANCE_APPROVAL_THRESHOLD.
   */
  private readonly largeVarianceThreshold: Prisma.Decimal;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly password: PasswordService,
    private readonly posting: PostingService,
    private readonly determination: AccountDeterminationService,
  ) {
    const raw = Number(process.env.CASH_VARIANCE_APPROVAL_THRESHOLD ?? '');
    this.largeVarianceThreshold = dec(Number.isFinite(raw) && raw > 0 ? raw : 20000);
  }

  /** Open a new session. Fails if there is already an open session for this register. */
  async open(dto: OpenSessionDto) {
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    if (!userId) throw new BadRequestException('No user in tenant context');
    this.assertDenominationTotal(dto.openingDenomination, dto.openingFloat ?? 0, 'opening float');

    return this.prisma.client.$transaction(async (tx: any) => {
      const register = await tx.cashRegister.findFirst({ where: { id: dto.cashRegisterId, organizationId } });
      if (!register || !register.isActive) throw new NotFoundException('Active cash register not found');
      if (!dec(dto.openingFloat ?? 0).isFinite() || dec(dto.openingFloat ?? 0).lt(0)) throw new BadRequestException('Invalid counted opening float');

      // Lock the register row (always exists) to serialize concurrent open()
      // calls for this register. Prevents two requests from both seeing
      // "no open session" and creating duplicate sessions.
      await tx.$queryRawUnsafe(
        'SELECT id FROM "CashRegister" WHERE "id" = $1 AND "organizationId" = $2 FOR UPDATE',
        dto.cashRegisterId, organizationId,
      );

      const existing = await tx.cashSession.findFirst({
        where: { organizationId, cashRegisterId: dto.cashRegisterId, status: 'open' },
      });
      if (existing) {
        throw new BadRequestException(`A session is already open on register ${register.code}`);
      }

      // Every drawer must have its own cash account; a count is not an accounting entry.
      const drawer = await tx.account.findFirst({ where: { id: register.defaultAccountId, organizationId, isActive: true, deletedAt: null }, include: { category: true } });
      if (!drawer || !['cash', 'petty_cash'].includes(drawer.category?.key)) throw new BadRequestException('Configure an active drawer cash account before opening');
      const shared = await tx.cashRegister.count({ where: { organizationId, id: { not: register.id }, isActive: true, defaultAccountId: drawer.id } });
      if (shared) throw new BadRequestException('Each register needs a distinct drawer cash account');
      await tx.$queryRawUnsafe('SELECT id FROM "Account" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', drawer.id, organizationId);
      const ledger = await accountLedgerBalance(tx, organizationId, drawer.id);
      const funding = dec(dto.openingFloat ?? 0).minus(ledger);
      if (funding.lt(0)) throw new BadRequestException('Opening count is below the drawer ledger. Reconcile the prior count or record the removal before opening');
      if (funding.gt(0)) {
        if (!dto.openingSourceAccountId || !dto.notes?.trim()) throw new BadRequestException('Choose the source of added float and enter its reason');
        const source = await tx.account.findFirst({ where: { id: dto.openingSourceAccountId, organizationId, isActive: true, deletedAt: null }, include: { category: true } });
        if (!source || source.id === drawer.id || !['cash', 'petty_cash', 'bank'].includes(source.category?.key)) throw new BadRequestException('Choose a different cash safe or bank funding account');
        await tx.$queryRawUnsafe('SELECT id FROM "Account" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', source.id, organizationId);
        if (funding.gt(await accountLedgerBalance(tx, organizationId, source.id))) throw new BadRequestException('The funding account has insufficient recorded funds');
      }
      const occurredAt = resolveOccurredAt(dto.occurredAt);
      const session = await tx.cashSession.create({
        data: {
          organizationId,
          cashRegisterId: dto.cashRegisterId,
          branchId: register.branchId ?? null,
          drawerAccountId: drawer.id,
          registerLocationId: register.locationId ?? null,
          userId,
          status: 'open',
          openingFloat: dec(dto.openingFloat ?? 0),
          openingAccounts: await accountObservations(tx, organizationId, dto.openingAccounts),
          openingDenomination: this.sanitizeDenomination(dto.openingDenomination),
          notes: dto.notes ?? null,
          ...(occurredAt ? { openedAt: occurredAt } : {}),
        },
      });

      if (funding.gt(0)) await this.posting.post({ journalCode: 'CASH', date: (occurredAt ?? new Date()).toISOString(), description: `Opening float: ${dto.notes}`, sourceType: 'cash_session_opening', sourceId: session.id, postingKey: `cash_session_opening:${session.id}`, lines: [{ accountId: drawer.id, debit: funding.toString() }, { accountId: dto.openingSourceAccountId!, credit: funding.toString() }] }, tx);
      await this.audit.recordInTx(tx, {
        entity: 'CashSession',
        entityId: session.id,
        action: 'create',
        newValues: { cashRegisterId: session.cashRegisterId, openingFloat: session.openingFloat.toString() },
      });

      this.events.publish('cash.session.opened', {
        organizationId,
        sessionId: session.id,
        cashRegisterId: dto.cashRegisterId,
      });

      await recordBusinessOutcome(tx, session, true);
      return session;
    });
  }

  /**
   * Close the caller's own shift. A manager may force-close another cashier's
   * abandoned shift (`force`), with a blind count and a reason; the manager is
   * then the approver. Both paths run the exact same closing validation as a
   * handover, so no door into a closed shift is weaker than another.
   */
  async close(dto: CloseSessionDto, opts: { force?: boolean } = {}) {
    const organizationId = this.tenant.organizationId;
    const actorId = this.tenant.userId;
    if (!actorId) throw new BadRequestException('No user in tenant context');
    const counted = dec(dto.closingCounted);
    if (!counted.isFinite() || counted.isNegative()) throw new BadRequestException('Counted cash cannot be negative');
    this.assertDenominationTotal(dto.closingDenomination, counted, 'closing count');
    if (opts.force) {
      if (!dto.sessionId) throw new BadRequestException('Choose the shift to force-close');
      if (!dto.notes?.trim()) throw new BadRequestException('A reason is required to force-close a shift');
    }

    return this.prisma.client.$transaction(async (tx: any) => {
      const found = dto.sessionId
        ? await tx.cashSession.findFirst({ where: { id: dto.sessionId, organizationId } })
        : await this.requireOpenSession(tx);
      if (!found) throw new NotFoundException('No open cash session');
      if (opts.force) {
        if (found.userId === actorId) throw new ForbiddenException('Close your own shift normally; force-close is for another cashier\'s shift');
      } else if (found.userId !== actorId) {
        throw new ForbiddenException('Only the session cashier can close this shift; a manager can force-close it');
      }
      const session = await this.lockOpenSession(tx, found.id);

      // A-012: the client-asserted pendingSyncCount stays, but the SERVER also
      // counts unresolved offline ops in this org.
      if ((dto.pendingSyncCount ?? 0) > 0) throw new BadRequestException('Sync or resolve pending device operations before closing');
      const openDeadLetters = await tx.syncOpDeadLetter.count({ where: { organizationId, status: 'open' } });
      if (openDeadLetters > 0) {
        throw new BadRequestException(`${openDeadLetters} unresolved offline operation(s) must be synced or resolved before closing this shift`);
      }

      const closing = await this.validateClosing(tx, session, {
        counted,
        closingAccounts: dto.closingAccounts,
        uncountedAccounts: dto.uncountedAccounts,
        varianceReason: dto.varianceReason,
        approval: opts.force
          ? { verifiedManagerId: actorId }
          : { approverId: dto.approvedById, approverEmail: dto.approverEmail, managerPin: dto.managerPin },
      });

      const closedAt = resolveOccurredAt(dto.occurredAt) ?? new Date();
      const notes = opts.force ? `${session.notes ? session.notes + ' | ' : ''}Force-closed by manager: ${dto.notes!.trim()}` : (dto.notes ?? session.notes);
      await this.finishClosing(tx, session, closing, {
        counted, closedAt, notes, closingDenomination: dto.closingDenomination,
        audit: { kind: opts.force ? 'force_close' : 'close', actorId },
      });

      this.events.publish('cash.session.closed', {
        organizationId,
        sessionId: session.id,
        expected: closing.expected.toString(),
        counted: counted.toString(),
        variance: closing.difference.toString(),
      });

      const result = await tx.cashSession.findFirst({ where: { id: session.id } });
      await recordBusinessOutcome(tx, result, true);
      return result;
    });
  }

  /**
   * Shift handover — atomically close the open session on a register (with the
   * outgoing cashier's blind count, tracked-tender observations and variance)
   * and open a fresh session for the incoming cashier, carrying the counted cash
   * forward as the opening float. PINs are verified by PosShiftService; this
   * enforces segregation of duties and the same closing rules as `close()`.
   */
  async handover(dto: {
    cashRegisterId: string;
    closingCounted: number | string;
    incomingUserId: string;
    varianceReason?: string;
    openingFloat?: number | string;
    notes?: string;
    approvedById?: string;
    closingDenomination?: Record<string, number>;
    closingAccounts?: Record<string, number>;
    uncountedAccounts?: Record<string, string>;
  }) {
    const organizationId = this.tenant.organizationId;
    const counted = dec(dto.closingCounted);
    if (!counted.isFinite() || counted.lt(0)) throw new BadRequestException('Counted cash cannot be negative');
    this.assertDenominationTotal(dto.closingDenomination, counted, 'closing count');
    const opening = dto.openingFloat != null ? dec(dto.openingFloat) : counted;
    if (!opening.eq(counted)) throw new BadRequestException('Handover must carry the counted physical cash; record float changes as a separate movement');
    if (!dto.approvedById) throw new BadRequestException('A manager must approve the handover');

    return this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe('SELECT id FROM "CashRegister" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', dto.cashRegisterId, organizationId);
      const found = await tx.cashSession.findFirst({
        where: { organizationId, cashRegisterId: dto.cashRegisterId, status: 'open' },
      });
      if (!found) throw new NotFoundException('No open session on this register');
      const outgoing = await this.lockOpenSession(tx, found.id);
      if (dto.incomingUserId === outgoing.userId) throw new BadRequestException('The incoming cashier must be a different person');
      if (dto.approvedById === outgoing.userId || dto.approvedById === dto.incomingUserId) {
        throw new ForbiddenException('The approving manager must be neither the outgoing nor the incoming cashier');
      }
      const incomingUser = await tx.user.findFirst({ where: { id: dto.incomingUserId, organizationId, isActive: true } });
      if (!incomingUser) throw new BadRequestException('Incoming cashier not found');

      const closing = await this.validateClosing(tx, outgoing, {
        counted,
        closingAccounts: dto.closingAccounts,
        uncountedAccounts: dto.uncountedAccounts,
        varianceReason: dto.varianceReason,
        approval: { verifiedManagerId: dto.approvedById! },
      });
      await this.finishClosing(tx, outgoing, closing, {
        counted, closedAt: new Date(), notes: outgoing.notes, closingDenomination: dto.closingDenomination,
        audit: { kind: 'handover_out', actorId: this.tenant.userId ?? null, incomingUserId: dto.incomingUserId },
      });

      const incoming = await tx.cashSession.create({
        data: {
          organizationId,
          cashRegisterId: outgoing.cashRegisterId,
          drawerAccountId: outgoing.drawerAccountId ?? null,
          registerLocationId: outgoing.registerLocationId ?? null,
          branchId: outgoing.branchId ?? null,
          userId: dto.incomingUserId,
          status: 'open',
          openingFloat: opening,
          // The wallets carry over exactly like the drawer: what the outgoing
          // cashier observed is where the incoming shift's expectation starts.
          openingAccounts: Object.fromEntries(Object.entries(closing.closingAccounts).filter(([, row]: [string, any]) => !row.notCounted)
            .map(([id, row]: [string, any]) => [id, { accountId: id, code: row.code, name: row.name, accountType: row.accountType, observed: row.observed, ledger: row.ledger, carriedFromSessionId: outgoing.id }])),
          openingDenomination: this.sanitizeDenomination(dto.closingDenomination),
          notes: dto.notes ?? `Opened by handover from session ${outgoing.id}`,
        },
      });

      await this.audit.recordInTx(tx, {
        entity: 'CashSession',
        entityId: incoming.id,
        action: 'create',
        newValues: {
          kind: 'handover_in',
          handoverFromSessionId: outgoing.id,
          userId: dto.incomingUserId,
          openingFloat: opening.toString(),
          approvedById: dto.approvedById,
        },
      });

      this.events.publish('cash.session.handover' as any, {
        organizationId,
        outgoingSessionId: outgoing.id,
        incomingSessionId: incoming.id,
        cashRegisterId: outgoing.cashRegisterId,
        incomingUserId: dto.incomingUserId,
        variance: closing.difference.toString(),
      });

      const result = {
        outgoingSessionId: outgoing.id,
        incomingSessionId: incoming.id,
        expected: closing.expected.toString(),
        counted: counted.toString(),
        variance: closing.difference.toString(),
      };
      await recordBusinessOutcome(tx, result, true);
      return result;
    });
  }

  /**
   * The single closing rule set (close, force-close, handover):
   *  - every order settled, every payment/journal consistent with the drawer;
   *  - every tracked tender either observed, or explicitly not counted with a
   *    reason and manager approval;
   *  - electronic balance differences explained and manager-approved;
   *  - a cash variance explained; at/over the threshold approved by a manager
   *    who is not the cashier.
   */
  private async validateClosing(tx: any, session: any, input: {
    counted: Prisma.Decimal;
    closingAccounts?: Record<string, number>;
    uncountedAccounts?: Record<string, string>;
    varianceReason?: string;
    approval: { verifiedManagerId: string } | { approverId?: string; approverEmail?: string; managerPin?: string };
  }) {
    const organizationId = this.tenant.organizationId;
    // Authoritative re-check: whatever the dialog's Check step showed, no order
    // can gain items between this count and the close commit.
    await lockFloorExclusive(tx, organizationId);
    const reconciliation = await reconcileSession(tx, organizationId, session);
    if (reconciliation.openOrderCount) {
      throw new BadRequestException({
        code: 'OPEN_ORDERS',
        message: `${reconciliation.openOrderCount} open order(s) must be settled or voided before closing — resolve unsettled orders first`,
        openOrderCount: reconciliation.openOrderCount,
        openOrders: reconciliation.openOrders,
        reconciliation,
      });
    }
    if (reconciliation.pendingPayments || reconciliation.pendingPostings || reconciliation.issues.length) {
      throw new BadRequestException({ code: 'RECONCILIATION_ISSUES', message: 'Resolve unsettled orders, payments and posting differences before closing', reconciliation });
    }
    let manager: any = null;
    const approve = async (actionLabel: string) => {
      if (manager) return manager;
      if ('verifiedManagerId' in input.approval) {
        const m = await tx.user.findFirst({ where: { id: input.approval.verifiedManagerId, organizationId, isActive: true }, include: { roles: true } });
        if (!m) throw new NotFoundException('Approving manager not found');
        if (m.id === session.userId) throw new ForbiddenException(`The session cashier cannot approve ${actionLabel}`);
        const perms = new Set(m.roles.flatMap((r: any) => r.permissions ?? []));
        if (!perms.has('cash_session:approve_variance')) throw new ForbiddenException('Approver does not hold cash_session:approve_variance');
        manager = m;
      } else {
        manager = await this.assertManagerApproval(tx, { ...input.approval, cashierUserId: session.userId, permission: 'cash_session:approve_variance', actionLabel });
      }
      return manager;
    };

    // A manager acting in person (force-close, handover) must actually be an
    // approver, whether or not anything below needs approving.
    if ('verifiedManagerId' in input.approval) await approve('this shift close');
    const reason = input.varianceReason?.trim() || null;
    // Stored configuration decides which balances are required. The close
    // dialog lists the terminal's accounts (stored or synthesized for an
    // unconfigured org), so any of those may be marked not counted.
    const tracked = await tx.posPaymentMethod.findMany({
      where: { organizationId, isActive: true, deletedAt: null, trackInShift: true, accountId: { not: null } },
      select: { accountId: true, label: true },
    });
    const observed = input.closingAccounts ?? {};
    const uncounted = input.uncountedAccounts ?? {};
    const trackedIds = new Set<string>(
      (await terminalPaymentMethods(tx, organizationId)).filter((m) => m.trackInShift && m.accountId).map((m) => m.accountId as string),
    );
    for (const id of Object.keys(uncounted)) {
      if (!trackedIds.has(id)) throw new BadRequestException({ code: 'TENDER_NOT_COUNTED', message: 'Only tracked tender accounts can be marked as not counted' });
      if (id in observed) throw new BadRequestException({ code: 'TENDER_NOT_COUNTED', message: 'An account cannot be both counted and not counted' });
      if (!String(uncounted[id] ?? '').trim()) throw new BadRequestException({ code: 'TENDER_NOT_COUNTED', message: 'Give a reason for every tender account that was not counted' });
    }
    const missing = tracked.filter((m: any) => !(m.accountId in observed) && !(m.accountId in uncounted));
    if (missing.length) throw new BadRequestException({ code: 'TENDER_NOT_COUNTED', message: `Enter closing balances for: ${missing.map((m: any) => m.label).join(', ')} (or mark them not counted with a reason)` });
    const closingAccounts: Record<string, any> = await accountObservations(tx, organizationId, observed);
    // Compare with what this shift should have left with the provider, not the
    // all-time ledger balance (kept on the row as audit evidence only).
    const expectations = await sessionProviderExpectations(tx, organizationId, session, Object.keys(closingAccounts));
    for (const [id, row] of Object.entries(closingAccounts)) {
      const e = expectations[id];
      Object.assign(row, { ...e, difference: dec(row.observed).minus(e.expected).toString() });
    }
    if (Object.keys(uncounted).length) {
      const m = await approve('uncounted tender balances');
      for (const [id, why] of Object.entries(uncounted)) {
        const account = await tx.account.findFirst({ where: { id, organizationId }, select: { code: true, name: true } });
        closingAccounts[id] = { accountId: id, code: account?.code, name: account?.name, notCounted: true, reason: String(why).trim(), approvedById: m.id };
      }
    }
    const providerDifferences = Object.values(closingAccounts).filter((row: any) => !row.notCounted && !dec(row.difference).isZero());
    if (providerDifferences.length) {
      if (!reason) {
        throw new BadRequestException({
          code: 'PROVIDER_BALANCE_VARIANCE',
          message: 'Explain card, bank or mobile-money balance differences before closing',
          requiresReason: true,
          requiresManagerApproval: true,
          accounts: providerDifferences.map((r: any) => ({ accountId: r.accountId, name: r.name, expected: r.expected, observed: r.observed, difference: r.difference })),
        });
      }
      await approve('electronic tender balance differences');
    }

    const expected = await this.computeExpected(tx, session);
    const difference = input.counted.minus(expected);
    let varianceStatus: string | null = null;
    let approvedById: string | null = manager?.id ?? null;
    if (!difference.isZero()) {
      if (!reason) throw new BadRequestException({ code: 'CASH_VARIANCE_REASON_REQUIRED', message: 'A variance reason is required when counted cash differs from expected' });
      const managerPresent = 'verifiedManagerId' in input.approval;
      if (managerPresent || difference.abs().greaterThanOrEqualTo(this.largeVarianceThreshold)) {
        approvedById = (await approve(managerPresent ? 'the shift variance' : 'a large cash variance')).id;
        varianceStatus = 'approved';
      } else {
        varianceStatus = 'pending_review';
      }
    }
    return { reconciliation, closingAccounts, expected, difference, reason, varianceStatus, approvedById };
  }

  /** Freeze the count, the Z snapshot and the over/short journal. */
  private async finishClosing(tx: any, session: any, closing: any, input: {
    counted: Prisma.Decimal; closedAt: Date; notes: string | null; closingDenomination?: Record<string, number>;
    audit: Record<string, any>;
  }) {
    const organizationId = this.tenant.organizationId;
    const closingByMethod = await this.computeByMethod(tx, organizationId, session.id);
    const updated = await tx.cashSession.updateMany({
      where: { id: session.id, status: 'open' },
      data: {
        status: 'closed',
        closedAt: input.closedAt,
        closingCounted: input.counted,
        closingExpected: closing.expected,
        closingDifference: closing.difference,
        closingDenomination: this.sanitizeDenomination(input.closingDenomination),
        closingByMethod,
        closingAccounts: closing.closingAccounts,
        varianceReason: closing.reason,
        varianceStatus: closing.varianceStatus,
        approvedById: closing.approvedById,
        notes: input.notes,
      },
    });
    if (updated.count === 0) throw new BadRequestException('The register session is no longer open');
    const reportData = JSON.parse(JSON.stringify({
      ...closing.reconciliation.report,
      accounts: closing.reconciliation.accounts,
      openingAccounts: session.openingAccounts,
      closingAccounts: closing.closingAccounts,
      closingDenomination: input.closingDenomination ?? null,
      closingCounted: input.counted.toString(),
      closingExpected: closing.expected.toString(),
      closingDifference: closing.difference.toString(),
      varianceReason: closing.reason,
      varianceStatus: closing.varianceStatus,
      approvedById: closing.approvedById,
      closeKind: input.audit.kind,
    }));
    await tx.posReportSnapshot.create({ data: { organizationId, cashSessionId: session.id, reportData, kind: 'z' } });
    if (!closing.difference.isZero()) await this.postVarianceGl(tx, session, closing.difference);
    await this.audit.recordInTx(tx, {
      entity: 'CashSession',
      entityId: session.id,
      action: 'update',
      oldValues: { status: 'open' },
      newValues: {
        status: 'closed',
        ...input.audit,
        counted: input.counted.toString(),
        expected: closing.expected.toString(),
        closingDifference: closing.difference.toString(),
        varianceReason: closing.reason,
        varianceStatus: closing.varianceStatus,
        approvedById: closing.approvedById,
      },
    });
  }

  /** Record a manual movement (pay-in, pay-out, adjustment). */
  async recordMovement(sessionId: string | undefined, dto: RecordMovementDto) {
    const organizationId = this.tenant.organizationId;
    const amount = dec(dto.amount);

    // Runtime callers (offline sync, tests and internal services) do not pass
    // through class-validator. Keep the financial invariant in the domain too.
    if (!['pay_in', 'pay_out', 'adjustment'].includes(dto.movementType as string)) {
      throw new BadRequestException('Movement type must be pay_in, pay_out or adjustment');
    }

    // H4 — sign rules. pay_in / pay_out must be strictly positive (the type
    // carries the direction). adjustment may be signed but never zero.
    if (!amount.isFinite() || amount.isZero()) throw new BadRequestException('Amount cannot be zero or non-finite');
    if ((dto.movementType === 'pay_in' || dto.movementType === 'pay_out') && amount.isNegative()) {
      throw new BadRequestException(`${dto.movementType} amount must be positive`);
    }

    if (!dto.reason?.trim()) throw new BadRequestException('A reason is required for a cash movement');
    if (!dto.counterpartAccountId) throw new BadRequestException('Select the expense, safe or transfer account for this movement');
    if (dto.correctionOfSessionId && dto.movementType !== 'adjustment') throw new BadRequestException('Corrections to a closed shift are recorded as adjustments');
    return this.prisma.client.$transaction(async (tx: any) => {
      // H2 — resolve to the CALLER's own open session, never an arbitrary one.
      const session = sessionId
        ? await tx.cashSession.findFirst({ where: { id: sessionId, organizationId } })
        : await tx.cashSession.findFirst({ where: { organizationId, userId: this.tenant.userId, status: 'open' } });
      if (!session) throw new NotFoundException('No open cash session');
      await this.lockOpenSession(tx, session.id);
      if (session.status !== 'open') throw new BadRequestException('Session is not open');
      if (session.userId !== this.tenant.userId) {
        throw new ForbiddenException('This cash session belongs to a different cashier');
      }

      if ((dto.movementType === 'pay_out' || amount.isNegative()) && amount.abs().gt(await this.computeExpected(tx, session))) {
        throw new BadRequestException('The drawer does not contain enough cash for this movement');
      }
      await this.assertMovementCounterpart(tx, session, dto.movementType, dto.counterpartAccountId!);
      if (dto.correctionOfSessionId) {
        const corrected = await tx.cashSession.findFirst({ where: { id: dto.correctionOfSessionId, organizationId } });
        if (!corrected || corrected.status === 'open') throw new BadRequestException('Corrections must reference a closed shift');
        if (corrected.id === session.id) throw new BadRequestException('A shift cannot correct itself');
        if (!this.tenant.has('cash_session:correct')) throw new ForbiddenException('Posting a correction to a closed shift requires cash_session:correct');
      }

      // H3 — cash LEAVING the drawer needs manager sign-off.
      if (dto.movementType === 'pay_out' || dto.movementType === 'adjustment') {
        await this.assertManagerApproval(tx, {
          approverId: dto.approvedById,
          approverEmail: dto.approverEmail,
          managerPin: dto.managerPin,
          cashierUserId: session.userId,
          permission: 'cash_session:cash_out',
          actionLabel: dto.movementType === 'adjustment' ? 'a cash adjustment' : 'a cash pay-out',
        });
      }

      const occurredAt = resolveOccurredAt(dto.occurredAt);
      const movement = await tx.cashMovement.create({
        data: {
          organizationId,
          cashSessionId: session.id,
          movementType: dto.movementType,
          amount,
          reason: dto.reason ?? null,
          counterpartAccountId: dto.counterpartAccountId,
          correctionOfSessionId: dto.correctionOfSessionId ?? null,
          performedBy: this.tenant.userId ?? null,
          ...(occurredAt ? { createdAt: occurredAt } : {}),
        },
      });

      // C1 — post the movement to the GL (Dr/Cr register cash vs clearing/over-short).
      await this.postMovementGl(tx, session, dto.movementType, amount, movement.id, dto.reason ?? null, dto.counterpartAccountId);

      await this.audit.recordInTx(tx, {
        entity: 'CashMovement',
        entityId: movement.id,
        action: 'create',
        newValues: {
          cashSessionId: session.id,
          movementType: dto.movementType,
          amount: amount.toString(),
          approvedById: dto.approvedById ?? null,
          correctionOfSessionId: dto.correctionOfSessionId ?? null,
        },
      });

      this.events.publish('cash.movement.recorded', {
        organizationId,
        sessionId: session.id,
        movementId: movement.id,
        movementType: dto.movementType,
        amount: amount.toString(),
      });

      await recordBusinessOutcome(tx, movement, true);
      return movement;
    });
  }

  /** Record a sale or refund against an open session (called from PaymentService). */
  async recordSaleOrRefund(
    tx: any,
    sessionId: string,
    paymentId: string,
    movementType: 'sale' | 'refund' | 'supplier_payment',
    amount: Prisma.Decimal,
  ) {
    await this.lockOpenSession(tx, sessionId);
    return tx.cashMovement.create({
      data: {
        organizationId: this.tenant.organizationId,
        cashSessionId: sessionId,
        movementType,
        amount,
        paymentId,
        performedBy: this.tenant.userId ?? null,
      },
    });
  }

  /**
   * Record a drawer pay-out for cash that physically left the till to settle an
   * external document (e.g. a cash purchase order). The GL leg is owned by the
   * caller's own journal entry (Dr AP / Cr Cash), so this intentionally does NOT
   * call postMovementGl — writing the drawer artifact only, so the session's
   * expected-cash and Z-report reflect the withdrawal without double-crediting
   * cash in the GL. Best-effort: the caller passes a found session or skips.
   */
  async recordExternalPayOut(
    tx: any,
    sessionId: string,
    amount: Prisma.Decimal,
    reason: string,
    journalEntryId: string,
  ) {
    const session = await this.lockOpenSession(tx, sessionId);
    if (amount.gt(await this.computeExpected(tx, session))) throw new BadRequestException('The drawer has insufficient cash for this payout');
    return tx.cashMovement.create({
      data: {
        organizationId: this.tenant.organizationId,
        cashSessionId: sessionId,
        movementType: 'pay_out',
        amount,
        reason,
        journalEntryId,
        performedBy: this.tenant.userId ?? null,
      },
    });
  }

  /** Get any open session on the terminal (or null). */
  async findOpen(cashRegisterId?: string) {
    const where: any = { organizationId: this.tenant.organizationId, status: 'open' };
    if (cashRegisterId) where.cashRegisterId = cashRegisterId;
    else where.userId = this.tenant.userId;
    return this.prisma.client.cashSession.findFirst({
      where,
      include: { cashRegister: true, movements: { orderBy: { createdAt: 'asc' } } },
    });
  }

  /** Read-only expected cash = opening + sales + pay-ins − pay-outs − refunds. */
  async expectedCash(sessionId: string): Promise<Prisma.Decimal> {
    return this.prisma.client.$transaction(async (tx: any) => {
      const session = await tx.cashSession.findFirst({ where: { id: sessionId } });
      if (!session) throw new NotFoundException('Cash session not found');
      return this.computeExpected(tx, session);
    });
  }

  /** Get all movements for a session with payment info (audit trail). */
  async getMovements(sessionId: string) {
    const organizationId = this.tenant.organizationId;
    const session = await this.prisma.client.cashSession.findFirst({
      where: { id: sessionId, organizationId },
      include: {
        cashRegister: { select: { id: true, code: true, name: true } },
        movements: {
          orderBy: { createdAt: 'asc' },
          include: { payment: { select: { paymentMethod: true, amount: true, reference: true } } },
        },
      },
    });
    if (!session) throw new NotFoundException('Cash session not found');

    let rt = dec(session.openingFloat);
    const movementsWithRunning = session.movements.map((m: any) => {
      const amt = dec(m.amount);
      if (m.movementType === 'sale' || m.movementType === 'pay_in' || m.movementType === 'adjustment') {
        rt = rt.plus(amt);
      } else {
        rt = rt.minus(amt);
      }
      return {
        id: m.id,
        movementType: m.movementType,
        amount: amt.toString(),
        reason: m.reason,
        paymentMethod: m.payment?.paymentMethod ?? null,
        paymentReference: m.payment?.reference ?? null,
        performedBy: m.performedBy,
        createdAt: m.createdAt,
        runningTotal: rt.toString(),
      };
    });

    return {
      session: {
        id: session.id,
        cashRegister: session.cashRegister,
        status: session.status,
        openedAt: session.openedAt,
        closedAt: session.closedAt,
        openingFloat: dec(session.openingFloat).toString(),
        closingCounted: session.closingCounted ? dec(session.closingCounted).toString() : null,
        closingExpected: session.closingExpected ? dec(session.closingExpected).toString() : null,
        closingDifference: session.closingDifference ? dec(session.closingDifference).toString() : null,
        notes: session.notes,
        bankedAmount: session.bankedAmount ? dec(session.bankedAmount).toString() : null,
        bankName: session.bankName ?? null,
        varianceReason: session.varianceReason ?? null,
        varianceStatus: session.varianceStatus ?? null,
        approvedById: session.approvedById ?? null,
      },
      movements: movementsWithRunning,
    };
  }

  /** Paginated session history. */
  async history(page = 1, perPage = 20, registerId?: string) {
    const organizationId = this.tenant.organizationId;
    const where: any = { organizationId };
    if (registerId) where.cashRegisterId = registerId;

    const [data, total] = await Promise.all([
      this.prisma.client.cashSession.findMany({
        where,
        include: {
          cashRegister: { select: { id: true, code: true, name: true } },
          _count: { select: { movements: true } },
        },
        orderBy: { openedAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.client.cashSession.count({ where }),
    ]);

    return {
      data: data.map((s: any) => ({
        id: s.id,
        cashRegister: s.cashRegister,
        status: s.status,
        openedAt: s.openedAt,
        closedAt: s.closedAt,
        openingFloat: dec(s.openingFloat).toString(),
        closingCounted: s.closingCounted ? dec(s.closingCounted).toString() : null,
        closingExpected: s.closingExpected ? dec(s.closingExpected).toString() : null,
        closingDifference: s.closingDifference ? dec(s.closingDifference).toString() : null,
        // What has already left the drawer for the bank — the rest of the
        // counted cash is still sitting on the drawer ledger.
        bankedAmount: s.bankedAmount ? dec(s.bankedAmount).toString() : null,
        movementCount: s._count.movements,
        varianceReason: s.varianceReason ?? null,
        varianceStatus: s.varianceStatus ?? null,
        notes: s.notes,
      })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    };
  }

  /**
   * Bank the drawer's cash.
   *  - Open shift: a `pay_out` drawer movement + Dr bank / Cr drawer, bounded by
   *    the running expected cash.
   *  - Closed shift: the count is frozen, so nothing is added to that shift.
   *    The cash still sits on the drawer ledger until it is banked, so the
   *    deposit is a journal from the drawer account (no open shift may exist on
   *    the register, bounded by the drawer ledger balance).
   */
  async recordBankDeposit(sessionId: string, dto: BankDepositDto) {
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    const amt = dec(dto.amount);
    if (!amt.isFinite() || amt.lessThanOrEqualTo(0)) throw new BadRequestException('Deposit amount must be positive');
    if (!dto.destinationAccountId) throw new BadRequestException('Select the destination bank account');

    return this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', sessionId, organizationId);
      const session = await tx.cashSession.findFirst({ where: { id: sessionId, organizationId } });
      if (!session) throw new NotFoundException('Cash session not found');
      if (session.status === 'reconciled') throw new BadRequestException('This session is reconciled; bank its cash from the register once no shift is open');
      if (session.status === 'open' && session.userId !== userId) throw new ForbiddenException('Only the session cashier can bank from an open shift');
      if (session.status === 'closed' && !this.tenant.has('cash_session:reconcile')) throw new ForbiddenException('Banking a closed shift requires cash_session:reconcile');

      const drawer = await this.registerCashAccount(tx, session);
      const destinationId = dto.destinationAccountId!;
      await lockAccounts(tx, organizationId, [drawer, destinationId]);
      const destination = await requireAccount(tx, organizationId, destinationId, 'Destination account');
      if (destination.category?.key !== 'bank') throw new BadRequestException('Select a bank account for the deposit');
      const reason = `Bank deposit: ${dto.bankName}${dto.reference ? ` ref:${dto.reference}` : ''}${dto.notes ? ` - ${dto.notes}` : ''}`;

      if (session.status === 'open') {
        const onHand = await this.computeExpected(tx, session);
        if (amt.greaterThan(onHand)) throw new BadRequestException(`Deposit ${amt.toString()} exceeds cash on hand ${onHand.toString()}`);
        const movement = await tx.cashMovement.create({
          data: { organizationId, cashSessionId: session.id, movementType: 'pay_out' as any, amount: amt, reason, counterpartAccountId: destination.id, performedBy: userId ?? null },
        });
        await this.postBankDepositGl(tx, session, amt, movement.id, dto.bankName, destination.id);
        await tx.cashSession.update({ where: { id: session.id }, data: { bankedAmount: dec(session.bankedAmount ?? 0).plus(amt), bankName: dto.bankName } });
        await this.audit.recordInTx(tx, {
          entity: 'CashMovement', entityId: movement.id, action: 'create',
          newValues: { cashSessionId: session.id, movementType: 'pay_out', amount: amt.toString(), reason: 'bank_deposit' },
        });
        this.events.publish('cash.banking.recorded', { organizationId, sessionId: session.id, amount: amt.toString(), bankName: dto.bankName });
        const outcome = { movement, sessionId: session.id };
        await recordBusinessOutcome(tx, outcome, true);
        return outcome;
      }

      const openShift = await tx.cashSession.findFirst({ where: { organizationId, cashRegisterId: session.cashRegisterId, status: 'open' } });
      if (openShift) throw new BadRequestException('A shift is open on this register; bank the cash from that shift');
      const drawerBalance = await accountLedgerBalance(tx, organizationId, drawer);
      if (amt.greaterThan(drawerBalance)) throw new BadRequestException(`Deposit ${amt.toString()} exceeds the drawer balance ${drawerBalance.toString()}`);
      const id = operationId();
      const entry = await this.posting.post({
        date: new Date(),
        journalCode: 'BANK',
        description: `${reason} (after close of shift ${session.id})`,
        sourceType: 'cash_session_banking',
        sourceId: session.id,
        postingKey: `cash_session_banking:${id}`,
        branchId: session.branchId ?? undefined,
        lines: [
          { accountId: destination.id, debit: amt.toString() },
          { accountId: drawer, credit: amt.toString() },
        ],
      }, tx);
      await this.audit.recordInTx(tx, {
        entity: 'CashSession', entityId: session.id, action: 'update',
        newValues: { kind: 'banking_after_close', amount: amt.toString(), journalEntryId: entry.id, destinationAccountId: destination.id, reason },
      });
      this.events.publish('cash.banking.recorded', { organizationId, sessionId: session.id, amount: amt.toString(), bankName: dto.bankName });
      const outcome = { journalEntryId: entry.id, sessionId: session.id };
      await recordBusinessOutcome(tx, outcome, true);
      return outcome;
    });
  }

  /** Update variance explanation and status. Approving requires SoD (C3). */
  async updateVariance(sessionId: string, dto: VarianceUpdateDto) {
    const organizationId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', sessionId, organizationId);
      const session = await tx.cashSession.findFirst({
        where: { id: sessionId, organizationId },
      });
      if (!session) throw new NotFoundException('Cash session not found');
      if (session.status !== 'closed') throw new BadRequestException('Only a closed, unreconciled session may have its variance reviewed');
      if (!dto.reason?.trim()) throw new BadRequestException('A variance review reason is required');
      if (dec(session.closingDifference ?? 0).isZero()) throw new BadRequestException('This shift has no variance to review');

      // C3 — the review is a manager decision: never the session cashier, and
      // the cashier's original explanation is kept alongside the review note.
      const manager = await this.assertManagerApproval(tx, {
        approverId: this.tenant.userId ?? undefined,
        cashierUserId: session.userId,
        permission: 'cash_session:approve_variance',
        actionLabel: 'a cash variance review',
      });
      const updateData: any = {
        varianceReason: `${session.varianceReason ?? ''}${session.varianceReason ? ' | ' : ''}Review (${new Date().toISOString().slice(0, 10)}): ${dto.reason.trim()}`,
        approvedById: manager.id,
      };
      if (dto.status) updateData.varianceStatus = dto.status;

      await tx.cashSession.update({ where: { id: session.id }, data: updateData });

      await this.audit.recordInTx(tx, {
        entity: 'CashSession',
        entityId: session.id,
        action: 'update',
        oldValues: { varianceReason: session.varianceReason, varianceStatus: session.varianceStatus },
        newValues: updateData,
      });

      const result = await tx.cashSession.findFirst({ where: { id: session.id } });
      await recordBusinessOutcome(tx, result, true);
      return result;
    });
  }

  /** Daily reconciliation report — aggregates all sessions for a business date. */
  async dailyReconciliation(dateStr: string) {
    const organizationId = this.tenant.organizationId;
    const { start, end } = await this.orgDayRange(dateStr);

    const sessions = await this.prisma.client.cashSession.findMany({
      where: {
        organizationId,
        openedAt: { gte: start, lt: end },
      },
      include: {
        cashRegister: { select: { id: true, code: true, name: true } },
        movements: {
          include: { payment: { select: { paymentMethod: true, amount: true } } },
        },
      },
      orderBy: { openedAt: 'asc' },
    });

    // Resolve user IDs to cashier names
    const userIds = Array.from(new Set(sessions.map((s: any) => s.userId).filter(Boolean)));
    const users = userIds.length
      ? await this.prisma.client.user.findMany({ where: { id: { in: userIds as string[] } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const userNames = new Map(users.map((u: any) => [u.id, `${u.firstName}${u.lastName ? ' ' + u.lastName : ''}`]));

    const rows: DailyReconciliationRow[] = [];
    let grandOpening = ZERO;
    let grandSales = ZERO;
    let grandPayIns = ZERO;
    let grandPayOuts = ZERO;
    let grandRefunds = ZERO;
    let grandBanked = ZERO;
    let grandAdjustments = ZERO;

    for (const s of sessions) {
      let sales = ZERO;
      let payIns = ZERO;
      let payOuts = ZERO;
      let refunds = ZERO;
      let banked = ZERO;
      let adjustments = ZERO;

      for (const m of s.movements) {
        const amt = dec(m.amount);
        if (m.movementType === 'sale') sales = sales.plus(amt);
        else if (m.movementType === 'pay_in') payIns = payIns.plus(amt);
        else if (m.movementType === 'pay_out') {
          if ((m.reason ?? '').startsWith('Bank deposit:')) banked = banked.plus(amt);
          else payOuts = payOuts.plus(amt);
        }
        else if (m.movementType === 'refund') refunds = refunds.plus(amt);
        else if (m.movementType === 'supplier_payment') payOuts = payOuts.plus(amt);
        else if (m.movementType === 'adjustment') adjustments = adjustments.plus(amt);
      }

      const opening = dec(s.openingFloat);
      // Banking happens after the immutable close count. It is a custody
      // transfer and must not retroactively create a drawer variance.
      const expected = opening.plus(sales).plus(payIns).plus(adjustments).minus(payOuts).minus(refunds);
      const actual = s.closingCounted ? dec(s.closingCounted) : null;
      const variance = actual ? actual.minus(expected) : null;

      grandOpening = grandOpening.plus(opening);
      grandSales = grandSales.plus(sales);
      grandPayIns = grandPayIns.plus(payIns);
      grandPayOuts = grandPayOuts.plus(payOuts);
      grandRefunds = grandRefunds.plus(refunds);
      grandBanked = grandBanked.plus(banked);
      grandAdjustments = grandAdjustments.plus(adjustments);

      rows.push({
        sessionId: s.id,
        cashRegisterName: s.cashRegister.name,
        cashierName: userNames.get(s.userId) ?? '(unknown)',
        openedAt: s.openedAt,
        closedAt: s.closedAt,
        openingFloat: opening.toString(),
        salesTotal: sales.toString(),
        payInsTotal: payIns.toString(),
        payOutsTotal: payOuts.toString(),
        refundsTotal: refunds.toString(),
        expectedCash: expected.toString(),
        actualCash: actual?.toString() ?? null,
        variance: variance?.toString() ?? null,
        varianceReason: s.varianceReason ?? null,
        bankedAmount: banked.toString(),
      });
    }

    const grandExpected = grandOpening.plus(grandSales).plus(grandPayIns).plus(grandAdjustments).minus(grandPayOuts).minus(grandRefunds);

    return {
      date: dateStr.trim().slice(0, 10),
      sessionCount: sessions.length,
      sessions: rows,
      totals: {
        openingFloat: grandOpening.toString(),
        salesTotal: grandSales.toString(),
        payInsTotal: grandPayIns.toString(),
        payOutsTotal: grandPayOuts.toString(),
        refundsTotal: grandRefunds.toString(),
        bankedAmount: grandBanked.toString(),
        adjustmentsTotal: grandAdjustments.toString(),
        expectedCash: grandExpected.toString(),
      },
    };
  }

  /** Find a single session by id. */
  async findById(id: string) {
    const organizationId = this.tenant.organizationId;
    const session = await this.prisma.client.cashSession.findFirst({
      where: { id, organizationId },
      include: {
        cashRegister: { select: { id: true, code: true, name: true } },
        _count: { select: { movements: true } },
      },
    });
    if (!session) throw new NotFoundException('Cash session not found');
    return {
      ...session,
      openingFloat: dec(session.openingFloat).toString(),
      closingCounted: session.closingCounted ? dec(session.closingCounted).toString() : null,
      closingExpected: session.closingExpected ? dec(session.closingExpected).toString() : null,
      closingDifference: session.closingDifference ? dec(session.closingDifference).toString() : null,
    };
  }

  /**
   * Reconcile a closed session — transition `closed` → `reconciled`.
   *
   * Guards:
   *   1. Session must be `closed`.
   *   2. Any variance must be `approved` (or zero).
   *   3. A Z-report snapshot must exist.
   *   4. C3 — the session's own cashier may not reconcile it (SoD).
   */
  async reconcile(sessionId: string, dto?: {
    depositAmount?: number | string;
    bankName?: string;
    reference?: string;
    notes?: string;
  }) {
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;

    return this.prisma.client.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', sessionId, organizationId);
      const session = await tx.cashSession.findFirst({
        where: { id: sessionId, organizationId },
      });
      if (!session) throw new NotFoundException('Cash session not found');
      if (session.status !== 'closed') {
        throw new BadRequestException(
          `Cannot reconcile session with status "${session.status}" — must be closed first`,
        );
      }
      // C3 — segregation of duties.
      if (userId && userId === session.userId) {
        throw new ForbiddenException('The session cashier cannot reconcile their own session');
      }

      const variance = session.closingDifference ? dec(session.closingDifference) : ZERO;
      if (!variance.isZero() && session.varianceStatus !== 'approved') {
        throw new BadRequestException(
          'Session has an unresolved variance. Approve or explain the variance before reconciling.',
        );
      }

      const snapshot = await tx.posReportSnapshot.findFirst({
        where: { cashSessionId: session.id, kind: 'z' },
      });
      if (!snapshot) {
        throw new BadRequestException(
          'Z-report has not been generated for this session. Generate a Z-report before reconciling.',
        );
      }

      if (dto?.depositAmount != null && dec(dto.depositAmount).gt(0)) throw new BadRequestException('The drawer is closed. Record its deposit in a new shift or treasury transfer; the frozen Z-report cannot be changed.');
      const check = await reconcileSession(tx, organizationId, session);
      if (check.pendingPayments || check.unsettledOrders || check.pendingPostings || check.issues.length) throw new BadRequestException({ message: 'Resolve reconciliation differences first', reconciliation: check });
      const updated = await tx.cashSession.updateMany({
        where: { id: session.id },
        data: { status: 'reconciled', notes: dto?.notes ?? session.notes },
      });
      if (updated.count === 0) throw new Error('Failed to reconcile session');

      await this.audit.recordInTx(tx, {
        entity: 'CashSession',
        entityId: session.id,
        action: 'reconcile' as any,
        oldValues: { status: 'closed' },
        newValues: { status: 'reconciled', depositRecorded: !!dto?.depositAmount },
      });

      this.events.publish('cash.session.reconciled', {
        organizationId,
        sessionId: session.id,
        cashRegisterId: session.cashRegisterId,
      });

      const result = await tx.cashSession.findFirst({ where: { id: session.id } });
      await recordBusinessOutcome(tx, result, true);
      return result;
    });
  }

  /**
   * Universal daily reset — reconcile every `closed` (not-yet-reconciled)
   * session for a given business date.
   *
   * Policy:
   *  - Blocks if any session for the date is still `open` (list returned in error).
   *  - Skips sessions with unresolved variance (non-zero difference not `approved`).
   *  - Auto-generates missing Z-report snapshots via PosReportsService.
   */
  async dailyReset(dateStr: string, actorUserId?: string) {
    const organizationId = this.tenant.organizationId;
    const { start, end } = await this.orgDayRange(dateStr);

    const sessions = await this.prisma.client.cashSession.findMany({
      where: { organizationId, openedAt: { gte: start, lt: end } },
      include: { cashRegister: { select: { code: true, name: true } } },
      orderBy: { openedAt: 'asc' },
    });

    const openSessions = sessions.filter((s: any) => s.status === 'open');
    if (openSessions.length > 0) {
      throw new BadRequestException({
        code: 'OPEN_SESSIONS_BLOCK_RESET',
        message: 'Cannot reset: one or more sessions are still open. Close all sessions first.',
        openSessions: openSessions.map((s: any) => ({
          id: s.id,
          cashRegister: s.cashRegister?.name ?? s.cashRegisterId,
          openedAt: s.openedAt,
        })),
      });
    }

    const reconciled: string[] = [];
    const skipped: Array<{ sessionId: string; reason: string }> = [];

    let posReportsSvc: any = null;
    try {
      const mod = await import('../../pos/pos-reports.service');
      const { PosReportsService } = mod;
      posReportsSvc = new PosReportsService(
        this.prisma as any,
        this.tenant,
        this.audit,
        this.events,
      );
    } catch {
      // POS module unavailable — auto-Z generation skipped for this run.
    }

    for (const session of sessions) {
      if (session.status === 'reconciled') continue;

      const hasSnapshot = await this.prisma.client.posReportSnapshot.findFirst({
        where: { cashSessionId: session.id, kind: 'z' },
      });
      if (!hasSnapshot) {
        if (posReportsSvc) {
          try {
            await posReportsSvc.zReport(session.id);
          } catch {
            skipped.push({ sessionId: session.id, reason: 'Failed to generate Z-report snapshot' });
            continue;
          }
        } else {
          skipped.push({ sessionId: session.id, reason: 'No Z-report snapshot and POS reports service unavailable' });
          continue;
        }
      }

      const variance = session.closingDifference ? dec(session.closingDifference) : ZERO;
      if (!variance.isZero() && session.varianceStatus !== 'approved') {
        skipped.push({ sessionId: session.id, reason: 'Unresolved variance — must be approved before daily reset' });
        continue;
      }

      try { await this.reconcile(session.id); }
      catch (e: any) { skipped.push({ sessionId: session.id, reason: e?.message || 'Reconciliation failed' }); continue; }
      reconciled.push(session.id);
    }

    return {
      date: dateStr.trim().slice(0, 10),
      totalSessions: sessions.length,
      reconciledCount: reconciled.length,
      reconciled,
      skippedCount: skipped.length,
      skipped,
    };
  }

  // ─── helpers ────────────────────────────────────────────────────────────
  private async requireOpenSession(tx: any) {
    const session = await tx.cashSession.findFirst({
      where: { organizationId: this.tenant.organizationId, userId: this.tenant.userId, status: 'open' },
    });
    if (!session) throw new NotFoundException('No open cash session');
    return session;
  }

  /**
   * expected = opening + Σ(sales) + Σ(pay_in) − Σ(pay_out) − Σ(refunds) ± adjustments
   * For sales, sign follows direction: sales are +amount, refunds are −amount.
   */
  private async computeExpected(tx: any, session: any): Promise<Prisma.Decimal> {
    const movements = await tx.cashMovement.findMany({ where: { cashSessionId: session.id } });
    let total = dec(session.openingFloat);
    for (const m of movements) {
      const amt = dec(m.amount);
      switch (m.movementType) {
        case 'sale':
        case 'pay_in':
          total = total.plus(amt);
          break;
        case 'refund':
        case 'supplier_payment':
        case 'pay_out':
          total = total.minus(amt);
          break;
        case 'adjustment':
          total = total.plus(amt);
          break;
      }
    }
    return total;
  }

  /** Frozen per-tender totals from this session's posted/paid invoices. */
  private async computeByMethod(tx: any, organizationId: string, sessionId: string): Promise<any> {
    const payments = await tx.payment.findMany({ where: { organizationId, cashSessionId: sessionId, status: { not: 'cancelled' } } });
    const totals: Record<string, string> = {};
    for (const p of payments) totals[p.paymentMethod] = dec(totals[p.paymentMethod] ?? 0).plus(dec(p.amount).times(p.direction === 'inbound' ? 1 : -1)).toString();
    return totals;
  }

  async reconciliation(sessionId: string) {
    return this.prisma.client.$transaction(async (tx: any) => {
      const session = await tx.cashSession.findFirst({ where: { id: sessionId, organizationId: this.tenant.organizationId } });
      if (!session) throw new NotFoundException('Session not found');
      return reconcileSession(tx, this.tenant.organizationId, session);
    });
  }

  settleTender(input: any) { return settleTender(this, input); }

  private async lockOpenSession(tx: any, sessionId: string) {
    await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', sessionId, this.tenant.organizationId);
    const session = await tx.cashSession.findFirst({ where: { id: sessionId, organizationId: this.tenant.organizationId } });
    if (!session || session.status !== 'open') throw new BadRequestException('The register session is no longer open');
    return session;
  }

  /** UTC bounds of a business day in the org's configured time zone. */
  private async orgDayRange(dateStr: string): Promise<{ start: Date; end: Date }> {
    const org = await this.prisma.client.organization.findUnique({
      where: { id: this.tenant.organizationId },
      select: { timezone: true },
    });
    return zonedDayRange(dateStr, org?.timezone || 'UTC');
  }

  private sanitizeDenomination(input?: Record<string, number>): any {
    if (!input || typeof input !== 'object') return Prisma.DbNull;
    const out: Record<string, number> = {};
    for (const [face, count] of Object.entries(input)) {
      const f = Number(face);
      const c = Number(count);
      if (!Number.isFinite(f) || f <= 0 || !Number.isFinite(c) || c < 0 || !Number.isInteger(c)) {
        throw new BadRequestException('Denominations require positive face values and whole, non-negative counts');
      }
      out[String(f)] = c;
    }
    return Object.keys(out).length ? out : Prisma.DbNull;
  }

  private assertDenominationTotal(input: Record<string, number> | undefined, total: number | string | Prisma.Decimal, label: string) {
    if (!input) return;
    let denominationTotal = ZERO;
    for (const [face, count] of Object.entries(input)) {
      const f = Number(face), c = Number(count);
      if (!Number.isFinite(f) || f <= 0 || !Number.isFinite(c) || c < 0 || !Number.isInteger(c)) {
        throw new BadRequestException('Denominations require positive face values and whole, non-negative counts');
      }
      denominationTotal = denominationTotal.plus(dec(f).times(c));
    }
    if (!denominationTotal.eq(dec(total))) throw new BadRequestException(`Denomination total must equal the ${label}`);
  }

  /**
   * Verify a manager approving a privileged cash action:
   *   - approver must exist, be active, and hold `permission`;
   *   - approver must NOT be the session cashier (segregation of duties);
   *   - if `managerPin` is supplied, it must match the approver's PIN.
   */
  private async assertManagerApproval(
    tx: any,
    opts: {
      approverId?: string;
      approverEmail?: string;
      managerPin?: string;
      cashierUserId: string;
      permission: string;
      actionLabel: string;
    },
  ) {
    const { managerPin, cashierUserId, permission, actionLabel } = opts;
    const orgId = this.tenant.organizationId;

    // Resolve the approver by id (preferred) or by login email.
    const manager = opts.approverId
      ? await tx.user.findFirst({ where: { id: opts.approverId, organizationId: orgId, isActive: true }, include: { roles: true } })
      : opts.approverEmail
        ? await tx.user.findFirst({ where: { email: opts.approverEmail.toLowerCase(), organizationId: orgId, isActive: true }, include: { roles: true } })
        : null;
    if (!opts.approverId && !opts.approverEmail) {
      throw new BadRequestException({ code: 'MANAGER_APPROVAL_REQUIRED', message: `${actionLabel} requires manager approval` });
    }
    if (!manager) throw new NotFoundException('Approving manager not found');
    if (manager.id === cashierUserId) {
      throw new ForbiddenException(`The session cashier cannot approve ${actionLabel}`);
    }
    if (!managerPin && manager.id !== this.tenant.userId) throw new BadRequestException({ code: 'MANAGER_APPROVAL_REQUIRED', message: 'Manager PIN is required' });
    if (managerPin) {
      if (!manager.pinHash) throw new BadRequestException('Manager has not set a PIN');
      const ok = await this.password.compare(managerPin, manager.pinHash);
      if (!ok) throw new UnauthorizedException('Invalid manager PIN');
    }
    const perms = new Set(manager.roles.flatMap((r: any) => r.permissions ?? []));
    if (!perms.has(permission)) {
      throw new UnauthorizedException(`Approver does not hold ${permission}`);
    }
    return manager;
  }

  // ─── GL posting (best-effort; a config gap is logged, never trapping the till) ──

  /**
   * What a drawer movement may be booked against. Revenue and receivables are
   * never valid (sales only come from Payments), another register's drawer is
   * never valid (move cash through the safe), and adjustments are always the
   * short/over account (checked when posting).
   */
  private async assertMovementCounterpart(tx: any, session: any, movementType: string, counterpartAccountId: string) {
    const organizationId = this.tenant.organizationId;
    const drawer = await this.registerCashAccount(tx, session);
    if (counterpartAccountId === drawer) throw new BadRequestException('The counterpart must differ from the drawer account');
    const account = await requireAccount(tx, organizationId, counterpartAccountId, 'Counterpart account');
    await assertNotDrawerAccount(tx, organizationId, account.id, 'A drawer movement');
    if (movementType === 'adjustment') return;
    const classification = account.category?.classification;
    const allowed = movementType === 'pay_in'
      ? account.category?.isCashEquivalent || ['equity', 'liability'].includes(classification)
      : account.category?.isCashEquivalent || ['expense', 'liability', 'equity'].includes(classification);
    if (!allowed) {
      throw new BadRequestException(movementType === 'pay_in'
        ? 'A pay-in must come from a safe/bank account, owner equity or a liability - sales are recorded only through payments'
        : 'A pay-out must go to an expense, a safe/bank account, owner equity or a liability');
    }
  }

  private async registerCashAccount(tx: any, session: any): Promise<string> {
    if (session.drawerAccountId) return session.drawerAccountId;
    const register = await tx.cashRegister.findFirst({ where: { id: session.cashRegisterId } });
    if (register?.defaultAccountId) return register.defaultAccountId;
    // Fall back to the org default cash account.
    return this.determination.mapped('default_cash', tx);
  }

  private async postMovementGl(
    tx: any,
    session: any,
    movementType: 'pay_in' | 'pay_out' | 'adjustment',
    amount: Prisma.Decimal,
    movementId: string,
    reason: string | null,
    counterpartAccountId?: string,
  ) {
    try {
      const cash = await this.registerCashAccount(tx, session);
      const date = new Date();
      const base = { date, sourceType: 'cash_movement', sourceId: movementId, postingKey: `cash_movement:${movementId}`, branchId: session.branchId ?? undefined } as const;

      const amt = amount.toString();
      if (movementType === 'pay_in') {
        const clearing = counterpartAccountId ?? await this.determination.mapped('cash_clearing', tx);
        const account = await tx.account.findFirst({ where: { id: clearing, organizationId: this.tenant.organizationId, isActive: true } });
        if (!account || clearing === cash) throw new BadRequestException('Invalid cash movement counterpart account');
        await this.posting.post({
          ...base, journalCode: 'CASH', description: reason ?? 'Cash pay-in',
          lines: [
            { accountId: cash, debit: amt },
            { accountId: clearing, credit: amt },
          ],
        }, tx);
      } else if (movementType === 'pay_out') {
        const clearing = counterpartAccountId ?? await this.determination.mapped('cash_clearing', tx);
        const account = await tx.account.findFirst({ where: { id: clearing, organizationId: this.tenant.organizationId, isActive: true } });
        if (!account || clearing === cash) throw new BadRequestException('Invalid cash movement counterpart account');
        await this.posting.post({
          ...base, journalCode: 'CASH', description: reason ?? 'Cash pay-out',
          lines: [
            { accountId: clearing, debit: amt },
            { accountId: cash, credit: amt },
          ],
        }, tx);
      } else {
        // adjustment: positive adds cash (Cr over/short income), negative removes.
        const shortOver = await this.determination.mapped('cash_short_over', tx);
        if (counterpartAccountId !== shortOver) throw new BadRequestException('Cash adjustments must use the configured cash short/over account');
        const abs = amount.abs().toString();
        const lines = amount.greaterThan(0)
          ? [{ accountId: cash, debit: abs }, { accountId: shortOver, credit: abs }]
          : [{ accountId: shortOver, debit: abs }, { accountId: cash, credit: abs }];
        await this.posting.post({ ...base, journalCode: 'CASH', description: reason ?? 'Cash adjustment', lines }, tx);
      }
    } catch (e) {
      throw e;
    }
  }

  private async postBankDepositGl(
    tx: any,
    session: any,
    amount: Prisma.Decimal,
    movementId: string,
    bankName: string,
    destinationAccountId?: string,
  ) {
    try {
      const cash = await this.registerCashAccount(tx, session);
      const bank = destinationAccountId ?? await this.determination.mapped('default_bank', tx);
      const destination = await tx.account.findFirst({ where: { id: bank, organizationId: this.tenant.organizationId, isActive: true }, include: { category: true } });
      if (!destination || destination.category?.key !== 'bank') throw new BadRequestException('Select a bank account for the deposit');
      const amt = amount.toString();
      await this.posting.post({
        date: new Date(),
        journalCode: 'BANK',
        description: `Bank deposit: ${bankName}`,
        sourceType: 'cash_movement',
        sourceId: movementId,
        postingKey: `cash_movement:${movementId}`,
        branchId: session.branchId ?? undefined,
        lines: [
          { accountId: bank, debit: amt },
          { accountId: cash, credit: amt },
        ],
      }, tx);
    } catch (e) {
      throw e;
    }
  }

  /** difference = counted − expected. Short (<0) = missing cash; over (>0) = surplus. */
  private async postVarianceGl(tx: any, session: any, difference: Prisma.Decimal) {
    try {
      const cash = await this.registerCashAccount(tx, session);
      const shortOver = await this.determination.mapped('cash_short_over', tx);
      const abs = difference.abs().toString();
      const lines = difference.isNegative()
        // short: expense the missing cash → Dr Short&Over / Cr Cash
        ? [{ accountId: shortOver, debit: abs }, { accountId: cash, credit: abs }]
        // over: surplus cash → Dr Cash / Cr Short&Over
        : [{ accountId: cash, debit: abs }, { accountId: shortOver, credit: abs }];
      await this.posting.post({
        date: new Date(),
        journalCode: 'CASH',
        description: `Cash over/short — session ${session.id}`,
        sourceType: 'cash_session_variance',
        sourceId: session.id,
        postingKey: `cash_session_variance:${session.id}`,
        branchId: session.branchId ?? undefined,
        lines,
      }, tx);
    } catch (e) {
      throw e;
    }
  }

}
