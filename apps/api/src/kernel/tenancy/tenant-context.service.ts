import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantStore {
  organizationId: string;
  userId?: string;
  permissions?: string[];
}

/**
 * Request-scoped tenant context backed by AsyncLocalStorage (ADR-004).
 * Set once per request (see main.ts middleware) and read everywhere — the
 * Prisma extension uses it to auto-scope every query to the current tenant.
 */
@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantStore>();

  run<T>(store: TenantStore, callback: () => T): T {
    return this.als.run(store, callback);
  }

  get store(): TenantStore | undefined {
    return this.als.getStore();
  }

  /** Throws if there is no tenant context — fail loud rather than leak across tenants. */
  get organizationId(): string {
    const store = this.als.getStore();
    if (!store?.organizationId) {
      throw new Error('No tenant context: an organizationId is required for this operation.');
    }
    return store.organizationId;
  }

  get optionalOrganizationId(): string | undefined {
    return this.als.getStore()?.organizationId;
  }

  get userId(): string | undefined {
    return this.als.getStore()?.userId;
  }

  get permissions(): string[] {
    return this.als.getStore()?.permissions ?? [];
  }

  /**
   * Replace the request's permission set with the authoritative one.
   *
   * The set placed here by the main.ts middleware comes from the JWT and can be
   * up to JWT_ACCESS_TTL stale. PermissionsGuard re-reads the real set from
   * Postgres on every guarded request, so it calls this to overwrite the cached
   * copy — that way field-level checks (`has()`) and the JWT agree, and a
   * revoked role cannot leak a sensitive field for the life of a token.
   */
  setPermissions(permissions: string[]): void {
    const store = this.als.getStore();
    if (store) store.permissions = permissions;
  }

  /**
   * Field-level authorization helper. Route-level access is already settled by
   * PermissionsGuard; this is for narrowing a *response* — e.g. returning
   * salary only to `hr:compensation` holders.
   */
  has(permission: string): boolean {
    return this.permissions.includes(permission);
  }
}
