/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConflictException } from '@nestjs/common';
import { PosMenuService } from './pos-menu.service';

describe('PosMenuService production invariants', () => {
  const orgId = 'org-1';
  let tx: any;
  let prisma: any;
  let audit: any;
  let service: PosMenuService;

  beforeEach(() => {
    tx = {
      $queryRawUnsafe: jest.fn(),
      menuItem: {
        create: jest.fn().mockResolvedValue({ id: 'm1' }),
        findFirst: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'm1', ingredients: [] }),
        update: jest.fn(),
      },
      menuProduct: { create: jest.fn(), deleteMany: jest.fn() },
    };
    prisma = { client: { $transaction: jest.fn((callback: any) => callback(tx)) } };
    audit = { recordInTx: jest.fn() };
    service = new PosMenuService(prisma, { organizationId: orgId, userId: 'u1' } as any, { signDownload: jest.fn() } as any, audit);
  });

  it('rejects an inventory-tracked item without a recipe', async () => {
    await expect(service.create({ name: 'Latte', isInventoryTracked: true, ingredients: [] }))
      .rejects.toThrow('require at least one recipe ingredient');
    expect(tx.menuItem.create).not.toHaveBeenCalled();
  });

  it('rejects zero and duplicate recipe ingredients', async () => {
    await expect(service.create({ name: 'Latte', isInventoryTracked: true, ingredients: [{ productId: 'p1', quantity: 0 }] }))
      .rejects.toThrow('greater than zero');
    await expect(service.create({ name: 'Latte', isInventoryTracked: true, ingredients: [{ productId: 'p1', quantity: 1 }, { productId: 'p1', quantity: 2 }] }))
      .rejects.toThrow('only once');
  });

  it('creates a non-stock item and records the audit atomically', async () => {
    await expect(service.create({ name: 'Service charge', isInventoryTracked: false, ingredients: [] })).resolves.toMatchObject({ id: 'm1' });
    expect(audit.recordInTx).toHaveBeenCalledWith(tx, expect.objectContaining({ entity: 'MenuItem', entityId: 'm1', action: 'create' }));
  });

  it('rejects a stale concurrent menu edit', async () => {
    tx.menuItem.findFirst.mockResolvedValue({ id: 'm1', updatedAt: new Date('2026-09-13T10:00:00Z'), isInventoryTracked: false, ingredients: [] });
    await expect(service.update('m1', { name: 'Changed', expectedUpdatedAt: '2026-09-13T09:00:00Z' }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(tx.menuItem.update).not.toHaveBeenCalled();
  });
});
