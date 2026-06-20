import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

export interface SequenceOptions {
  prefix?: string;
  padding?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type SequenceClient = { sequence: PrismaService['client']['sequence'] };

/**
 * Atomic, concurrency-safe document numbering (Odoo ir.sequence). The increment
 * is an atomic row update; pass the active `tx` so the number is reserved inside
 * the same transaction that creates the entry/document (ADR-009).
 */
@Injectable()
export class SequenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async next(key: string, options: SequenceOptions = {}, tx?: any): Promise<string> {
    const client: SequenceClient = tx ?? this.prisma.client;
    const organizationId = this.tenant.organizationId;

    const row = await client.sequence.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: {
        organizationId,
        key,
        prefix: options.prefix ?? '',
        padding: options.padding ?? 5,
        nextValue: 2,
      },
      update: { nextValue: { increment: 1 } },
    });

    // The value reserved by this call is (nextValue - 1).
    const reserved = row.nextValue - 1;
    return `${row.prefix}${String(reserved).padStart(row.padding, '0')}`;
  }
}
