import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

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

/** Permission an approver of an immediately-posting stock movement must hold. */
export const DIRECT_STOCK_APPROVER_PERMISSION = 'inventory_doc:approve';

// Shares the POS manager-override failure window (same LoginAttempt reasons),
// so a PIN cannot be brute-forced by alternating between the two entry points.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60_000;
const FAILURE_REASONS = ['override_pin_invalid', 'override_password_invalid'];

/**
 * Prove that `approvedById` actually approved an immediately-posting stock
 * movement (direct stock-in/out has no separate approve step).
 *
 *  - Self-approval: the authenticated caller IS the approver, and must hold
 *    {@link DIRECT_STOCK_APPROVER_PERMISSION} on their current token.
 *  - Named approver: must hold the permission through their roles AND present
 *    their override PIN (or `password:<pw>`) on this request. A client-supplied
 *    id alone is never evidence of approval.
 */
export async function assertDirectStockApproval(
  db: any,
  input: {
    organizationId: string;
    actorUserId: string | null | undefined;
    actorPermissions: string[];
    approvedById: string;
    approverPin?: string | null;
  },
): Promise<void> {
  const { organizationId, actorUserId, approvedById } = input;
  if (actorUserId && approvedById === actorUserId) {
    if (!input.actorPermissions.includes(DIRECT_STOCK_APPROVER_PERMISSION)) {
      throw new ForbiddenException(
        `Self-approval of a direct stock movement requires ${DIRECT_STOCK_APPROVER_PERMISSION}; name an approver and enter their PIN`,
      );
    }
    return;
  }
  const approver = await db.user.findFirst({
    where: { id: approvedById, organizationId, isActive: true },
    include: { roles: true },
  });
  if (!approver) throw new BadRequestException('approvedById must be an active user of this organization');
  const perms = new Set<string>(approver.roles.flatMap((r: any) => r.permissions ?? []));
  if (!perms.has(DIRECT_STOCK_APPROVER_PERMISSION)) {
    throw new ForbiddenException(`Approver does not hold ${DIRECT_STOCK_APPROVER_PERMISSION}`);
  }
  const pin = input.approverPin ?? '';
  if (!pin) throw new BadRequestException("The approver's PIN is required to post a direct stock movement");

  const since = new Date(Date.now() - LOCKOUT_MS);
  const recent = await db.loginAttempt.count({
    where: { organizationId, email: approver.email, success: false, createdAt: { gte: since }, reason: { in: FAILURE_REASONS } },
  });
  if (recent >= MAX_FAILED_ATTEMPTS) {
    throw new UnauthorizedException('Approvals for this user are temporarily locked after repeated failed attempts');
  }
  const byPassword = pin.startsWith('password:');
  const hash = byPassword ? approver.passwordHash : approver.pinHash;
  if (!hash) throw new BadRequestException('Approver has not set an override PIN');
  const ok = await bcrypt.compare(byPassword ? pin.slice(9) : pin, hash);
  if (!ok) {
    await db.loginAttempt
      .create({
        data: { organizationId, email: approver.email, success: false, reason: byPassword ? 'override_password_invalid' : 'override_pin_invalid', createdAt: new Date() },
      })
      .catch(() => undefined);
    throw new UnauthorizedException('Invalid approver credentials');
  }
}
