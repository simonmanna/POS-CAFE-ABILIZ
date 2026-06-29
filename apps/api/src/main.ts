import 'reflect-metadata';
import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger as PinoLogger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './kernel/filters/global-exception.filter';
import { TenantContextService } from './kernel/tenancy/tenant-context.service';
import { JwtTokenService, type AccessTokenPayload } from './kernel/auth/jwt-token.service';
import { validateEnv } from './kernel/config/env';
import { requestIdMiddleware } from './kernel/observability/request-id.middleware';

async function bootstrap(): Promise<void> {
  // D4-1: refuse-to-start guard. In production, missing or weak JWT secrets
  // are fatal. In dev, we warn but proceed so engineers can iterate.
  const envCheck = validateEnv();
  if (!envCheck.ok) {
    process.exit(1);
  }

  // rawBody: true lets the IdempotencyInterceptor hash the original payload
  // for Idempotency-Key replay protection.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });

  // Phase B2: structured JSON logging via pino.
  app.useLogger(app.get(PinoLogger));
  app.use(requestIdMiddleware);

  // Security headers via helmet. CSP disabled for the API (no HTML served);
  // crossOriginResourcePolicy loosened for /uploads served from same origin.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    }),
  );
  app.use(compression());
  app.use(cookieParser());

  // Body size limit (defense against memory-exhaustion / slowloris). The
  // files module uses multer with its own per-file limit; this caps the rest.
  const bodyLimit = process.env.BODY_LIMIT ?? '2mb';
  app.useBodyParser('json', { limit: bodyLimit });
  app.useBodyParser('urlencoded', { limit: bodyLimit, extended: true });

  // Global /v1 versioning prefix.
  app.setGlobalPrefix('api/v1');

  // CORS — driven by env. Default: same-origin only.
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins.length > 0 ? origins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key', 'X-Device-Label', 'X-Pos-User'],
    exposedHeaders: ['X-Request-Id', 'X-Total-Count'],
    maxAge: 86_400,
  });

  // --- Tenant context middleware (ADR-004) ---------------------------------
  // Resolve org/user from the access token and run the remainder of the
  // request inside an AsyncLocalStorage context, which the Prisma extension
  // reads to auto-scope every query. Invalid/absent tokens fall through;
  // guards enforce.
  const tenant = app.get(TenantContextService);
  const jwt = app.get(JwtTokenService);
  app.use((req: Request & { auth?: AccessTokenPayload; id?: string }, _res: Response, next: NextFunction) => {
    const header = req.headers['authorization'];
    if (header?.startsWith('Bearer ')) {
      try {
        const payload = jwt.verifyAccess(header.slice('Bearer '.length));

        // POS cashier identity (ADR — PIN attribution): when a valid `X-Pos-User`
        // token is present and belongs to the SAME organization as the bearer
        // JWT, the request is attributed to the cashier who PINned in — not the
        // back-office user whose JWT opened the terminal. This makes per-cashier
        // X/Z, audit trails, override authority and `createdBy`/`printedById`
        // correct on a shared terminal. The bearer JWT still establishes the org
        // boundary and transport auth; the POS token only narrows the identity.
        let effective = payload;
        const posHeaderRaw = req.headers['x-pos-user'];
        const posHeader = Array.isArray(posHeaderRaw) ? posHeaderRaw[0] : posHeaderRaw;
        if (posHeader) {
          try {
            const pos = jwt.verifyPos(String(posHeader));
            if (pos.organizationId === payload.organizationId) {
              effective = {
                sub: pos.sub,
                organizationId: payload.organizationId,
                email: pos.email,
                permissions: pos.permissions,
              };
            }
            // org mismatch → ignore the POS token, fall back to the JWT identity.
          } catch {
            // invalid/expired POS token → fall back to the JWT identity.
          }
        }

        req.auth = effective;
        return tenant.run(
          {
            organizationId: effective.organizationId,
            userId: effective.sub,
            permissions: effective.permissions,
          },
          () => next(),
        );
      } catch {
        // invalid token: continue unauthenticated, guards will reject if needed
      }
    }
    return next();
  });

  app.useGlobalFilters(new GlobalExceptionFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ---- OpenAPI / Swagger docs ----
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Generic ERP API')
    .setDescription('Multi-tenant modular ERP platform — generic core + verticals')
    .setVersion('1.0.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'Idempotency-Key', in: 'header' }, 'idempotency-key')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true, docExpansion: 'none' },
  });

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  app
    .get(PinoLogger)
    .log(`ERP API listening on http://localhost:${port}/api/v1 — Docs at /api/docs`);
}

void bootstrap();
