/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IDEMPOTENT_KEY, IDEMPOTENT_REQUIRED_KEY, Idempotent } from './idempotent.decorator';

/**
 * Audit F-04 — a money-mutating POS route must not run without an
 * `Idempotency-Key`.
 *
 * The defect: with no key the interceptor simply ran the handler, so every
 * duplicate-payment defence was opt-in from the client's side. The shipped web
 * terminal always sends one, but any other caller — the Android APK, a script, a
 * retried curl — could double-post `/pos/checkout` and create two complete
 * sales, because with no key there is no `clientOperationKey` and the unique
 * index on it does not bind for NULLs.
 */
describe('IdempotencyInterceptor — a required key is required (F-04)', () => {
  const makeContext = (headers: Record<string, string>) => ({
    switchToHttp: () => ({
      getRequest: () => ({ headers, method: 'POST', originalUrl: '/api/v1/pos/checkout', body: {}, rawBody: Buffer.from('{}') }),
      getResponse: () => ({ status: jest.fn() }),
    }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  }) as any;

  const next = { handle: () => of({ ok: true }) } as any;

  const interceptorWith = (flags: Record<string, boolean>, service: any = { execute: jest.fn() }) => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => flags[key]),
    } as any;
    return new IdempotencyInterceptor(reflector, service);
  };

  it('refuses a keyless request on a route marked required', () => {
    const interceptor = interceptorWith({ [IDEMPOTENT_KEY]: true, [IDEMPOTENT_REQUIRED_KEY]: true });
    expect(() => interceptor.intercept(makeContext({}), next)).toThrow(BadRequestException);
    expect(() => interceptor.intercept(makeContext({}), next)).toThrow(/Idempotency-Key header is required/i);
  });

  it('refuses a blank key just as firmly as a missing one', () => {
    const interceptor = interceptorWith({ [IDEMPOTENT_KEY]: true, [IDEMPOTENT_REQUIRED_KEY]: true });
    expect(() => interceptor.intercept(makeContext({ 'idempotency-key': '   ' }), next)).toThrow(BadRequestException);
  });

  it('runs the protected path when a key is present', () => {
    const service = { execute: jest.fn().mockResolvedValue({ replayed: false, statusCode: 200, body: { ok: true } }) };
    const interceptor = interceptorWith({ [IDEMPOTENT_KEY]: true, [IDEMPOTENT_REQUIRED_KEY]: true }, service);
    interceptor.intercept(makeContext({ 'idempotency-key': 'k-1' }), next);
    expect(service.execute).toHaveBeenCalled();
  });

  it('leaves an unmarked route alone entirely', () => {
    const service = { execute: jest.fn() };
    const interceptor = interceptorWith({ [IDEMPOTENT_KEY]: false, [IDEMPOTENT_REQUIRED_KEY]: false }, service);
    interceptor.intercept(makeContext({}), next);
    expect(service.execute).not.toHaveBeenCalled();
  });

  it('still allows an optional-key route to run without one (unchanged behaviour)', () => {
    const service = { execute: jest.fn().mockResolvedValue({ replayed: false, statusCode: 200, body: {} }) };
    const interceptor = interceptorWith({ [IDEMPOTENT_KEY]: true, [IDEMPOTENT_REQUIRED_KEY]: false }, service);
    expect(() => interceptor.intercept(makeContext({}), next)).not.toThrow();
    expect(service.execute).toHaveBeenCalled();
  });

  it('the decorator records both flags', () => {
    class Probe {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      run() {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(Probe.prototype, 'run')!;
    Idempotent({ required: true })(Probe.prototype, 'run', descriptor);
    expect(Reflect.getMetadata(IDEMPOTENT_KEY, descriptor.value)).toBe(true);
    expect(Reflect.getMetadata(IDEMPOTENT_REQUIRED_KEY, descriptor.value)).toBe(true);
  });

  it('defaults to not-required so existing routes keep their behaviour', () => {
    class Probe {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      run() {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(Probe.prototype, 'run')!;
    Idempotent()(Probe.prototype, 'run', descriptor);
    expect(Reflect.getMetadata(IDEMPOTENT_KEY, descriptor.value)).toBe(true);
    expect(Reflect.getMetadata(IDEMPOTENT_REQUIRED_KEY, descriptor.value)).toBe(false);
  });
});
