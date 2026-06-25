import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { KernelModule } from './kernel/kernel.module';
import { AuthModule } from './kernel/auth/auth.module';
import { CoreModule } from './modules/core/core.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { InvoicingModule } from './modules/invoicing/invoicing.module';
import { ProcurementModule } from './modules/procurement/procurement.module';
import { CrmModule } from './modules/crm/crm.module';
import { HealthModule } from './health/health.module';
import { MetricsController } from './observability/metrics.controller';
import { AppController } from './app.controller';
import { PosModule } from './modules/pos/pos.module';
// import { SchoolModule } from './modules/school/school.module'; // disabled: DI wiring issues, not needed for POS testing

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.refreshToken',
            'req.body.accessToken',
            'req.body.mfaSecret',
            'req.body.code',
            'req.body.newPassword',
          ],
          censor: '[REDACTED]',
        },
        genReqId: (req) => ((req.headers['x-request-id'] as string) ?? undefined) as any,
        customProps: () => ({ service: 'cafe-pos-api' }),
      },
    }),
    KernelModule,
    AuthModule,
    CoreModule,
    AccountingModule,
    InventoryModule,
    InvoicingModule,
    ProcurementModule,
    CrmModule,
    PosModule,
    HealthModule,
  ],
  controllers: [AppController, MetricsController],
})
export class AppModule {}
