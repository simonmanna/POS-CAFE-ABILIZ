import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { DomainEventMap, DomainEventName } from '@erp/shared';

/**
 * Typed, in-process domain event bus (ADR-003). Backed by Node's EventEmitter
 * (zero extra dependencies). Side-effect handlers only — the money-critical
 * path uses direct service calls inside the DB transaction instead.
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger('EventBus');
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish<K extends DomainEventName>(event: K, payload: DomainEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  subscribe<K extends DomainEventName>(
    event: K,
    handler: (payload: DomainEventMap[K]) => void | Promise<void>,
  ): void {
    this.emitter.on(event, (payload: DomainEventMap[K]) => {
      Promise.resolve(handler(payload)).catch((err) =>
        this.logger.error(`Handler for "${event}" failed: ${String(err)}`),
      );
    });
  }
}
