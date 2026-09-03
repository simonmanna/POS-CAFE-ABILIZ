import { PrismaClient } from '@prisma/client';

/** Isolated test fixtures obey the same tenant GUC as business transactions. */
export function scopedPrisma(raw: PrismaClient, organizationId: () => string): PrismaClient {
  const transaction = (fn: any, options?: any) => raw.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${organizationId()}, true)`;
    return fn(tx);
  }, { timeout: 20000, ...options });
  return new Proxy(raw, {
    get(target: any, prop: string) {
      if (prop === '$transaction') return transaction;
      const value = target[prop];
      if (prop.startsWith('$')) return typeof value === 'function' ? value.bind(target) : value;
      if (value && typeof value.findMany === 'function') return new Proxy(value, { get(_delegate, operation: string) { return (...args: any[]) => transaction((tx: any) => tx[prop][operation](...args)); } });
      return value;
    },
  });
}
