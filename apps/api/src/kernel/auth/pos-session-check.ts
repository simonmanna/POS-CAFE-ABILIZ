import { userMayOperatePos } from './pos-eligibility';

/**
 * Live revocation for POS cashier tokens.
 *
 * A POS token is a signed JWT that lives for JWT_POS_TTL (12h by default) and
 * used to be trusted on its signature alone. Disabling a login, deleting it or
 * ending the linked employment revoked the refresh tokens but left the till
 * token working, so a dismissed cashier could keep selling until the shift
 * ran out.
 *
 * This asks the database, per request, whether the token's user may still
 * operate a POS (see pos-eligibility.ts). Answers are cached for a few seconds
 * per user so a busy till does not add a query to every request. The cache is
 * per process, which bounds how long a revocation takes to land on every
 * instance to CACHE_TTL_MS.
 *
 * Reads through `prisma.raw`: it runs inside the tenant middleware, before a
 * tenant context exists, so the org is scoped by hand.
 */

const CACHE_TTL_MS = 10_000;
const MAX_ENTRIES = 5_000;

type RawPrisma = { raw: { user: { findFirst: (args: any) => Promise<any> } } };

export function createPosSessionCheck(prisma: RawPrisma) {
  const cache = new Map<string, { ok: boolean; at: number }>();

  return async function posUserStillAllowed(organizationId: string, userId: string): Promise<boolean> {
    const key = `${organizationId}:${userId}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ok;

    const user = await prisma.raw.user.findFirst({
      where: { id: userId, organizationId },
      select: {
        isActive: true,
        deletedAt: true,
        employee: { select: { employmentStatus: true, deletedAt: true } },
      },
    });
    const ok = !!user && userMayOperatePos(user);

    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(key, { ok, at: Date.now() });
    return ok;
  };
}

/** Response header the web terminal watches to drop a revoked cashier. */
export const POS_SESSION_HEADER = 'X-Pos-Session';
