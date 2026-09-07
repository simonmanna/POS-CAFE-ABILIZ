/* eslint-disable @typescript-eslint/no-explicit-any */
import { recomputeTableStatus, TABLE_HELD_ORDER_STATUSES } from './table-status.util';

/**
 * The single table-status invariant, shared by the Order / Invoice / Tables
 * services: a dine-in table is OCCUPIED iff it has ≥1 active (non-cancelled)
 * order item on a held order; otherwise AVAILABLE. `reserved` / `out_of_service`
 * are overrides and never auto-flipped.
 */
describe('recomputeTableStatus', () => {
  const makeTx = (opts: { table: any; itemCount?: number }) => {
    const update = jest.fn().mockResolvedValue({});
    const count = jest.fn().mockResolvedValue(opts.itemCount ?? 0);
    const findFirst = jest.fn().mockResolvedValue(opts.table);
    const tx: any = { posTable: { findFirst, update }, orderItem: { count } };
    return { tx, update, count, findFirst };
  };

  it('no-ops and returns null when tableId is missing', async () => {
    const { tx, update } = makeTx({ table: null });
    expect(await recomputeTableStatus(tx, null)).toBeNull();
    expect(await recomputeTableStatus(tx, undefined)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('returns null when the table does not exist', async () => {
    const { tx, update } = makeTx({ table: null });
    expect(await recomputeTableStatus(tx, 't1')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('OCCUPIES an available table that has ≥1 active item', async () => {
    const { tx, update, count } = makeTx({ table: { id: 't1', status: 'available' }, itemCount: 3 });
    expect(await recomputeTableStatus(tx, 't1')).toBe('occupied');
    expect(update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: 'occupied' } });
    // Invariant: counts only non-cancelled items on held orders for this table.
    expect(count).toHaveBeenCalledWith({
      where: {
        cancelled: false,
        order: { tableId: 't1', status: { in: TABLE_HELD_ORDER_STATUSES } },
      },
    });
  });

  it('FREES an occupied table once the last active item is gone (Case 1)', async () => {
    const { tx, update } = makeTx({ table: { id: 't1', status: 'occupied' }, itemCount: 0 });
    expect(await recomputeTableStatus(tx, 't1')).toBe('available');
    expect(update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: 'available' } });
  });

  it('is idempotent — no write when status already matches the item count', async () => {
    const occ = makeTx({ table: { id: 't1', status: 'occupied' }, itemCount: 2 });
    expect(await recomputeTableStatus(occ.tx, 't1')).toBe('occupied');
    expect(occ.update).not.toHaveBeenCalled();

    const avail = makeTx({ table: { id: 't2', status: 'available' }, itemCount: 0 });
    expect(await recomputeTableStatus(avail.tx, 't2')).toBe('available');
    expect(avail.update).not.toHaveBeenCalled();
  });

  it('never auto-flips reserved or out_of_service (admin/booking overrides)', async () => {
    for (const status of ['reserved', 'out_of_service']) {
      const { tx, update, count } = makeTx({ table: { id: 't1', status }, itemCount: 5 });
      expect(await recomputeTableStatus(tx, 't1')).toBe(status);
      expect(count).not.toHaveBeenCalled(); // short-circuits before counting
      expect(update).not.toHaveBeenCalled();
    }
  });

  it('held-status set holds billed-but-unpaid (served) but not closed/cancelled', () => {
    expect(TABLE_HELD_ORDER_STATUSES).toContain('served');
    expect(TABLE_HELD_ORDER_STATUSES).not.toContain('closed');
    expect(TABLE_HELD_ORDER_STATUSES).not.toContain('cancelled');
  });
});

/**
 * Audit F-06 — a settled table has to be bussed before the next party sits.
 *
 * The defect: the cleaning flip lived in PosTablesService.closeTableOrder, which
 * runs AFTER the payment transaction has already recomputed the table to
 * 'available'. Its `existing.status === 'occupied'` guard could therefore never
 * be true, and the whole cleaning workflow was dead code. The transition is only
 * observable inside the transaction that releases the table, so that is where
 * settlement now asks for it.
 */
describe('recomputeTableStatus — dirtyOnRelease (F-06)', () => {
  const makeTx = (tableStatus: string, activeItems: number) => ({
    posTable: { findFirst: jest.fn().mockResolvedValue({ id: 't1', status: tableStatus }), update: jest.fn() },
    orderItem: { count: jest.fn().mockResolvedValue(activeItems) },
  });

  it('sends an occupied table to cleaning when settlement releases it', async () => {
    const tx = makeTx('occupied', 0);
    await expect(recomputeTableStatus(tx as any, 't1', { dirtyOnRelease: true })).resolves.toBe('cleaning');
    expect(tx.posTable.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: 'cleaning' } });
  });

  it('frees it straight to available for an ordinary item edit', async () => {
    const tx = makeTx('occupied', 0);
    await expect(recomputeTableStatus(tx as any, 't1')).resolves.toBe('available');
    expect(tx.posTable.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: 'available' } });
  });

  it('leaves a still-occupied table occupied even on a settle', async () => {
    const tx = makeTx('occupied', 2);
    await expect(recomputeTableStatus(tx as any, 't1', { dirtyOnRelease: true })).resolves.toBe('occupied');
  });

  it('does not dirty a table that was already free', async () => {
    const tx = makeTx('available', 0);
    await expect(recomputeTableStatus(tx as any, 't1', { dirtyOnRelease: true })).resolves.toBe('available');
    expect(tx.posTable.update).not.toHaveBeenCalled();
  });

  it('never overrides an admin hold', async () => {
    const tx = makeTx('out_of_service', 0);
    await expect(recomputeTableStatus(tx as any, 't1', { dirtyOnRelease: true })).resolves.toBe('out_of_service');
    expect(tx.posTable.update).not.toHaveBeenCalled();
  });
});
