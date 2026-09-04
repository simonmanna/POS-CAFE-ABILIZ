import { accountLedgerBalance, accountObservations, reconcileSession, settleTender } from './session-reconciliation';
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
          userId,
          status: 'open',
          openingFloat: dec(dto.openingFloat ?? 0),
          openingAccounts: await accountObservations(tx, organizationId, dto.openingAccounts),
          openingDenomination: this.sanitizeDenomination(dto.openingDenomination),
          notes: dto.notes ?? null,
          ...(occurredAt ? { openedAt: occurredAt } : {}),
        },
      });

      if (funding.gt(0)) await this.posting.post({ journalCode: 'CASH', date: (occurredAt ?? new Date()).toISOString(), description: `Opening float: ${dto.notes}`, sourceType: 'cash_session_opening', sourceId: session.id, lines: [{ accountId: register.defaultAccountId, debit: funding.toString() }, { accountId: dto.openingSourceAccountId!, credit: funding.toString() }] }, tx);
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

  /** Close the current open session. Computes expected vs counted. */
    async close(dto: CloseSessionDto) {
      const organizationId = this.tenant.organizationId;
      const counted = dec(dto.closingCounted);
      if (!counted.isFinite() || counted.isNegative()) throw new BadRequestException('Counted cash cannot be negative');

      return this.prisma.client.$transaction(async (tx: any) => {
        // If sessionId is provided, close that specific session (shared terminal - any cashier can close)
        // Otherwise, close the caller's own open session (existing behavior)
        const session = dto.sessionId
          ? await tx.cashSession.findFirst({ where: { id: dto.sessionId, organizationId } })
          : await this.requireOpenSession(tx);
        if (!session) throw new NotFoundException('No open cash session');
        await this.lockOpenSession(tx, session.id);
        if (session.status !== 'open') throw new BadRequestException('Session is not open');

      if ((dto.pendingSyncCount ?? 0) > 0) throw new BadRequestException('Sync or resolve pending device operations before closing');
      const reconciliation = await reconcileSession(tx, organizationId, session);
      if (reconciliation.unsettledOrders || reconciliation.pendingPayments || reconciliation.pendingPostings || reconciliation.issues.length) {
        throw new BadRequestException({ message: 'Resolve unsettled orders, payments and posting differences before closing', reconciliation });
      }
      const closingAccounts = await accountObservations(tx, organizationId, dto.closingAccounts);
      const expected = await this.computeExpected(tx, session);
      const closingDifference = counted.minus(expected);
      const reason = dto.varianceReason ? dto.varianceReason.trim() : null;

      // C2 — a non-zero variance must be explained.
      let varianceStatus: string | null = null;
      let approvedById: string | null = null;
      if (!closingDifference.isZero()) {
        if (!reason) {
          throw new BadRequestException('A variance reason is required when counted cash differs from expected');
        }
        // Large variance ⇒ manager must approve it right now.
        if (closingDifference.abs().greaterThanOrEqualTo(this.largeVarianceThreshold)) {
          const manager = await this.assertManagerApproval(tx, {
            approverId: dto.approvedById,
            approverEmail: dto.approverEmail,
            managerPin: dto.managerPin,
            cashierUserId: session.userId,
            permission: 'cash_session:approve_variance',
            actionLabel: 'a large cash variance',
          });
          varianceStatus = 'approved';
          approvedById = manager.id;
        } else {
          varianceStatus = 'pending_review';
        }
      }

      const closingByMethod = await this.computeByMethod(tx, organizationId, session.id);

      const updated = await tx.cashSession.updateMany({
        where: { id: session.id },
        data: {
          status: 'closed',
          closedAt: resolveOccurredAt(dto.occurredAt) ?? new Date(),
          closingCounted: counted,
          closingExpected: expected,
          closingDifference,
          closingDenomination: this.sanitizeDenomination(dto.closingDenomination),
          closingByMethod,
          closingAccounts,
          varianceReason: reason,
          varianceStatus,
          approvedById,
          notes: dto.notes ?? session.notes,
        },
      });
      if (updated.count === 0) throw new Error('Failed to close session');
      const reportData = JSON.parse(JSON.stringify({ ...reconciliation.report, accounts: reconciliation.accounts, openingAccounts: session.openingAccounts, closingAccounts, closingCounted: counted.toString(), closingExpected: expected.toString(), closingDifference: closingDifference.toString(), varianceReason: reason, varianceStatus, approvedById }));
      await tx.posReportSnapshot.create({ data: { organizationId, cashSessionId: session.id, reportData, kind: 'z' } });


      // C1 — book the drawer over/short to the ledger.
      if (!closingDifference.isZero()) {
        await this.postVarianceGl(tx, session, closingDifference);
      }

      await this.audit.recordInTx(tx, {
        entity: 'CashSession',
        entityId: session.id,
        action: 'update',
        oldValues: { status: 'open' },
        newValues: {
          status: 'closed',
          closingDifference: closingDifference.toString(),
          varianceReason: reason,
          varianceStatus,
          approvedById,
        },
      });

      this.events.publish('cash.session.closed', {
        organizationId,
        sessionId: session.id,
        expected: expected.toString(),
        counted: counted.toString(),
        variance: closingDifference.toString(),
      });

      const result = await tx.cashSession.findFirst({ where: { id: session.id } });
      await recordBusinessOutcome(tx, result, true);
      return result;
    });
  }

  /**
   * Shift handover — atomically close the open session on a register (with the
   * outgoing cashier's blind count + variance) and open a fresh session on the
   * same register for the incoming cashier, carrying the counted cash forward as
   * the opening float. The incoming user and the manager approval are validated
   * by the POS layer (PosShiftService) before this runs.
   */
  async handover(dto: {
    cashRegisterId: string;
    closingCounted: number | string;
    incomingUserId: string;
    varianceReason?: string;
    openingFloat?: number | string;
    notes?: string;
    approvedById?: string;
  }) {
    const organizationId = this.tenant.organizationId;
    const counted = dec(dto.closingCounted);

    return this.prisma.client.$transaction(async (tx: any) => {
      const outgoing = await tx.cashSession.findFirst({
        where: { organizationId, cashRegisterId: dto.cashRegisterId, status: 'open' },
      });
      if (!outgoing) throw new NotFoundException('No open session on this register');
      await this.lockOpenSession(tx, outgoing.id);
      const check = await reconcileSession(tx, organizationId, outgoing);
      if (check.unsettledOrders || check.pendingPayments || check.pendingPostings || check.issues.length) throw new BadRequestException('Resolve pending work before handover');

      const expected = await this.computeExpected(tx, outgoing);
      const variance = counted.minus(expected);
      if (!variance.isZero() && !dto.varianceReason?.trim()) {
        throw new BadRequestException('A variance reason is required when the counted cash differs from expected');
      }

      const now = new Date();
      await tx.cashSession.updateMany({
        where: { id: outgoing.id },
        data: {
          status: 'closed',
          closedAt: now,
          closingCounted: counted,
          closingExpected: expected,
          closingDifference: variance,
          varianceReason: dto.varianceReason ?? null,
          varianceStatus: variance.isZero() ? null : 'approved',
          approvedById: dto.approvedById ?? null,
          closingByMethod: await this.computeByMethod(tx, organizationId, outgoing.id),
        },
      });

      // Book the outgoing shift's over/short to the ledger.
      if (!variance.isZero()) {
        await this.postVarianceGl(tx, outgoing, variance);
      }

      const opening = dto.openingFloat != null ? dec(dto.openingFloat) : counted;
      if (!counted.isFinite() || counted.lt(0) || !opening.eq(counted)) throw new BadRequestException('Handover must carry the counted physical cash; record float changes as a separate movement');
      await tx.posReportSnapshot.create({ data: { organizationId, cashSessionId: outgoing.id, reportData: JSON.parse(JSON.stringify({ ...check.report, closingCounted: counted.toString(), closingDifference: variance.toString(), accounts: check.accounts })), kind: 'z' } });
      const incoming = await tx.cashSession.create({
        data: {
          organizationId,
          cashRegisterId: outgoing.cashRegisterId,
          branchId: outgoing.branchId ?? null,
          userId: dto.incomingUserId,
          status: 'open',
          openingFloat: opening,
          notes: dto.notes ?? `Opened by handover from session ${outgoing.id}`,
        },
      });

      await this.audit.recordInTx(tx, {
        entity: 'CashSession',
        entityId: outgoing.id,
        action: 'update',
        oldValues: { status: 'open' },
        newValues: {
          status: 'closed',
          kind: 'handover_out',
          handoverToSessionId: incoming.id,
          incomingUserId: dto.incomingUserId,
          counted: counted.toString(),
          expected: expected.toString(),
          variance: variance.toString(),
          varianceReason: dto.varianceReason ?? null,
          approvedById: dto.approvedById ?? null,
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
        },
      });

      this.events.publish('cash.session.handover' as any, {
        organizationId,
        outgoingSessionId: outgoing.id,
        incomingSessionId: incoming.id,
        cashRegisterId: outgoing.cashRegisterId,
        incomingUserId: dto.incomingUserId,
        variance: variance.toString(),
      });

      const result = {
        outgoingSessionId: outgoing.id,
        incomingSessionId: incoming.id,
        expected: expected.toString(),
        counted: counted.toString(),
        variance: variance.toString(),
      };
      await recordBusinessOutcome(tx, result, true);
      return result;
    });
  }

  /** Record a manual movement (pay-in, pay-out, adjustment). */
  async recordMovement(sessionId: string | undefined, dto: RecordMovementDto) {
    const organizationId = this.tenant.organizationId;
    const amount = dec(dto.amount);

    // H4 — sign rules. pay_in / pay_out must be strictly positive (the type
    // carries the direction). adjustment may be signed but never zero.
    if (!amount.isFinite() || amount.isZero()) throw new BadRequestException('Amount cannot be zero or non-finite');
    if ((dto.movementType === 'pay_in' || dto.movementType === 'pay_out') && amount.isNegative()) {
      throw new BadRequestException(`${dto.movementType} amount must be positive`);
    }

    if (!dto.reason?.trim()) throw new BadRequestException('A reason is required for a cash movement');
    if (!dto.counterpartAccountId) throw new BadRequestException('Select the expense, safe or transfer account for this movement');
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
      const register = await tx.cashRegister.findFirst({ where: { id: session.cashRegisterId, organizationId } });
      if (register?.defaultAccountId === dto.counterpartAccountId) throw new BadRequestException('The counterpart must differ from the drawer account');
      const otherDrawer = await tx.cashRegister.findFirst({ where: { organizationId, defaultAccountId: dto.counterpartAccountId, sessions: { some: { status: 'open' } } } });
      if (otherDrawer) throw new BadRequestException('Transfer through the safe; a one-sided movement cannot alter another open drawer');

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
    movementType: 'sale' | 'refund',
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

  /** Record a bank deposit against a session. Bounded by cash on hand (H5). */
  async recordBankDeposit(sessionId: string, dto: BankDepositDto) {
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;

    return this.prisma.client.$transaction(async (tx: any) => {
      const session = await tx.cashSession.findFirst({
        where: { id: sessionId, organizationId },
      });
      if (!session) throw new NotFoundException('Cash session not found');
      // Banking usually happens on the open drawer, but the cash is often only
      // carried to the bank after the Z-read. A closed session must still be
      // bankable — otherwise its counted cash stays on the drawer ledger for
      // ever and the next open fails with "Opening count is below the drawer
      // ledger". A reconciled session is final.
      await tx.$queryRawUnsafe('SELECT id FROM "CashSession" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', sessionId, organizationId);
      if (session.status === 'reconciled') throw new BadRequestException('This session is reconciled; record the movement in treasury instead');
      if (!dto.destinationAccountId) throw new BadRequestException('Select the destination bank account');

      const amt = dec(dto.amount);
      if (amt.lessThanOrEqualTo(0)) throw new BadRequestException('Deposit amount must be positive');

      // H5 — cannot bank more than is actually in the drawer. An open drawer is
      // bounded by its running expected cash; a closed one by what was counted
      // at close, less anything already taken out of it since.
      const previousBanked = session.bankedAmount ? dec(session.bankedAmount) : ZERO;
      let onHand = await this.computeExpected(tx, session);
      if (session.status === 'closed' && session.closingCounted != null) {
        const takenSinceClose = (await tx.cashMovement.findMany({
          where: { organizationId, cashSessionId: session.id, movementType: 'pay_out' as any, createdAt: { gt: session.closedAt ?? new Date(0) } },
        })).reduce((sum: any, m: any) => sum.plus(dec(m.amount)), ZERO);
        onHand = dec(session.closingCounted).minus(takenSinceClose);
      }
      if (amt.greaterThan(onHand)) {
        throw new BadRequestException(
          `Deposit ${amt.toString()} exceeds cash on hand ${onHand.toString()}`,
        );
      }

      // Record as a pay_out movement.
      const movement = await tx.cashMovement.create({
        data: {
          organizationId,
          cashSessionId: session.id,
          movementType: 'pay_out' as any,
          amount: amt,
          reason: `Bank deposit: ${dto.bankName}${dto.reference ? ` ref:${dto.reference}` : ''}${dto.notes ? ` — ${dto.notes}` : ''}`,
          performedBy: userId ?? null,
        },
      });

      // C1 — Dr Bank / Cr register cash.
      await this.postBankDepositGl(tx, session, amt, movement.id, dto.bankName, dto.destinationAccountId);

      await this.audit.recordInTx(tx, {
        entity: 'CashMovement',
        entityId: movement.id,
        action: 'create',
        newValues: { cashSessionId: session.id, movementType: 'pay_out', amount: amt.toString(), reason: 'bank_deposit' },
      });

      // Accumulate banked amount on the session
      await tx.cashSession.update({
        where: { id: session.id },
        data: {
          bankedAmount: previousBanked.plus(amt),
          bankName: dto.bankName,
        },
      });

      this.events.publish('cash.banking.recorded', {
        organizationId,
        sessionId: session.id,
        amount: amt.toString(),
        bankName: dto.bankName,
      });

      const outcome = { movement, sessionId: session.id };
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

      const updateData: any = { varianceReason: dto.reason };
      if (dto.status) updateData.varianceStatus = dto.status;

      // C3 — only a manager who is NOT the session cashier may approve a variance.
      if (dto.status === 'approved') {
        const manager = await this.assertManagerApproval(tx, {
          approverId: dto.approvedById ?? this.tenant.userId ?? undefined,
          cashierUserId: session.userId,
          permission: 'cash_session:approve_variance',
          actionLabel: 'a cash variance',
        });
        updateData.approvedById = manager.id;
      }

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
        status: { not: 'reconciled' },
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
        else if (m.movementType === 'adjustment') adjustments = adjustments.plus(amt);
      }

      const opening = dec(s.openingFloat);
      const expected = opening.plus(sales).plus(payIns).plus(adjustments).minus(payOuts).minus(refunds).minus(banked);
      const actual = s.closingCounted ? dec(s.closingCounted) : null;
      const variance = actual ? actual.minus(expected) : null;

      grandOpening = grandOpening.plus(opening);
      grandSales = grandSales.plus(sales);
      grandPayIns = grandPayIns.plus(payIns);
      grandPayOuts = grandPayOuts.plus(payOuts);
      grandRefunds = grandRefunds.plus(refunds);
      grandBanked = grandBanked.plus(banked);

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

    const grandExpected = grandOpening.plus(grandSales).plus(grandPayIns).minus(grandPayOuts).minus(grandRefunds).minus(grandBanked);

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
   * Reopen a CLOSED (not-yet-reconciled) session. Manager-only, segregated from
   * the cashier, reason required, fully audited. Any variance journal posted at
   * close is reversed so a subsequent close doesn't double-book. Reconciled
   * sessions are immutable and cannot be reopened.
   */
  async reopen(sessionId: string, reason: string) {
    const organizationId = this.tenant.organizationId;
    const actorId = this.tenant.userId;
    if (!reason || !reason.trim()) throw new BadRequestException('A reason is required to reopen a session');

    return this.prisma.client.$transaction(async (tx: any) => {
      const session = await tx.cashSession.findFirst({ where: { id: sessionId, organizationId } });
      if (!session) throw new NotFoundException('Cash session not found');
      if (session.status === 'open') throw new BadRequestException('Session is already open');
      if (session.status === 'reconciled') {
        throw new BadRequestException('A reconciled session is final and cannot be reopened');
      }
      if (await tx.posReportSnapshot.findUnique({ where: { cashSessionId: sessionId } })) throw new BadRequestException('This shift has a frozen Z-report. Record corrections in a new shift.');
      // C3 — the cashier who ran the shift cannot reopen their own session.
      if (actorId && actorId === session.userId) {
        throw new ForbiddenException('The session cashier cannot reopen their own session');
      }

      // Reverse the close-variance GL entry, if one was posted.
      const varianceEntry = await tx.journalEntry.findFirst({
        where: { organizationId, sourceType: 'cash_session_variance', sourceId: session.id, status: 'posted' },
      });
      if (varianceEntry) {
        try {
          await this.posting.reverse(varianceEntry.id, { description: `Reopen session ${session.id}` }, tx);
        } catch (e) {
          this.logger.warn(`Could not reverse variance entry on reopen: ${String(e)}`);
        }
      }

      await tx.cashSession.updateMany({
        where: { id: session.id },
        data: {
          status: 'open',
          closedAt: null,
          closingCounted: null,
          closingExpected: null,
          closingDifference: null,
          closingByMethod: Prisma.DbNull,
          varianceStatus: null,
          approvedById: null,
          reopenedAt: new Date(),
          reopenedById: actorId ?? null,
          notes: `${session.notes ? session.notes + ' | ' : ''}Reopened: ${reason.trim()}`,
        },
      });

      // Drop the frozen Z snapshot — a reopened shift's numbers will change.
      await tx.posReportSnapshot.deleteMany({ where: { cashSessionId: session.id } });

      await this.audit.recordInTx(tx, {
        entity: 'CashSession',
        entityId: session.id,
        action: 'update',
        oldValues: { status: session.status },
        newValues: { status: 'open', kind: 'reopen', reopenedById: actorId ?? null, reason: reason.trim() },
      });

      const result = await tx.cashSession.findFirst({ where: { id: session.id } });
      await recordBusinessOutcome(tx, result, true);
      return result;
    });
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
      if (Number.isFinite(f) && f > 0 && Number.isFinite(c) && c >= 0) out[String(f)] = Math.floor(c);
    }
    return Object.keys(out).length ? out : Prisma.DbNull;
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
      throw new BadRequestException(`${actionLabel} requires manager approval`);
    }
    if (!manager) throw new NotFoundException('Approving manager not found');
    if (manager.id === cashierUserId) {
      throw new ForbiddenException(`The session cashier cannot approve ${actionLabel}`);
    }
    if (!managerPin && manager.id !== this.tenant.userId) throw new BadRequestException('Manager PIN is required');
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

  private async registerCashAccount(tx: any, session: any): Promise<string> {
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
      const base = { date, sourceType: 'cash_movement', sourceId: movementId, branchId: session.branchId ?? undefined } as const;

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
        branchId: session.branchId ?? undefined,
        lines,
      }, tx);
    } catch (e) {
      throw e;
    }
  }

}
