import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { dec, ZERO } from '../../../kernel/common/money';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { AuditService } from '../../../kernel/audit/audit.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OpenSessionDto {
  cashRegisterId: string;
  openingFloat?: number | string;
  notes?: string;
}

export interface CloseSessionDto {
  closingCounted: number | string;
  notes?: string;
}

export interface RecordMovementDto {
  movementType: 'pay_in' | 'pay_out' | 'adjustment';
  amount: number | string;
  reason?: string;
}

export interface BankDepositDto {
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

/**
 * CashSessionService — opens / closes a cashier shift and records every
 * in/out during the shift. M5 foundation for POS and School canteen.
 *
 * Each open session knows its cash register, its opening float, the user
 * (cashier) running it. Cash movements link to Payment rows for sales /
 * refunds so the session reconciles with the ledger at close.
 */
@Injectable()
export class CashSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  /** Open a new session. Fails if there is already an open session for this register. */
  async open(dto: OpenSessionDto) {
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;
    if (!userId) throw new BadRequestException('No user in tenant context');

    return this.prisma.client.$transaction(async (tx: any) => {
      const register = await tx.cashRegister.findFirst({ where: { id: dto.cashRegisterId, organizationId } });
      if (!register) throw new NotFoundException('Cash register not found');

      const existing = await tx.cashSession.findFirst({
        where: { organizationId, cashRegisterId: dto.cashRegisterId, status: 'open' },
      });
      if (existing) {
        throw new BadRequestException(`A session is already open on register ${register.code}`);
      }

      const session = await tx.cashSession.create({
        data: {
          organizationId,
          cashRegisterId: dto.cashRegisterId,
          userId,
          status: 'open',
          openingFloat: dec(dto.openingFloat ?? 0),
          notes: dto.notes ?? null,
        },
      });

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

      return session;
    });
  }

  /** Close the current open session. Computes expected vs counted. */
  async close(dto: CloseSessionDto) {
    const organizationId = this.tenant.organizationId;
    const counted = dec(dto.closingCounted);

    return this.prisma.client.$transaction(async (tx: any) => {
      const session = await this.requireOpenSession(tx);
      const expected = await this.computeExpected(tx, session);

      const closingDifference = counted.minus(expected);

      const updated = await tx.cashSession.updateMany({
        where: { id: session.id },
        data: {
          status: 'closed',
          closedAt: new Date(),
          closingCounted: counted,
          closingExpected: expected,
          closingDifference,
          notes: dto.notes ?? session.notes,
        },
      });
      if (updated.count === 0) throw new Error('Failed to close session');

      await this.audit.recordInTx(tx, {
        entity: 'CashSession',
        entityId: session.id,
        action: 'update',
        oldValues: { status: 'open' },
        newValues: { status: 'closed', closingDifference: closingDifference.toString() },
      });

      this.events.publish('cash.session.closed', {
        organizationId,
        sessionId: session.id,
        expected: expected.toString(),
        counted: counted.toString(),
        variance: closingDifference.toString(),
      });

      return tx.cashSession.findFirst({ where: { id: session.id } });
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
          // CashSession has no dedicated variance-reason column; keep it on notes.
          notes: dto.varianceReason
            ? `${outgoing.notes ? outgoing.notes + ' | ' : ''}Handover variance: ${dto.varianceReason}`
            : outgoing.notes,
        },
      });

      const opening = dto.openingFloat != null ? dec(dto.openingFloat) : counted;
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

      return {
        outgoingSessionId: outgoing.id,
        incomingSessionId: incoming.id,
        expected: expected.toString(),
        counted: counted.toString(),
        variance: variance.toString(),
      };
    });
  }

  /** Record a manual movement (pay-in, pay-out, adjustment). */
  async recordMovement(sessionId: string | undefined, dto: RecordMovementDto) {
    const organizationId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      const session = sessionId
        ? await tx.cashSession.findFirst({ where: { id: sessionId, organizationId } })
        : await tx.cashSession.findFirst({ where: { organizationId, status: 'open' } });
      if (!session) throw new NotFoundException('No open cash session');
      if (session.status !== 'open') throw new BadRequestException('Session is not open');

      const movement = await tx.cashMovement.create({
        data: {
          organizationId,
          cashSessionId: session.id,
          movementType: dto.movementType,
          amount: dec(dto.amount),
          reason: dto.reason ?? null,
          performedBy: this.tenant.userId ?? null,
        },
      });

      await this.audit.recordInTx(tx, {
        entity: 'CashMovement',
        entityId: movement.id,
        action: 'create',
        newValues: { cashSessionId: session.id, movementType: dto.movementType, amount: dec(dto.amount).toString() },
      });

      this.events.publish('cash.movement.recorded', {
        organizationId,
        sessionId: session.id,
        movementId: movement.id,
        movementType: dto.movementType,
        amount: dec(dto.amount).toString(),
      });

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

  /** Get the open session for the current user/cash register (or null). */
  async findOpen(cashRegisterId?: string) {
    const where: any = { organizationId: this.tenant.organizationId, status: 'open' };
    if (cashRegisterId) where.cashRegisterId = cashRegisterId;
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

    const runningTotal = dec(session.openingFloat);
    const trail = session.movements.map((m: any) => {
      const amt = dec(m.amount);
      switch (m.movementType) {
        case 'sale':
        case 'pay_in':
          runningTotal.plus(amt);
          break;
        case 'refund':
        case 'pay_out':
          runningTotal.minus(amt);
          break;
        default:
          runningTotal.plus(amt);
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
        runningTotal: runningTotal.toString(),
      };
    });

    // Recompute fresh running total without mutations
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
        bankedAmount: (session as any).bankedAmount ? dec((session as any).bankedAmount).toString() : null,
        bankName: (session as any).bankName ?? null,
        varianceReason: (session as any).varianceReason ?? null,
        varianceStatus: (session as any).varianceStatus ?? null,
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
        movementCount: s._count.movements,
        varianceReason: (s as any).varianceReason ?? null,
        varianceStatus: (s as any).varianceStatus ?? null,
        notes: s.notes,
      })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    };
  }

  /** Record a bank deposit against a closed session. */
  async recordBankDeposit(sessionId: string, dto: BankDepositDto) {
    const organizationId = this.tenant.organizationId;
    const userId = this.tenant.userId;

    return this.prisma.client.$transaction(async (tx: any) => {
      const session = await tx.cashSession.findFirst({
        where: { id: sessionId, organizationId },
      });
      if (!session) throw new NotFoundException('Cash session not found');
      if (session.status === 'open') throw new BadRequestException('Cannot bank on an open session. Close it first.');

      // Record as a special movement
      const movement = await tx.cashMovement.create({
        data: {
          organizationId,
          cashSessionId: session.id,
          movementType: 'pay_out' as any,
          amount: dec(dto.amount),
          reason: `Bank deposit: ${dto.bankName}${dto.reference ? ` ref:${dto.reference}` : ''}${dto.notes ? ` — ${dto.notes}` : ''}`,
          performedBy: userId ?? null,
        },
      });

      await this.audit.recordInTx(tx, {
        entity: 'CashMovement',
        entityId: movement.id,
        action: 'create',
        newValues: { cashSessionId: session.id, movementType: 'pay_out', amount: dec(dto.amount).toString(), reason: 'bank_deposit' },
      });

      // Update session notes with banking info if not already set
      const bankNote = `Banked: ${dec(dto.amount).toString()} to ${dto.bankName}${dto.reference ? ` (${dto.reference})` : ''}`;
      await tx.cashSession.update({
        where: { id: session.id },
        data: {
          notes: session.notes ? `${session.notes}\n${bankNote}` : bankNote,
        },
      });

      this.events.publish('cash.banking.recorded', {
        organizationId,
        sessionId: session.id,
        amount: dec(dto.amount).toString(),
        bankName: dto.bankName,
      });

      return { movement, sessionId: session.id };
    });
  }

  /** Update variance explanation and status. */
  async updateVariance(sessionId: string, dto: VarianceUpdateDto) {
    const organizationId = this.tenant.organizationId;
    return this.prisma.client.$transaction(async (tx: any) => {
      const session = await tx.cashSession.findFirst({
        where: { id: sessionId, organizationId },
      });
      if (!session) throw new NotFoundException('Cash session not found');

      const updateData: any = { varianceReason: dto.reason };
      if (dto.status) updateData.varianceStatus = dto.status;
      if (dto.approvedById) updateData.approvedById = dto.approvedById;

      await tx.cashSession.update({ where: { id: session.id }, data: updateData });

      await this.audit.recordInTx(tx, {
        entity: 'CashSession',
        entityId: session.id,
        action: 'update',
        oldValues: { varianceReason: (session as any).varianceReason, varianceStatus: (session as any).varianceStatus },
        newValues: updateData,
      });

      return tx.cashSession.findFirst({ where: { id: session.id } });
    });
  }

  /** Daily reconciliation report — aggregates all sessions for a given date. */
  async dailyReconciliation(dateStr: string) {
    const organizationId = this.tenant.organizationId;
    const start = new Date(dateStr);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Invalid date');
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

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

      for (const m of s.movements) {
        const amt = dec(m.amount);
        if (m.movementType === 'sale') sales = sales.plus(amt);
        else if (m.movementType === 'pay_in') payIns = payIns.plus(amt);
        else if (m.movementType === 'pay_out') {
          if ((m.reason ?? '').startsWith('Bank deposit:')) banked = banked.plus(amt);
          else payOuts = payOuts.plus(amt);
        }
        else if (m.movementType === 'refund') refunds = refunds.plus(amt);
      }

      const opening = dec(s.openingFloat);
      const expected = opening.plus(sales).plus(payIns).minus(payOuts).minus(refunds).minus(banked);
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
        cashierName: '', // userId not resolved here
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
        varianceReason: (s as any).varianceReason ?? null,
        bankedAmount: banked.toString(),
      });
    }

    const grandExpected = grandOpening.plus(grandSales).plus(grandPayIns).minus(grandPayOuts).minus(grandRefunds).minus(grandBanked);

    return {
      date: start.toISOString().slice(0, 10),
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

  // ─── helpers ────────────────────────────────────────────────────────────
  private async requireOpenSession(tx: any) {
    const session = await tx.cashSession.findFirst({
      where: { organizationId: this.tenant.organizationId, status: 'open' },
    });
    if (!session) throw new NotFoundException('No open cash session');
    return session;
  }

  /**
   * expected = opening + Σ(sales) + Σ(pay_in) − Σ(pay_out) − Σ(refunds)
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
          // Adjustments are signed: positive = adds cash, negative = removes.
          total = total.plus(amt);
          break;
      }
    }
    return total;
  }
}