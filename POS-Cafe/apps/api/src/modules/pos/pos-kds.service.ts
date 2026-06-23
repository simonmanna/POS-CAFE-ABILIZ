/**
 * POS P5 — Kitchen Display System.
 *
 * A sale creates one KitchenTicket per (station) in pos.checkout. The KDS
 * page polls /pos/kds/tickets?station=BAR or subscribes to the SSE stream
 * at /pos/kds/stream?station=BAR for real-time updates.
 *
 * Lifecycle:
 *   new (created at sale time, shown in KDS)
 *   ↓
 *   preparing (kitchen taps "Start")
 *   ↓
 *   ready    (kitchen taps "Ready" — optional audio chime on the KDS page)
 *   ↓
 *   served   (runner / customer picks it up)
 *
 * Items are stored as denormalised JSON in the KitchenTicket row so the
 * KDS renders without N+1 joins.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { EventBus } from '../../kernel/events/event-bus';
import { AuditService } from '../../kernel/audit/audit.service';

export interface KdsTicketItem {
  productId: string;
  productName: string;
  quantity: number;
  modifiers: Array<{ name: string; priceDelta: number }>;
  notes: string | null;
  station: 'bar' | 'kitchen' | 'cafe';
}

export interface KdsTicket {
  id: string;
  invoiceId: string;
  label: string;
  station: 'bar' | 'kitchen' | 'cafe';
  status: 'new' | 'preparing' | 'ready' | 'served' | 'cancelled';
  items: KdsTicketItem[];
  startedAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class PosKdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  /**
   * Create one ticket per distinct station that has items. Called from
   * pos.checkout after the invoice posts. Returns the created ticket ids.
   */
  async createTicketsForSale(args: {
    invoiceId?: string;
    label: string;
    items: KdsTicketItem[];
  }): Promise<string[]> {
    // Group items by station.
    const groups = new Map<string, KdsTicketItem[]>();
    for (const it of args.items) {
      const arr = groups.get(it.station) ?? [];
      arr.push(it);
      groups.set(it.station, arr);
    }
    const orgId = this.tenant.organizationId;
    const ids: string[] = [];
    for (const [station, items] of groups) {
      const ticket = await this.prisma.client.kitchenTicket.create({
        data: {
          organizationId: orgId,
          invoiceId: args.invoiceId ?? null,
          label: args.label,
          station: station as any,
          status: 'new',
          items: items as any,
        },
      });
      ids.push(ticket.id);
      this.events.publish('pos.kds.ticket_created' as any, {
        organizationId: orgId,
        ticketId: ticket.id,
        station,
      });
    }
    return ids;
  }

  /**
   * Pre-payment "Send To Kitchen" — creates tickets from cart items before
   * the sale is settled. Looks up each product's station from the DB and
   * groups tickets by station.
   */
  async createTicketsFromCart(args: {
    label: string;
    tableId?: string;
    items: Array<{
      productId: string;
      productName: string;
      notes?: string | null;
    }>;
  }): Promise<string[]> {
    const orgId = this.tenant.organizationId;
    // Batch-lookup product stations.
    const productIds = [...new Set(args.items.map((i) => i.productId))];
    const products = await this.prisma.client.product.findMany({
      where: { id: { in: productIds }, organizationId: orgId },
      select: { id: true, station: true },
    });
    const stationMap = new Map(products.map((p) => [p.id, (p as any).station ?? 'cafe']));

    const kdsItems: KdsTicketItem[] = args.items.map((it) => ({
      productId: it.productId,
      productName: it.productName,
      quantity: 1,
      modifiers: [],
      notes: it.notes ?? null,
      station: stationMap.get(it.productId) ?? 'cafe',
    }));
    return this.createTicketsForSale({
      label: args.label,
      items: kdsItems,
    });
  }

  /** List tickets for a station, newest first. */
  async listTickets(station?: 'bar' | 'kitchen' | 'cafe', status?: string): Promise<KdsTicket[]> {
    const orgId = this.tenant.organizationId;
    const tickets = await this.prisma.client.kitchenTicket.findMany({
      where: {
        organizationId: orgId,
        ...(station ? { station: station as any } : {}),
        ...(status ? { status: status as any } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return (tickets as any[]).map(this.serialize);
  }

  async getTicket(id: string): Promise<KdsTicket> {
    const orgId = this.tenant.organizationId;
    const t = await this.prisma.client.kitchenTicket.findFirst({ where: { id, organizationId: orgId } });
    if (!t) throw new NotFoundException('KDS ticket not found');
    return this.serialize(t);
  }

  async transition(id: string, action: 'start' | 'ready' | 'serve' | 'cancel'): Promise<KdsTicket> {
    const orgId = this.tenant.organizationId;
    const t = await this.prisma.client.kitchenTicket.findFirst({ where: { id, organizationId: orgId } });
    if (!t) throw new NotFoundException('KDS ticket not found');
    const now = new Date();
    const next = ((): { status: string; timestamp: 'startedAt' | 'readyAt' | 'servedAt' | null } => {
      switch (action) {
        case 'start': return { status: 'preparing', timestamp: 'startedAt' };
        case 'ready': return { status: 'ready', timestamp: 'readyAt' };
        case 'serve': return { status: 'served', timestamp: 'servedAt' };
        case 'cancel': return { status: 'cancelled', timestamp: null };
      }
    })();
    if (!next) throw new BadRequestException('Invalid KDS action');
    const updated = await this.prisma.client.kitchenTicket.update({
      where: { id },
      data: { status: next.status as any, [next.timestamp || 'updatedAt']: now } as any,
    });
    await this.audit.record({
      entity: 'KitchenTicket',
      entityId: id,
      action: 'update' as any,
      newValues: { kdsAction: action, status: next.status },
    });
    this.events.publish('pos.kds.ticket_updated' as any, {
      organizationId: orgId,
      ticketId: id,
      action,
      status: next.status,
    });
    return this.serialize(updated);
  }

  /**
   * SSE stream. Emits one `data: {json}\n\n` snapshot every second. Lightweight
   * polling — the cashier terminal is the only thing writing, and the
   * KDS page is one of at most 3 monitors (bar, kitchen, cafe), so the
   * load is trivial.
   */
  async streamTickets(res: Response, station?: 'bar' | 'kitchen' | 'cafe'): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`retry: 5000\n\n`);

    let alive = true;
    const send = async () => {
      if (!alive) return;
      try {
        const tickets = await this.listTickets(station);
        res.write(`data: ${JSON.stringify({ type: 'snapshot', tickets })}\n\n`);
      } catch { /* noop */ }
    };
    await send();
    const id = setInterval(send, 1_000);

    res.on('close', () => {
      alive = false;
      clearInterval(id);
    });
  }

  private serialize = (t: any): KdsTicket => ({
    id: t.id,
    invoiceId: t.invoiceId,
    label: t.label,
    station: t.station,
    status: t.status,
    items: Array.isArray(t.items) ? t.items : [],
    startedAt: t.startedAt?.toISOString?.() ?? null,
    readyAt: t.readyAt?.toISOString?.() ?? null,
    servedAt: t.servedAt?.toISOString?.() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  });
}