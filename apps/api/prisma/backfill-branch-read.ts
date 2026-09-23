/**
 * One-off backfill: grant `branch:read` to every role that can operate the POS
 * (holds `pos:read`). The terminal's branch switcher lists GET /branches, which
 * is permission-gated — without it every POS session logs
 * "Missing required permission(s): branch:read".
 * Idempotent; safe to re-run. (The full seed is NOT safe to re-run on live data.)
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const key = 'branch:read';
  await prisma.permission.upsert({
    where: { key },
    update: { resource: 'branch', action: 'read' },
    create: { key, resource: 'branch', action: 'read' },
  });

  const roles = await prisma.role.findMany({
    where: { deletedAt: null, permissions: { has: 'pos:read' } },
    select: { id: true, name: true, permissions: true },
  });
  let updated = 0;
  for (const role of roles) {
    if (role.permissions.includes(key)) continue;
    await prisma.role.update({
      where: { id: role.id },
      data: { permissions: [...role.permissions, key] },
    });
    updated += 1;
    console.log(`Granted ${key} to role ${role.name}`);
  }
  console.log(`Done — ${updated} role(s) updated.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
