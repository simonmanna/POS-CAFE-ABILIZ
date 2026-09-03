/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException } from '@nestjs/common';
import { PosKdsService } from './pos-kds.service';

/**
 * Unit coverage for the KDS enterprise upgrade: recall + reason, chef capture,
 * priority, bulk transition, and queue-number allocation on ticket creation.
 */
describe('PosKdsService', () => {
  const orgId = 'org1';
  let prisma: any;
  let tenant: any;
  let events: any;
  let audit: any;
  let sequence: any;
  let svc: PosKdsService;

  const ticket = (over: Partial<any> = {}) => ({
    id: 't1', organizationId: orgId, invoiceId: null, orderId: 'o1', label: 'ORD-1',
    ticketNo: 'K-001', station: 'kitchen', status: 'new', priority: 'normal', orderType: 'dine_in',
    items: [], startedAt: null, readyAt: null, servedAt: null, startedBy: null, readyBy: null,
    assignedTo: null, recallCount: 0, recallReason: null,
    createdAt: new Date('2026-08-03T10:00:00Z'), updatedAt: new Date('2026-08-03T10:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    tenant = { organizationId: orgId, userId: 'chef1' };
    events = { publish: jest.fn() };
    audit = { record: jest.fn() };
    sequence = { next: jest.fn().mockResolvedValue('K-001') };
    prisma = {
      client: {
        kitchenTicket: {
          findFirst: jest.fn(),
          update: jest.fn(),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(),
        },
        order: { updateMany: jest.fn(), update: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      },
    };
    svc = new PosKdsService(prisma as any, tenant as any, events as any, audit as any, sequence as any);
  });

  describe('transition', () => {
    it('start: sets status preparing + captures startedBy, and emits fulfillment.started', async () => {
      prisma.client.kitchenTicket.findFirst.mockResolvedValue(ticket({ status: 'new' }));
      prisma.client.kitchenTicket.update.mockImplementation(({ data }: any) => ticket({ status: data.status, startedBy: data.startedBy }));
      const res = await svc.transition('t1', 'start');
      const arg = prisma.client.kitchenTicket.update.mock.calls[0][0];
      expect(arg.data.status).toBe('preparing');
      expect(arg.data.startedBy).toBe('chef1');
      expect(arg.data.startedAt).toBeInstanceOf(Date);
      // Phase A/B: the kitchen reports a fulfillment fact rather than stamping
      // the (now-removed) Order.kitchenStartedAt column.
      expect(events.publish).toHaveBeenCalledWith(
        'fulfillment.started',
        expect.objectContaining({ orderId: 'o1', strategy: 'kitchen', documentType: 'kitchen_ticket' }),
      );
      expect(prisma.client.order.updateMany).not.toHaveBeenCalled();
      expect(res.status).toBe('preparing');
    });

    it('ready: captures readyBy and emits fulfillment.completed', async () => {
      prisma.client.kitchenTicket.findFirst.mockResolvedValue(ticket({ status: 'preparing' }));
      prisma.client.kitchenTicket.update.mockImplementation(({ data }: any) => ticket({ status: data.status, readyBy: data.readyBy }));
      await svc.transition('t1', 'ready');
      const arg = prisma.client.kitchenTicket.update.mock.calls[0][0];
      expect(arg.data.status).toBe('ready');
      expect(arg.data.readyBy).toBe('chef1');
      expect(events.publish).toHaveBeenCalledWith(
        'fulfillment.completed',
        expect.objectContaining({ orderId: 'o1', strategy: 'kitchen', kdsStatus: 'ready' }),
      );
    });

    it('recall: ready → preparing, increments recallCount, records reason, clears the ticket readyAt', async () => {
      prisma.client.kitchenTicket.findFirst.mockResolvedValue(ticket({ status: 'ready' }));
      prisma.client.kitchenTicket.update.mockImplementation(({ data }: any) => ticket({ status: data.status }));
      await svc.transition('t1', 'recall', 'burnt');
      const arg = prisma.client.kitchenTicket.update.mock.calls[0][0];
      expect(arg.data.status).toBe('preparing');
      expect(arg.data.readyAt).toBeNull();
      expect(arg.data.recallReason).toBe('burnt');
      expect(arg.data.recallCount).toEqual({ increment: 1 });
      // The order is no longer touched — its kitchen history lives in the ledger,
      // where the recall does NOT erase the prior completion fact (the column did).
      expect(prisma.client.order.updateMany).not.toHaveBeenCalled();
      expect(prisma.client.order.update).not.toHaveBeenCalled();
    });

    it('rejects an illegal jump (serving a new ticket)', async () => {
      prisma.client.kitchenTicket.findFirst.mockResolvedValue(ticket({ status: 'new' }));
      await expect(svc.transition('t1', 'serve')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects recalling a ticket that is not ready', async () => {
      prisma.client.kitchenTicket.findFirst.mockResolvedValue(ticket({ status: 'preparing' }));
      await expect(svc.transition('t1', 'recall')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('setPriority', () => {
    it('updates the ticket priority', async () => {
      prisma.client.kitchenTicket.findFirst.mockResolvedValue(ticket());
      prisma.client.kitchenTicket.update.mockImplementation(({ data }: any) => ticket({ priority: data.priority }));
      const res = await svc.setPriority('t1', 'rush');
      expect(prisma.client.kitchenTicket.update).toHaveBeenCalledWith(expect.objectContaining({ data: { priority: 'rush' } }));
      expect(res.priority).toBe('rush');
    });
  });

  describe('bulkTransition', () => {
    it('advances valid tickets and skips illegal ones', async () => {
      prisma.client.kitchenTicket.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where.id === 'good' ? ticket({ id: 'good', status: 'preparing' }) : ticket({ id: 'bad', status: 'new' })));
      prisma.client.kitchenTicket.update.mockImplementation(({ data }: any) => ticket({ status: data.status }));
      const res = await svc.bulkTransition(['good', 'bad'], 'ready');
      expect(res.updated).toHaveLength(1);
      expect(res.skipped).toEqual(['bad']);
    });
  });

  describe('createTicketsForSale', () => {
    it('creates one ticket per station with a queue number, priority and orderType', async () => {
      prisma.client.kitchenTicket.create.mockImplementation(({ data }: any) => ticket({ ...data }));
      const ids = await svc.createTicketsForSale({
        orderId: 'o1', label: 'ORD-1', orderType: 'takeaway',
        items: [
          { productId: 'p1', productName: 'Burger', quantity: 1, modifiers: [], notes: null, station: 'kitchen' },
          { productId: 'p2', productName: 'Beer', quantity: 2, modifiers: [], notes: null, station: 'bar' },
        ] as any,
      });
      expect(prisma.client.kitchenTicket.create).toHaveBeenCalledTimes(2);
      const first = prisma.client.kitchenTicket.create.mock.calls[0][0].data;
      expect(first.ticketNo).toBe('K-001');
      expect(first.priority).toBe('normal');
      expect(first.orderType).toBe('takeaway');
      expect(sequence.next).toHaveBeenCalled();
      expect(ids).toHaveLength(2);
    });

    it('F11: runs ticket creation on the caller transaction when one is passed', async () => {
      const tx = { kitchenTicket: { create: jest.fn().mockImplementation(({ data }: any) => ticket({ ...data })) } };
      await svc.createTicketsForSale({ orderId: 'o1', label: 'ORD-1', items: [{ productId: 'p1', productName: 'Burger', quantity: 1, modifiers: [], notes: null, station: 'kitchen' }] as any }, tx as any);
      expect(tx.kitchenTicket.create).toHaveBeenCalledTimes(1);
      expect(prisma.client.kitchenTicket.create).not.toHaveBeenCalled();
      // Events for a transactional create are deferred until after commit.
      expect(events.publish).not.toHaveBeenCalled();
    });
  });

  describe('F12: listTickets board split', () => {
    it('returns EVERY active ticket (uncapped) plus a bounded history when no status filter is given', async () => {
      prisma.client.kitchenTicket.findMany
        .mockResolvedValueOnce([ticket({ id: 'a', status: 'new' }), ticket({ id: 'b', status: 'preparing' })]) // active
        .mockResolvedValueOnce([ticket({ id: 'h', status: 'served' })]); // recent history
      const res = await svc.listTickets('kitchen');
      const activeCall = prisma.client.kitchenTicket.findMany.mock.calls[0][0];
      expect(activeCall.where.status.in).toEqual(['new', 'preparing', 'ready']);
      expect(activeCall.take).toBeUndefined(); // active work is never capped
      expect(prisma.client.kitchenTicket.findMany.mock.calls[1][0].take).toBe(50); // history is
      expect(res.map((t) => t.id)).toEqual(['a', 'b', 'h']);
    });

    it('an explicit status filter queries that status only, capped for history browsing', async () => {
      prisma.client.kitchenTicket.findMany.mockResolvedValueOnce([ticket({ id: 's', status: 'served' })]);
      await svc.listTickets('kitchen', 'served');
      const call = prisma.client.kitchenTicket.findMany.mock.calls[0][0];
      expect(call.where.status).toBe('served');
      expect(call.take).toBe(500);
    });
  });

  describe('F11: cancelTicketsForOrder', () => {
    it('cancels only still-active tickets and is a no-op when none are active', async () => {
      prisma.client.kitchenTicket.updateMany = jest.fn().mockResolvedValue({ count: 2 });
      prisma.client.kitchenTicket.findMany.mockResolvedValueOnce([
        { id: 't1', station: 'kitchen' }, { id: 't2', station: 'bar' },
      ]);
      const n = await svc.cancelTicketsForOrder('o1', 'Order cancelled');
      expect(n).toBe(2);
      const call = prisma.client.kitchenTicket.updateMany.mock.calls[0][0];
      expect(call.where.id.in).toEqual(['t1', 't2']);
      expect(call.data.status).toBe('cancelled');

      prisma.client.kitchenTicket.findMany.mockResolvedValueOnce([]);
      expect(await svc.cancelTicketsForOrder('o2')).toBe(0);
    });
  });
});
