import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ModuleRegistry } from '../../kernel/module-loader/module-registry.service';
import { WorkflowRegistry } from '../../kernel/workflow/workflow.registry';

/**
 * POS registers no new workflow states — invoices and payments already have
 * full workflows. This file exists to keep the vertical self-contained and to
 * make future POS-specific states (e.g. "held" for an open drawer) trivial to
 * add without touching the kernel.
 */
@Injectable()
export class PosWorkflowsInitializer implements OnModuleInit {
  private readonly logger = new Logger('PosWorkflows');
  constructor(
    private readonly registry: ModuleRegistry,
    private readonly workflows: WorkflowRegistry,
  ) {}

  onModuleInit(): void {
    // Placeholder: reserved for future POS-specific workflows. Logged at boot
    // so operators can confirm the vertical is loaded.
    this.logger.log('POS workflows initialized (uses core invoice + payment workflows)');
  }
}
