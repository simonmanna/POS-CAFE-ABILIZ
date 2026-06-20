import { Module } from '@nestjs/common';
import { KernelModule } from './kernel/kernel.module';
import { AuthModule } from './kernel/auth/auth.module';
import { CoreModule } from './modules/core/core.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { InvoicingModule } from './modules/invoicing/invoicing.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { AppController } from './app.controller';

@Module({
  imports: [KernelModule, AuthModule, CoreModule, AccountingModule, InvoicingModule, InventoryModule],
  controllers: [AppController],
})
export class AppModule {}
