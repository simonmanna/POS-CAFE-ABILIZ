import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { IdempotencyService } from '../../kernel/idempotency/idempotency.service';
import { resolveOccurredAt } from '../../kernel/common/occurred-at';
import { PosService } from '../pos/pos.service';
import { CashSessionService } from '../accounting/treasury/cash-session.service';
import type { RequestDevice } from './device-token.guard';
import type { SyncOpDto, SyncOpResult, SyncPushDto, SyncPushResult } from './dto/sync.dto';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * P1 offline sync — batch op processor.
 *
 * An offline device pushes its op queue in deviceSeq order. Each op:
 *   1. Runs inside a per-op TenantContext with identity = op.actorUserId, so
 *      audit trails / cashier attribution / drawer ownership are correct even
 *      though the transport auth is the device token, not a user JWT.
 *   2. Runs under IdempotencyService.executeWithKey(opId) — a re-pushed batch
 *      (dropped response, app restart) replays the cached result; nothing
 *      double-posts.
 *   3. On failure: the op is dead-lettered (SyncOpDeadLetter) and processing
 *      CONTINUES with independent ops, but ops that reference the failed op's
 *      clientId fail-fast too. Owner rule: never block sales; never lose them.
 */
@Injectable()
export class SyncPushService {
  private readonly logger = new Logger('SyncPushService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly idempotency: IdempotencyService,
    private readonly pos: PosService,
    private readonly cashSessions: CashSessionService,
  ) {}

  async push(device: RequestDevice, dto: SyncPushDto): Promise<SyncPushResult> {
    const ops = [...dto.ops].sort((a, b) => a.deviceSeq - b.deviceSeq);
    const results: SyncOpResult[] = [];
    /** clientId → server id, resolved as ops apply (session open → sales). */
    const clientIdMap = new Map<string, string>();
    /** clientIds owned by ops that failed — dependents must fail too. */
    const failedClientIds = new Set<string>();
    let lastAppliedSeq = 0;

    for (const op of ops) {
      const result = await this.applyOp(device, op, clientIdMap, failedClientIds);
      results.push(result);
      if (result.status !== 'failed') lastAppliedSeq = op.deviceSeq;
    }

    // Track sync progress on the device row (monotonic).
    await this.prisma.raw.posDevice
      .updateMany({
        where: { id: device.id, lastPushSeq: { lt: lastAppliedSeq } },
        data: { lastPushSeq: lastAppliedSeq },
      })
      .catch((e: unknown) => this.logger.warn(`lastPushSeq update failed: ${String(e)}`));

    return { results, lastPushSeq: lastAppliedSeq, serverTime: new Date().toISOString() };
  }

  private async applyOp(
    device: RequestDevice,
    op: SyncOpDto,
    clientIdMap: Map<string, string>,
    failedClientIds: Set<string>,
  ): Promise<SyncOpResult> {
    // Dependency check: an op whose payload references a clientId owned by a
    // FAILED op cannot be applied meaningfully (e.g. a sale against a cash
    // session whose open op was rejected).
    const referenced = this.referencedClientIds(op);
    const brokenDep = referenced.find((id) => failedClientIds.has(id));
    if (brokenDep) {
      await this.deadLetter(device, op, `Depends on failed op (clientId ${brokenDep})`, 424);
      if (op.payload?.clientId) failedClientIds.add(String(op.payload.clientId));
      return { opId: op.opId, status: 'failed', httpStatus: 424, error: `Depends on failed op (clientId ${brokenDep})` };
    }

    try {
      // Per-op identity: everything the handler writes (createdBy, audit,
      // drawer ownership) is attributed to the cashier who did it offline.
      const outcome = await this.tenant.run(
        { organizationId: device.organizationId, userId: op.actorUserId },
        () =>
          this.idempotency.executeWithKey({
            key: op.opId,
            requestHash: this.idempotency.hashPayload({ type: op.type, payload: op.payload }),
            method: 'SYNC',
            path: op.type,
            runHandler: async () => {
              const body = await this.runOp(device, op, clientIdMap);
              return { statusCode: 201, body };
            },
          }),
      );

      const body = outcome.body as any;
      // Re-establish the clientId mapping on replays too, so a re-pushed batch
      // resolves later ops' references identically.
      if (op.payload?.clientId && body?.id) {
        clientIdMap.set(String(op.payload.clientId), String(body.id));
      }

      return {
        opId: op.opId,
        status: outcome.replayed ? 'replayed' : 'applied',
        httpStatus: outcome.statusCode,
        error: null,
        mapping: body?.mapping,
        finalNumbers: body?.finalNumbers,
      };
    } catch (err: any) {
      const httpStatus = err instanceof HttpException ? err.getStatus() : 500;
      const message = err?.message ?? 'unknown error';
      this.logger.warn(`sync op ${op.opId} (${op.type}) failed: ${message}`);
      await this.deadLetter(device, op, message, httpStatus);
      if (op.payload?.clientId) failedClientIds.add(String(op.payload.clientId));
      return { opId: op.opId, status: 'failed', httpStatus, error: message };
    }
  }

  /** clientIds this op depends on (references created by earlier ops). */
  private referencedClientIds(op: SyncOpDto): string[] {
    const refs: string[] = [];
    const sessionRef = op.payload?.cashSessionId ?? op.payload?.sessionId;
    if (typeof sessionRef === 'string' && sessionRef) refs.push(sessionRef);
    return refs;
  }

  /** Swap client-minted ids for the server ids created earlier in the batch. */
  private resolveRefs(payload: Record<string, any>, clientIdMap: Map<string, string>): Record<string, any> {
    const out = { ...payload };
    for (const key of ['cashSessionId', 'sessionId']) {
      const v = out[key];
      if (typeof v === 'string' && clientIdMap.has(v)) out[key] = clientIdMap.get(v);
    }
    return out;
  }

  private async runOp(
    device: RequestDevice,
    op: SyncOpDto,
    clientIdMap: Map<string, string>,
  ): Promise<any> {
    // Validate the device timestamp once, up front.
    resolveOccurredAt(op.occurredAt);
    const payload = this.resolveRefs(op.payload ?? {}, clientIdMap);
    const occurredAt = op.occurredAt;

    switch (op.type) {
      case 'cash_session.open': {
        const session = await this.cashSessions.open({
          cashRegisterId: payload.cashRegisterId,
          openingFloat: payload.openingFloat,
          notes: payload.notes,
          openingDenomination: payload.openingDenomination,
          occurredAt,
        });
        if (payload.clientId) clientIdMap.set(String(payload.clientId), session.id);
        await this.stampDevice('cashSession', session.id, device.id);
        return { id: session.id, mapping: { [String(payload.clientId ?? 'sessionId')]: session.id } };
      }
      case 'cash_session.close': {
        const closed = await this.cashSessions.close({
          closingCounted: payload.closingCounted,
          notes: payload.notes,
          varianceReason: payload.varianceReason,
          varianceStatus: payload.varianceStatus,
          approvedById: payload.approvedById,
          approverEmail: payload.approverEmail,
          managerPin: payload.managerPin,
          closingDenomination: payload.closingDenomination,
          occurredAt,
        });
        return { id: (closed as any)?.id ?? null };
      }
      case 'cash_session.movement': {
        const movement = await this.cashSessions.recordMovement(payload.sessionId, {
          movementType: payload.movementType,
          amount: payload.amount,
          reason: payload.reason,
          approvedById: payload.approvedById,
          approverEmail: payload.approverEmail,
          managerPin: payload.managerPin,
          occurredAt,
        });
        return { id: movement.id };
      }
      case 'sale.checkout': {
        const { clientId: _c, provisionalNumber, ...checkout } = payload;
        const res = await this.pos.checkout({ ...checkout, occurredAt } as any);
        await this.stampSale(res, device.id, provisionalNumber);
        return {
          id: res.invoiceId,
          mapping: { invoiceId: res.invoiceId, orderId: res.orderId, receiptId: res.receiptId ?? '' },
          finalNumbers: { invoiceNumber: res.invoiceNumber, orderNumber: res.orderNumber },
        };
      }
      case 'tab.settle': {
        const { clientId: _c2, provisionalNumber, tableId, ...settle } = payload;
        const res = await this.pos.settleTab({ tableId, ...settle, occurredAt } as any);
        await this.stampSale(res as any, device.id, provisionalNumber);
        return {
          id: (res as any).invoiceId,
          mapping: { invoiceId: (res as any).invoiceId },
          finalNumbers: { invoiceNumber: (res as any).invoiceNumber ?? '' },
        };
      }
      default:
        throw new HttpException(`Unsupported sync op type: ${op.type}`, 400);
    }
  }

  /** Record which device captured the sale + the number it printed offline. */
  private async stampSale(
    res: { invoiceId?: string; orderId?: string; receiptId?: string },
    deviceId: string,
    provisionalNumber?: string,
  ): Promise<void> {
    const c = this.prisma.raw as any;
    try {
      if (res.invoiceId) {
        await c.invoice.updateMany({
          where: { id: res.invoiceId },
          data: { deviceId, ...(provisionalNumber ? { provisionalNumber } : {}) },
        });
      }
      if (res.orderId) {
        await c.order.updateMany({
          where: { id: res.orderId },
          data: { deviceId, ...(provisionalNumber ? { provisionalNumber } : {}) },
        });
      }
      if (res.receiptId) {
        await c.receipt.updateMany({
          where: { id: res.receiptId },
          data: { deviceId, ...(provisionalNumber ? { provisionalNumber } : {}) },
        });
      }
    } catch (e) {
      // Metadata only — never fail a recorded sale over it.
      this.logger.warn(`stampSale failed: ${String(e)}`);
    }
  }

  private async stampDevice(model: 'cashSession', id: string, deviceId: string): Promise<void> {
    try {
      await (this.prisma.raw as any)[model].updateMany({ where: { id }, data: { deviceId } });
    } catch (e) {
      this.logger.warn(`stampDevice failed: ${String(e)}`);
    }
  }

  private async deadLetter(device: RequestDevice, op: SyncOpDto, error: string, httpStatus: number): Promise<void> {
    try {
      await this.prisma.raw.syncOpDeadLetter.upsert({
        where: { organizationId_opId: { organizationId: device.organizationId, opId: op.opId } },
        create: {
          organizationId: device.organizationId,
          deviceId: device.id,
          opId: op.opId,
          deviceSeq: op.deviceSeq,
          opType: op.type,
          actorUserId: op.actorUserId ?? null,
          occurredAt: op.occurredAt ? new Date(op.occurredAt) : null,
          payload: op.payload as any,
          error,
          httpStatus,
        },
        update: { error, httpStatus },
      });
    } catch (e) {
      // Losing the dead-letter row would silently lose a money op — log loud.
      this.logger.error(`FAILED TO DEAD-LETTER sync op ${op.opId}: ${String(e)}`);
    }
  }
}
