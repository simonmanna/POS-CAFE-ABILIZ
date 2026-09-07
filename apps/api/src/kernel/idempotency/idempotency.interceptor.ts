import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  HttpException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, switchMap } from 'rxjs';
import type { Request } from 'express';
import { IdempotencyService } from './idempotency.service';
import { IDEMPOTENT_KEY, IDEMPOTENT_REQUIRED_KEY } from './idempotent.decorator';

/**
 * Interceptor that protects a route with Idempotency-Key handling (D1-2).
 * Apply by attaching the `@Idempotent()` decorator to the route handler or the
 * whole controller. The interceptor reads the raw body from `req.rawBody`
 * (must be enabled via NestFactory.create(AppModule, { rawBody: true })).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly service: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isIdempotent) return next.handle();

    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();

    // F-04 — on a route that moves money, a missing key is a client bug, not a
    // licence to run the handler unprotected. Refuse it loudly so the mistake
    // surfaces in development rather than as a duplicate sale on a busy shift.
    const requiresKey = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_REQUIRED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiresKey) {
      const raw = req.headers['idempotency-key'];
      const key = Array.isArray(raw) ? raw[0] : raw;
      if (!key || !String(key).trim()) {
        throw new BadRequestException(
          'An Idempotency-Key header is required for this operation so a retry can never charge twice.',
        );
      }
    }
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body ?? {});

    return from(
      this.service.execute({
        request: req,
        rawBody,
        runHandler: async () => {
          // Run the handler inside switchMap so exceptions propagate.
          const result = await new Promise<{ statusCode: number; body: unknown }>(
            (resolve, reject) => {
              next.handle().subscribe({
                next: (value) => resolve({ statusCode: 200, body: value }),
                error: (err) => reject(err),
              });
            },
          );
          return result;
        },
      }),
    ).pipe(switchMap((out) => {
      if (out.statusCode >= 400) throw new HttpException(out.body, out.statusCode);
      context.switchToHttp().getResponse().status(out.statusCode);
      return from(Promise.resolve(out.body));
    }));
  }
}
