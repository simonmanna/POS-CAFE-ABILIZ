import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';

/** Global limits are multiplied by this for a signed-in staff member. */
const STAFF_LIMIT_MULTIPLIER = Number(process.env.THROTTLE_STAFF_MULTIPLIER ?? 5);

/**
 * Rate limits keyed on the signed-in user rather than the client IP.
 *
 * Every till, waiter tablet and kitchen screen in a café usually reaches the
 * API through one router, so per-IP limits are shared by the whole shop and a
 * lunch rush (plus background polling) could start returning 429 on real
 * sales. Authenticated traffic is therefore tracked per user, with the global
 * ceilings raised for staff; anonymous traffic (login, password reset, public
 * menu) keeps the per-IP limits that protect it from brute force. Route-level
 * @Throttle overrides (PIN approval, login) are never relaxed.
 */
@Injectable()
export class StaffAwareThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const userId = req.auth?.sub ?? req.user?.sub ?? req.user?.id;
    const orgId = req.auth?.organizationId ?? req.user?.organizationId;
    if (userId) return `user:${orgId ?? '-'}:${userId}`;
    return super.getTracker(req);
  }

  protected async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const req = props.context.switchToHttp().getRequest<Record<string, any>>();
    const authenticated = !!(req.auth?.sub ?? req.user?.sub ?? req.user?.id);
    const isGlobalDefault = props.limit === props.throttler.limit;
    if (authenticated && isGlobalDefault && STAFF_LIMIT_MULTIPLIER > 1) {
      return super.handleRequest({ ...props, limit: props.limit * STAFF_LIMIT_MULTIPLIER });
    }
    return super.handleRequest(props);
  }
}
