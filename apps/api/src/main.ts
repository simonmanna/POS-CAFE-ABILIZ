import 'reflect-metadata';
import 'dotenv/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { TenantContextService } from './kernel/tenancy/tenant-context.service';
import { JwtTokenService, type AccessTokenPayload } from './kernel/auth/jwt-token.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');

  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  // --- Tenant context middleware (ADR-004) ---------------------------------
  // Resolve org/user from the access token and run the remainder of the request
  // inside an AsyncLocalStorage context, which the Prisma extension reads to
  // auto-scope every query. Invalid/absent tokens fall through; guards enforce.
  const tenant = app.get(TenantContextService);
  const jwt = app.get(JwtTokenService);
  app.use((req: Request & { auth?: AccessTokenPayload }, _res: Response, next: NextFunction) => {
    const header = req.headers['authorization'];
    if (header?.startsWith('Bearer ')) {
      try {
        const payload = jwt.verifyAccess(header.slice('Bearer '.length));
        req.auth = payload;
        return tenant.run(
          {
            organizationId: payload.organizationId,
            userId: payload.sub,
            permissions: payload.permissions,
          },
          () => next(),
        );
      } catch {
        // invalid token: continue unauthenticated, guards will reject if needed
      }
    }
    return next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger('Bootstrap').log(`ERP API listening on http://localhost:${port}/api`);
}

void bootstrap();
