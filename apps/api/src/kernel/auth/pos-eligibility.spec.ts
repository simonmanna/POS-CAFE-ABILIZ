import { employmentBlocksPos, userMayOperatePos } from './pos-eligibility';
import { createPosSessionCheck } from './pos-session-check';

describe('pos-eligibility', () => {
  const live = { isActive: true, deletedAt: null };

  it('keeps an unlinked login on the tills', () => {
    expect(userMayOperatePos({ ...live, employee: null })).toBe(true);
  });

  it.each(['ACTIVE', 'PROBATION', 'ON_LEAVE'])('allows %s employees', (employmentStatus) => {
    expect(userMayOperatePos({ ...live, employee: { employmentStatus } })).toBe(true);
  });

  it.each(['SUSPENDED', 'TERMINATED', 'RESIGNED'])('takes %s employees off the tills', (employmentStatus) => {
    expect(userMayOperatePos({ ...live, employee: { employmentStatus } })).toBe(false);
  });

  it('ignores a soft-deleted employee record', () => {
    expect(employmentBlocksPos({ employmentStatus: 'TERMINATED', deletedAt: new Date() })).toBe(false);
  });

  it('refuses a disabled or deleted login regardless of HR', () => {
    expect(userMayOperatePos({ isActive: false, deletedAt: null, employee: null })).toBe(false);
    expect(userMayOperatePos({ isActive: true, deletedAt: new Date(), employee: null })).toBe(false);
  });
});

describe('createPosSessionCheck', () => {
  it('revokes a token whose user has been disabled, and caches the answer', async () => {
    const findFirst = jest.fn().mockResolvedValue({ isActive: false, deletedAt: null, employee: null });
    const check = createPosSessionCheck({ raw: { user: { findFirst } } });
    await expect(check('org-1', 'user-1')).resolves.toBe(false);
    await expect(check('org-1', 'user-1')).resolves.toBe(false);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0].where).toEqual({ id: 'user-1', organizationId: 'org-1' });
  });

  it('treats a user missing from the org as revoked', async () => {
    const check = createPosSessionCheck({ raw: { user: { findFirst: jest.fn().mockResolvedValue(null) } } });
    await expect(check('org-1', 'ghost')).resolves.toBe(false);
  });
});
