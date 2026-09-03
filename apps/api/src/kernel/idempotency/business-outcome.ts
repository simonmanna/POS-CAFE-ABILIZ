import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export const businessOperation = new AsyncLocalStorage<{ organizationId: string; key: string; path: string; approvedById?: string; approvedKind?: string; recovery?: any }>();

export function approvalPayloadHash(payload: any): string {
  const { approvalToken: _token, overridePin: _pin, ...body } = payload ?? {};
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, canonical(value[k])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}

/** Save recovery evidence in the SAME transaction as its business records. */
export async function recordBusinessOutcome(tx: any, body: any, complete = false): Promise<void> {
  const op = businessOperation.getStore();
  if (!op) return;
  const where = { organizationId_key: { organizationId: op.organizationId, key: op.key } };
  const current = await tx.idempotencyRecord.findUnique({ where });
  if (!current) throw new Error('Durable operation record is missing');
  await tx.idempotencyRecord.update({ where, data: {
    responseJson: JSON.parse(JSON.stringify({ ...(current.responseJson ?? {}), ...body })),
    ...(complete ? { status: 'business_completed', statusCode: 201, completedAt: new Date() } : {}),
  } });
}
