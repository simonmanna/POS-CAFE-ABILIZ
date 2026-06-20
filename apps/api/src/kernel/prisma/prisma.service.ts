import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { tenancyExtension } from './tenancy.extension';

/**
 * Provides two clients:
 *  - `client`: tenant-aware + soft-delete-aware. Use this in all app code.
 *  - `raw`:    unscoped base client. Use only for system tables, the Setting
 *              table, migrations, seeding and tests (ADR-002/004).
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly base: PrismaClient;
  public readonly client: PrismaClient;

  constructor(tenant: TenantContextService) {
    this.base = new PrismaClient();
    // Query-extension only — the model surface is unchanged, so we can safely
    // treat the extended client as a PrismaClient for typing purposes.
    this.client = this.base.$extends(tenancyExtension(tenant)) as unknown as PrismaClient;
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }

  get raw(): PrismaClient {
    return this.base;
  }
}
