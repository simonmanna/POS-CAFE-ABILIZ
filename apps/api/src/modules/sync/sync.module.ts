import { Module } from '@nestjs/common';
import { PosModule } from '../pos/pos.module';
import { AccountingModule } from '../accounting/accounting.module';
import { SyncController } from './sync.controller';
import { SyncDevicesService } from './sync-devices.service';
import { SyncPullService } from './sync-pull.service';
import { SyncPushService } from './sync-push.service';
import { SyncDeadLetterService } from './sync-dead-letter.service';
import { DeviceTokenGuard } from './device-token.guard';

/**
 * P1 offline sync — device registry + pull/push data plane for offline-first
 * clients (Kotlin Android app, offline web POS). See docs/sync-protocol.md.
 */
@Module({
  imports: [PosModule, AccountingModule],
  controllers: [SyncController],
  providers: [SyncDevicesService, SyncPullService, SyncPushService, SyncDeadLetterService, DeviceTokenGuard],
})
export class SyncModule {}
