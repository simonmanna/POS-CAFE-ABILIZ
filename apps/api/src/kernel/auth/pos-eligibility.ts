import type { Prisma } from '@prisma/client';

/**
 * Who may operate a POS terminal — one rule, shared by every door into POS.
 *
 * Roles still decide WHAT a cashier can do. This only answers WHETHER the
 * account can sign in at a till right now, and it has two inputs:
 *
 *   1. The login itself: active and not deleted.
 *   2. The linked HR record, when there is one: an employee who is suspended,
 *      terminated or resigned cannot sell, even when whoever ended the
 *      employment chose to leave the back-office login enabled.
 *
 * A user with no employee record is unaffected. That stays a supported state,
 * because a POS user HR has not adopted yet must keep working.
 *
 * Lives in the kernel because POS PIN login, the X-Pos-User middleware and
 * offline staff sync all need it, and none of them may import the HR module.
 * The relation it reads (`User.employee`) is in the schema, not in HR code.
 */

/** Employment statuses that take someone off the tills. */
export const POS_BLOCKING_EMPLOYMENT_STATUSES = ['SUSPENDED', 'TERMINATED', 'RESIGNED'] as const;

/**
 * Prisma `where` fragment for User: excludes accounts whose linked, live
 * employee record has ended or is suspended. Combine with the caller's own
 * isActive / deletedAt filter.
 */
export const posEligibleUserWhere: Prisma.UserWhereInput = {
  NOT: {
    employee: {
      is: {
        employmentStatus: { in: [...POS_BLOCKING_EMPLOYMENT_STATUSES] },
        deletedAt: null,
      },
    },
  },
};

/** The same rule, applied to a row that has already been loaded. */
export function employmentBlocksPos(
  employee: { employmentStatus: string; deletedAt?: Date | null } | null | undefined,
): boolean {
  if (!employee || employee.deletedAt) return false;
  return (POS_BLOCKING_EMPLOYMENT_STATUSES as readonly string[]).includes(employee.employmentStatus);
}

/** Full check for a loaded user row (login state + employment). */
export function userMayOperatePos(user: {
  isActive: boolean;
  deletedAt: Date | null;
  employee?: { employmentStatus: string; deletedAt?: Date | null } | null;
}): boolean {
  return user.isActive && !user.deletedAt && !employmentBlocksPos(user.employee);
}
