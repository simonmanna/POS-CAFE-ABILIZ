import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ReadOnlyMiddleware } from './kernel/common/read-only.middleware';
import { LoggerModule } from 'nestjs-pino';
import { KernelModule } from './kernel/kernel.module';
import { AuthModule } from './kernel/auth/auth.module';
import { CoreModule } from './modules/core/core.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { BeverageModule } from './modules/beverage/beverage.module';
import { InvoicingModule } from './modules/invoicing/invoicing.module';
import { ProcurementModule } from './modules/procurement/procurement.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { CrmModule } from './modules/crm/crm.module';
import { HealthModule } from './health/health.module';
import { MetricsController } from './observability/metrics.controller';
import { AppController } from './app.controller';
import { PosModule } from './modules/pos/pos.module';
import { SyncModule } from './modules/sync/sync.module';
import { BackupModule } from './modules/backup/backup.module';
import { FixedAssetModule } from './modules/fixed-asset/fixed-asset.module';
import { TaskModule } from './modules/task/task.module';
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
    BeverageModule,
    InvoicingModule,
    ProcurementModule,
    ExpensesModule,
    CrmModule,
    PosModule,
    SyncModule,
    BackupModule,
    FixedAssetModule,
    TaskModule,
    HealthModule,
  ],
  controllers: [AppController, MetricsController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // P4: on the cloud reporting replica (READ_ONLY_MODE=true) this rejects
    // every write before it reaches a handler. No-op on the cafe LAN server.
    consumer.apply(ReadOnlyMiddleware).forRoutes('*');
  }
}
