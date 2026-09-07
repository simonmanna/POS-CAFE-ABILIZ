import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent:enabled';
export const IDEMPOTENT_REQUIRED_KEY = 'idempotent:required';

export interface IdempotentOptions {
  /**
   * Refuse the request outright when no `Idempotency-Key` header is supplied.
   *
   * Audit F-04 — without a key the interceptor simply ran the handler, so every
   * duplicate-payment defence was opt-in from the client's side. The shipped web
   * terminal always sends one, but any other caller (the Android APK, a script,
   * a retried curl) could double-post `/pos/checkout` and create two complete
   * sales: with no key there is no `clientOperationKey`, and the partial unique
   * index on it does not bind for NULLs. Money-mutating POS routes therefore
   * make the header mandatory rather than advisory.
   */
  required?: boolean;
}

/**
 * Mark a controller route as idempotency-protected.
 *
 * When the route is hit, the IdempotencyInterceptor reads the
 * `Idempotency-Key` header. Retries with the same key + body replay the cached
 * response instead of re-running the handler.
 *
 * `{ required: true }` additionally rejects a request that omits the header —
 * use it wherever running the handler twice would move money.
 *
 * Apply to POST/PUT/PATCH/DELETE on money-mutating endpoints.
 */
export const Idempotent = (options: IdempotentOptions = {}): MethodDecorator & ClassDecorator => {
  const enabled = SetMetadata(IDEMPOTENT_KEY, true);
  const required = SetMetadata(IDEMPOTENT_REQUIRED_KEY, options.required === true);
  return ((target: any, key?: any, descriptor?: any) => {
    enabled(target, key, descriptor);
    required(target, key, descriptor);
    return descriptor ?? target;
  }) as MethodDecorator & ClassDecorator;
};
