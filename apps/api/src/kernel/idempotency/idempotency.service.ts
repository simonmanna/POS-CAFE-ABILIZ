import {
  ConflictException,
  Injectable,
  HttpException,
  Logger,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { approvalPayloadHash, businessOperation } from './business-outcome';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Routes whose handlers save their business outcome in the SAME transaction as
 * the money write (`recordBusinessOutcome`). For these an idempotency record
 * that is still `pending` with no saved outcome provably committed nothing, so
 * a retry after a crash or timeout may safely run again.
 */
const OUTCOME_ROUTES = /\/(pos\/(checkout|tabs\/[^/]+\/settle|orders\/[^/]+\/settle|split-bills\/[^/]+\/settle|invoices\/[^/]+\/(payments|refund)|sales\/[^/]+\/void|shift\/handover)|cash-sessions\/(open|close|movement|tender-settlements|[^/]+\/(banking|force-close|reconcile))|accounts\/cash-flow\/(deposit|withdraw)|treasury\/transfer|expenses(\/[^/]+\/(pay|void))?|payments(\/[^/]+\/void)?|supplier-payments)$/;
/** A pending record older than this with no outcome is an abandoned attempt. */
const ABANDONED_AFTER_MS = 2 * 60_000;

export interface IdempotencyResult {
  /** True when we returned a cached response and did not run the handler. */
  replayed: boolean;
  statusCode: number;
  body: any;
}

/**
 * Idempotency-Key handling (D1-2).
 *
 * The caller (decorator + interceptor) provides the raw Express request and a
 * callback that runs the actual handler. We:
 *   1. Hash (method + path + rawBody) and look for a matching `IdempotencyRecord`.
 *   2. If found AND completed AND hash matches → return the cached response
 *      (`replayed: true`). The handler does not run.
 *   3. If found AND completed AND hash mismatches → 409 (same key, different body).
 *   4. If found AND pending → 409 (another request is still in flight).
 *   5. If not found → INSERT a `pending` row first (using ON CONFLICT semantics),
 *      run the handler, then UPDATE the row with the response and
 *      `status='completed'`.
 *
 * The pending INSERT acts as a distributed lock per (organizationId, key): only
 * one concurrent caller can hold the row, the rest see the conflict and 409.
 * On handler failure we DELETE the pending row so the caller can retry with
 * the same key.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger('IdempotencyService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Run `runHandler` under the protection of an idempotency key. The handler
   * MUST execute its business write inside a Prisma transaction (pass `tx` if
   * needed) so that the cached response reflects what actually committed.
   */
  async execute<T>(params: {
    request: Request;
    rawBody: string;
    runHandler: () => Promise<{ statusCode: number; body: T }>;
  }): Promise<IdempotencyResult> {
    const key = this.readKey(params.request);
    if (!key) {
      // No key header → not protected; just run the handler.
      const { statusCode, body } = await params.runHandler();
      return { replayed: false, statusCode, body };
    }

    const method = params.request.method;
    const path = params.request.originalUrl ?? params.request.url;
    return this.executeWithKey({
      key,
      requestHash: this.hashRequest(method, path, params.rawBody),
      method,
      path,
      payload: params.request.body,
      runHandler: params.runHandler,
    });
  }

  /**
   * Transport-agnostic core of `execute`. Callers that are not an Express
   * request/response pair (e.g. the sync push batch processor, which runs one
   * idempotency key per offline operation) provide the key and request hash
   * directly. Same semantics: pending row = distributed lock, completed row =
   * replay cache, hash mismatch = 409.
   */
  async executeWithKey<T>(params: {
    key: string;
    requestHash: string;
    /** Recorded on the IdempotencyRecord row for observability. */
    method?: string;
    path?: string;
    payload?: any;
    runHandler: () => Promise<{ statusCode: number; body: T }>;
  }): Promise<IdempotencyResult> {
    const { key, requestHash } = params;
    const method = params.method ?? 'OP';
    const path = params.path ?? 'sync';
    const organizationId = this.tenant.organizationId;
    const recoverableSale = /\/pos\/(checkout|tabs\/[^/]+\/settle|orders\/[^/]+\/settle)$/.test(path);
    let recovery: any;

    // 1) Look for an existing record.
    const existing = await this.prisma.client.idempotencyRecord.findUnique({
      where: { organizationId_key: { organizationId, key } },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException(
          `Idempotency-Key '${key}' was previously used with a different request body`,
        );
      }
      if (existing.status === 'pending' || existing.status === 'indeterminate') {
        const noOutcome = Object.keys((existing.responseJson ?? {}) as object).length === 0;
        const abandoned = OUTCOME_ROUTES.test(path.split('?')[0]) && noOutcome && Date.now() - new Date(existing.createdAt).getTime() > ABANDONED_AFTER_MS;
        if (recoverableSale) recovery = existing.responseJson;
        else if (abandoned) {
          // Nothing committed under this key (the outcome is written in the same
          // transaction as the money). Release the lock and run the request again.
          await this.prisma.client.idempotencyRecord.deleteMany({ where: { organizationId, key, status: existing.status, responseJson: { equals: {} } } });
          this.logger.warn(`Operation ${key} on ${path} was abandoned without an outcome; re-running`);
          return this.executeWithKey(params);
        }
        else throw new ConflictException({ code: 'OPERATION_PENDING', message: 'This operation needs recovery; do not submit it with a new key. Retry with the same key.', operationKey: key, recovery: existing.responseJson });
      } else {
        return { replayed: true, statusCode: existing.statusCode, body: existing.responseJson };
      }
    }

    // 2) Insert a pending row first to act as a lock. The unique constraint on
    //    (organizationId, key) ensures only one writer wins.
    if (!existing) try {
      await this.prisma.client.idempotencyRecord.create({
        data: {
          organizationId,
          key,
          requestHash,
          method,
          path,
          statusCode: 0,
          responseJson: {},
          status: 'pending',
        },
      });
    } catch (err) {
      // Another concurrent request beat us to it. Read its state and respond.
      const winner = await this.prisma.client.idempotencyRecord.findUnique({
        where: { organizationId_key: { organizationId, key } },
      });
      if (winner && winner.requestHash !== requestHash) throw new ConflictException('Idempotency key was used with a different request');
      if (winner && ['completed', 'business_completed'].includes(winner.status)) {
        return { replayed: true, statusCode: winner.statusCode, body: winner.responseJson };
      }
      throw new ConflictException(
        `Idempotency-Key '${key}' is being processed concurrently; retry shortly`,
      );
    }

    // 3) Run the handler.
    try {
      let approvedById: string | undefined;
      let approvedKind: string | undefined;
      if (params.payload?.approvalToken) {
        const grant = await (this.prisma.client as any).posApprovalGrant.findFirst({ where: { organizationId, tokenHash: createHash('sha256').update(params.payload.approvalToken).digest('hex') } });
        if (!grant || grant.cashierId !== this.tenant.userId || grant.operationKey !== key || !path.endsWith(grant.endpoint) || grant.payloadHash !== approvalPayloadHash(params.payload) || (!recovery?.orderId && grant.expiresAt < new Date())) throw new HttpException('Manager approval expired or does not match this operation', 403);
        approvedById = grant.managerId;
        approvedKind = grant.overrideKind;
      }
      const { statusCode, body } = await businessOperation.run({ organizationId, key, path, approvedById, approvedKind, recovery }, params.runHandler);
      await this.prisma.client.idempotencyRecord.update({
        where: { organizationId_key: { organizationId, key } },
        data: {
          statusCode,
          responseJson: body as any,
          status: 'completed',
          completedAt: new Date(),
        },
      });
      return { replayed: false, statusCode, body };
    } catch (err) {
      // A timeout/error can follow a successful business commit. Never delete
      // its protection. A transactionally saved outcome is replayable even when
      // the final response-cache write failed.
      const saved = await this.prisma.client.idempotencyRecord.findUnique({ where: { organizationId_key: { organizationId, key } } }).catch(() => null);
      if (saved?.status === 'business_completed' || saved?.status === 'completed') return { replayed: true, statusCode: saved.statusCode, body: saved.responseJson };
      // A definitive client error with no committed outcome: the request did
      // nothing. Cache the answer so a replay gets the same error, and tell the
      // client the operation is safe to retry with corrected input (new key).
      if (OUTCOME_ROUTES.test(path.split('?')[0]) && err instanceof HttpException && err.getStatus() < 500 && saved && Object.keys((saved.responseJson ?? {}) as object).length === 0) {
        const response = err.getResponse();
        const body = { ...(typeof response === 'object' ? response : { message: response }), safeToRetry: true };
        await this.prisma.client.idempotencyRecord.update({ where: { organizationId_key: { organizationId, key } }, data: { status: 'completed', statusCode: err.getStatus(), responseJson: body, completedAt: new Date() } });
        throw new HttpException(body, err.getStatus());
      }
      this.logger.warn(`Operation ${key} retained for recovery after failure`);
      throw err;
    }
  }

  private readKey(req: Request): string | undefined {
    const raw = req.headers['idempotency-key'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return undefined;
    const trimmed = String(value).trim();
    if (!trimmed) return undefined;
    if (trimmed.length > 200) {
      throw new ConflictException('Idempotency-Key header is too long (max 200 chars)');
    }
    return trimmed;
  }

  private hashRequest(method: string, path: string, rawBody: string): string {
    if (/\/cash-sessions\/|\/pos\/shift\/handover$/.test(path)) {
      const { managerPin: _manager, incomingPin: _incoming, ...financialPayload } = JSON.parse(rawBody || '{}');
      rawBody = JSON.stringify(financialPayload);
    }
    return createHash('sha256').update(`${method}\n${path}\n${rawBody}`).digest('hex');
  }

  /** Stable hash for non-HTTP callers (sync push ops). */
  hashPayload(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }
}
