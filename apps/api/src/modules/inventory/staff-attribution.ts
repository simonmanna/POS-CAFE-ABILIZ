import { BadRequestException } from '@nestjs/common';

/**
 * Responsible-person / approved-by ids arrive from the client. They are only
 * trustworthy once proven to be active users of the caller's organization —
 * otherwise a request could attribute a movement to a foreign-org, deactivated
 * or invented user and the audit trail would record it as fact.
 */
export async function assertActiveStaff(
  db: any,
  organizationId: string,
  ids: Record<string, string | null | undefined>,
): Promise<void> {
  const wanted = [...new Set(Object.values(ids).filter((v): v is string => !!v))];
  if (wanted.length === 0) return;
  const found = await db.user.findMany({
    where: { id: { in: wanted }, organizationId, isActive: true },
    select: { id: true },
  });
  const ok = new Set(found.map((u: { id: string }) => u.id));
  const bad = Object.entries(ids).filter(([, v]) => v && !ok.has(v)).map(([k]) => k);
  if (bad.length > 0) {
    throw new BadRequestException(`${bad.join(' and ')} must be an active user of this organization`);
  }
}
