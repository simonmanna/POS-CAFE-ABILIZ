import { Global, Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalPolicyController } from './approval-policy.controller';

@Global()
@Module({
  controllers: [ApprovalsController, ApprovalPolicyController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
