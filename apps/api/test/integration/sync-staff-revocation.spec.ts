import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { describeDb } from './_setup';
import { KernelModule } from '../../src/kernel/kernel.module';
import { DocumentsModule } from '../../src/modules/documents/documents.module';
import { SyncPullService } from '../../src/modules/sync/sync-pull.service';
import { TenantContextService } from '../../src/kernel/tenancy/tenant-context.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Offline staff revocation.
 *
 * The `staff` pull scope ships each active user's bcrypt PIN hash and full
 * permission set to every enrolled terminal so cashiers can sign in with no
 * network. Revoking that access has to reach the device, and it could not:
 *
 *   - the scope filtered `isActive: true`, so a deactivated account dropped
 *     out of the delta instead of appearing in it, and
 *   - `User` is soft-deletable, so the tenancy extension force-injected
 *     `deletedAt: null` and a tombstone could never be emitted either.
 *
 * The net effect was that a suspended or terminated employee's PIN kept working
 * on an offline terminal indefinitely. These tests pin the fixed behaviour:
 * a revoked account must appear in the next delta, and must arrive without a
 * usable credential.
 */
describeDb('integration: offline staff revocation reaches the terminal', () => {
  const prisma = new PrismaClient();
  let moduleRef: TestingModule;
  let pull: SyncPullService;
  let tenant: TenantContextService;

  let organizationId: string;
  let activeUserId: string;
  let revokedUserId: string;
  let deletedUserId: string;

  const PIN_HASH = '$2b$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';

  // Booting a Nest testing module against a live Postgres blows past jest's 5s
  // default hook timeout whenever the rest of the integration suite is running
  // in parallel. The other DB-backed specs set generous per-case timeouts for
  // the same reason.
  const TIMEOUT = 120_000;
  jest.setTimeout(TIMEOUT);

  /** Run the staff scope the way a device pull does, and return its rows. */
  const pullStaff = async (since?: Date): Promise<any[]> =>
    tenant.run({ organizationId }, () => (pull as any).readScope('staff', since));

  beforeAll(async () => {
    await prisma.$connect();
    // SyncPullService is provided directly rather than via SyncModule: that
    // module pulls in PosModule -> AuthModule -> otplib, which is ESM and dies
    // under this jest transform. The service only needs Prisma + tenant
    // context, both global from KernelModule.
    moduleRef = await Test.createTestingModule({
      imports: [KernelModule, DocumentsModule],
      providers: [SyncPullService],
    }).compile();
    await moduleRef.init();
    pull = moduleRef.get(SyncPullService);
    tenant = moduleRef.get(TenantContextService);

    const stamp = Date.now();
    const org = await prisma.organization.create({
      data: { code: `SYNC-REVOKE-${stamp}`, name: 'Revocation Org', currencyCode: 'UGX' },
    });
    organizationId = org.id;

    const mk = (label: string) =>
      prisma.user.create({
        data: {
          organizationId,
          email: `${label}-${stamp}@test.local`,
          firstName: label,
          passwordHash: 'x',
          pinHash: PIN_HASH,
          isActive: true,
        },
      });

    activeUserId = (await mk('active')).id;
    revokedUserId = (await mk('revoked')).id;
    deletedUserId = (await mk('deleted')).id;
  }, TIMEOUT);

  afterAll(async () => {
    if (organizationId) {
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    await moduleRef?.close();
    await prisma.$disconnect();
  }, TIMEOUT);

  it('ships the PIN hash for an account that can still log in', async () => {
    const rows = await pullStaff();
    const active = rows.find((r) => r.id === activeUserId);

    expect(active).toBeDefined();
    expect(active.isActive).toBe(true);
    expect(active.pinHash).toBe(PIN_HASH);
  });

  it('delivers a DEACTIVATED account in the delta instead of dropping it', async () => {
    const before = new Date();
    // Advance past the watermark so `updatedAt > since` is unambiguous.
    await new Promise((r) => setTimeout(r, 1100));
    await prisma.user.update({ where: { id: revokedUserId }, data: { isActive: false } });

    const delta = await pullStaff(before);
    const revoked = delta.find((r) => r.id === revokedUserId);

    // This is the regression: previously the `isActive: true` filter meant the
    // row simply vanished from every future delta, so the terminal never
    // learned anything had changed.
    expect(revoked).toBeDefined();
    expect(revoked.isActive).toBe(false);
  });

  it('strips the credential from a deactivated account', async () => {
    const rows = await pullStaff();
    const revoked = rows.find((r) => r.id === revokedUserId);

    // Even a device that has not yet applied the state change cannot
    // authenticate the revoked PIN, because no usable hash was ever sent.
    expect(revoked.pinHash).toBeNull();
  });

  it('delivers a SOFT-DELETED account as a tombstone, credential stripped', async () => {
    const before = new Date();
    await new Promise((r) => setTimeout(r, 1100));
    await prisma.user.update({
      where: { id: deletedUserId },
      data: { deletedAt: new Date(), isActive: false },
    });

    const delta = await pullStaff(before);
    const tombstone = delta.find((r) => r.id === deletedUserId);

    // The scope's own contract says rows with deletedAt != null are tombstones
    // the client deletes locally — but the tenancy extension had made them
    // unreachable. The device applier keys off exactly this field.
    expect(tombstone).toBeDefined();
    expect(tombstone.deletedAt).not.toBeNull();
    expect(tombstone.pinHash).toBeNull();
  });

  it('never leaks another organization staff into the pull', async () => {
    const stamp = Date.now();
    const other = await prisma.organization.create({
      data: { code: `SYNC-OTHER-${stamp}`, name: 'Other Org', currencyCode: 'UGX' },
    });
    const foreign = await prisma.user.create({
      data: {
        organizationId: other.id,
        email: `foreign-${stamp}@test.local`,
        firstName: 'Foreign',
        passwordHash: 'x',
        pinHash: PIN_HASH,
      },
    });

    // The staff scope reads through the unscoped `raw` client, so the explicit
    // organizationId filter is the only thing standing between one cafe's
    // terminals and another cafe's PIN hashes. Assert it directly.
    const rows = await pullStaff();
    expect(rows.map((r) => r.id)).not.toContain(foreign.id);

    await prisma.user.delete({ where: { id: foreign.id } });
    await prisma.organization.delete({ where: { id: other.id } });
  });

  it('still ships the permission set the terminal needs for offline authorization', async () => {
    const rows = await pullStaff();
    const active = rows.find((r) => r.id === activeUserId);
    expect(Array.isArray(active.roles)).toBe(true);
  });

  it('never ships a password hash or MFA secret', async () => {
    const rows = await pullStaff();
    for (const row of rows) {
      expect(row).not.toHaveProperty('passwordHash');
      expect(row).not.toHaveProperty('mfaSecret');
    }
  });
});
