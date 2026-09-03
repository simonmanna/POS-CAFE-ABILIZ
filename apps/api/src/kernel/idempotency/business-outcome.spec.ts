import { BadRequestException } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';
import { approvalPayloadHash, recordBusinessOutcome } from './business-outcome';

describe('Financial operation recovery', () => {
  function fixture() {
    let row: any = null;
    const record: any = {
      findUnique: jest.fn(async () => row && structuredClone(row)),
      create: jest.fn(async ({ data }) => { row = { ...data }; return row; }),
      update: jest.fn(async ({ data }) => { row = { ...row, ...data }; return row; }),
    };
    const client = { idempotencyRecord: record };
    const service = new IdempotencyService({ client } as any, { organizationId: 'org', userId: 'cashier' } as any);
    return { service, client, record, row: () => row };
  }

  it('returns committed money outcome when final response persistence fails', async () => {
    const f = fixture();
    const save = f.record.update.getMockImplementation();
    f.record.update.mockImplementation(async (args: any) => {
      if (args.data.status === 'completed') throw new Error('connection lost after business commit');
      return save(args);
    });
    const handler = jest.fn(async () => {
      await recordBusinessOutcome(f.client, { invoiceId: 'inv-1', paymentIds: ['pay-1'], total: 20 }, true);
      return { statusCode: 201, body: { invoiceId: 'inv-1' } };
    });
    const operation = { key: 'sale-key', requestHash: 'original-body', path: '/pos/checkout', runHandler: handler };
    const first = await f.service.executeWithKey(operation);
    expect(first.body.paymentIds).toEqual(['pay-1']);
    expect(f.row().status).toBe('business_completed');
    const retried = await f.service.executeWithKey(operation);
    expect(retried.body).toEqual(first.body);
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(f.service.executeWithKey({ ...operation, requestHash: 'edited-body' })).rejects.toThrow('different request body');
  });

  it('keeps an uncertain operation protected and does not rerun a refund', async () => {
    const f = fixture();
    const handler = jest.fn(async () => { throw new Error('unknown commit result'); });
    const operation = { key: 'refund-key', requestHash: 'body', path: '/pos/invoices/inv-1/refund', runHandler: handler };
    await expect(f.service.executeWithKey(operation)).rejects.toThrow('unknown commit');
    expect(f.row().status).toBe('pending');
    await expect(f.service.executeWithKey(operation)).rejects.toThrow('needs recovery');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('caches a definite no-write validation rejection as a failure, never a successful sale', async () => {
    const f = fixture();
    const handler = jest.fn(async () => { throw new BadRequestException('Insufficient credit'); });
    const operation = { key: 'invalid-key', requestHash: 'body', path: '/pos/checkout', runHandler: handler };
    await expect(f.service.executeWithKey(operation)).rejects.toThrow('Insufficient credit');
    const retry = await f.service.executeWithKey(operation);
    expect(retry.statusCode).toBe(400);
    expect(retry.body.safeToRetry).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('binds approval to every economic field while excluding the proof itself', () => {
    const body = { lines: [{ quantity: 2, unitPrice: 100 }], tenders: [{ method: 'card', accountId: 'bank1', amount: 200 }], overridePin: '1234' };
    expect(approvalPayloadHash(body)).toBe(approvalPayloadHash({ ...body, overridePin: undefined, approvalToken: 'proof' }));
    expect(approvalPayloadHash(body)).not.toBe(approvalPayloadHash({ ...body, tenders: [{ method: 'card', accountId: 'bank2', amount: 200 }] }));
  });
});
