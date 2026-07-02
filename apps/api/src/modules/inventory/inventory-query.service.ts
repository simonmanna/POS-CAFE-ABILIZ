import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PaginationQuery } from '@erp/shared';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';

@Injectable()
export class InventoryQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async listItems(query: PaginationQuery & { locationId?: string; lowStock?: string }) {
    const organizationId = this.tenant.organizationId;
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 25));

    const where: any = { organizationId, product: { trackInventory: true } };
    if (query.locationId) where.locationId = query.locationId;
    if (query.lowStock === 'true') {
      where.AND = [
        { quantity: { gt: 0 } },
        Prisma.sql`quantity <= (SELECT "minQuantity" FROM "Product" WHERE "Product"."id" = "StockItem"."productId" AND "Product"."minQuantity" > 0)`,
      ];
    }

    const searchWhere: any = {};
    if (query.search) {
      searchWhere.OR = [
        { product: { code: { contains: query.search, mode: 'insensitive' } } },
        { product: { name: { contains: query.search, mode: 'insensitive' } } },
        { product: { sku: { contains: query.search, mode: 'insensitive' } } },
        { location: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.client.stockItem.findMany({
        where: { ...where, ...searchWhere },
        include: {
          product: { select: { id: true, code: true, name: true, sku: true, minQuantity: true, batchTracking: true, uom: true } },
          location: { select: { id: true, code: true, name: true } },
        },
        orderBy: { product: { name: 'asc' } },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.stockItem.count({ where: { ...where, ...searchWhere } }),
    ]);

    return { data, meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
  }

  /**
   * Fetches ALL products (like the Products list) with aggregated stock levels.
   * One row per product. When locationId is provided, totalQuantity reflects
   * stock at that location only.
   */
  async listProductStockLevels(query: PaginationQuery & { locationId?: string; lowStock?: string; outOfStock?: string }) {
    const organizationId = this.tenant.organizationId;
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 25));

    const where: any = { organizationId };
    const searchWhere: any = {};
    if (query.search) {
      searchWhere.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
        { sku: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const baseInclude = {
      stockItems: {
        select: {
          quantity: true,
          runningAverageCost: true,
          locationId: true,
          location: { select: { id: true, code: true, name: true } },
        },
      },
      uom: { select: { code: true } },
    } as const;

    const mapProduct = (p: any) => {
      const locationBreakdown = p.stockItems.map((si: any) => ({
        locationId: si.location.id,
        code: si.location.code,
        name: si.location.name,
        quantity: Number(si.quantity),
      }));

      const relevantItems = query.locationId
        ? p.stockItems.filter((si: any) => si.locationId === query.locationId)
        : p.stockItems;

      const totalQuantity = relevantItems.reduce((sum: number, si: any) => sum + Number(si.quantity), 0);
      const totalCost = relevantItems.reduce((sum: number, si: any) => sum + Number(si.quantity) * Number(si.runningAverageCost), 0);
      const qtyForCost = relevantItems.reduce((sum: number, si: any) => sum + Number(si.quantity), 0);
      const averageCost = qtyForCost > 0 ? totalCost / qtyForCost : 0;
      const minQty = p.minQuantity ? Number(p.minQuantity) : 0;

      return {
        id: p.id,
        code: p.code,
        name: p.name,
        sku: p.sku,
        productType: p.productType,
        minQuantity: p.minQuantity ? Number(p.minQuantity) : null,
        batchTracking: p.batchTracking,
        uom: p.uom?.code ?? null,
        totalQuantity,
        averageCost,
        totalValue: totalCost,
        locationBreakdown,
        isLow: minQty > 0 && totalQuantity > 0 && totalQuantity <= minQty,
        isOut: totalQuantity <= 0,
      };
    };

    const needsFilter = query.lowStock === 'true' || query.outOfStock === 'true';

    if (needsFilter) {
      const allProducts = await this.prisma.client.product.findMany({
        where: { ...where, ...searchWhere },
        include: baseInclude,
        orderBy: { name: 'asc' },
      });

      let filtered = allProducts.map(mapProduct);
      if (query.lowStock === 'true') filtered = filtered.filter((m) => m.isLow || m.isOut);
      if (query.outOfStock === 'true') filtered = filtered.filter((m) => m.isOut);

      const total = filtered.length;
      const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

      return {
        data: paged,
        meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.client.product.findMany({
        where: { ...where, ...searchWhere },
        include: baseInclude,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.product.count({ where: { ...where, ...searchWhere } }),
    ]);

    return {
      data: data.map(mapProduct),
      meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  async getItemDetail(productId: string, locationId?: string) {
    const organizationId = this.tenant.organizationId;
    const product = await this.prisma.client.product.findFirst({
      where: { id: productId },
      select: {
        id: true, code: true, name: true, sku: true, barcode: true, description: true,
        productType: true, costingMethod: true, minQuantity: true, reorderQty: true,
        batchTracking: true, trackInventory: true, stockPolicy: true,
        uomId: true, purchaseUomId: true,
        salesPrice: true, costPrice: true, isActive: true,
        createdAt: true, updatedAt: true,
        category: { select: { id: true, name: true, parentId: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    if (!product) throw new NotFoundException('Product not found');

    const where: any = { organizationId, productId };
    if (locationId) where.locationId = locationId;

    const items = await this.prisma.client.stockItem.findMany({
      where,
      include: {
        location: { select: { id: true, code: true, name: true, type: true } },
      },
    });

    const totalOnHand = items.reduce((sum, i) => sum.plus(i.quantity), new Prisma.Decimal(0));
    const totalValue = items.reduce((sum, i) => sum.plus(i.quantity.times(i.runningAverageCost)), new Prisma.Decimal(0));

    let batches: any[] = [];
    if (product.batchTracking) {
      const batchWhere: any = { organizationId, productId, isActive: true };
      if (locationId) batchWhere.locationId = locationId;
      batches = await this.prisma.client.inventoryBatch.findMany({
        where: batchWhere,
        include: { location: { select: { id: true, code: true, name: true } } },
        orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { receivedAt: 'asc' }],
      });
    }

    const recentLedger = await this.prisma.client.inventoryLedger.findMany({
      where: { organizationId, productId, ...(locationId ? { locationId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { location: { select: { code: true, name: true } }, batch: { select: { batchNumber: true } } },
    });

    const menuProducts = await this.prisma.client.menuProduct.findMany({
      where: { organizationId, productId },
      include: {
        menuItem: { select: { id: true, code: true, name: true } },
      },
    });

    const purchaseOrderLines = await this.prisma.client.purchaseOrderLine.findMany({
      where: { organizationId, productId },
      include: {
        order: {
          select: {
            id: true, orderNumber: true, status: true, createdAt: true,
            partner: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { order: { createdAt: 'desc' } },
      take: 50,
    });

    return {
      product,
      items,
      totalOnHand: Number(totalOnHand),
      totalValue: Number(totalValue),
      batches,
      recentLedger,
      menuProducts,
      purchaseOrderLines,
    };
  }

  async getStockStats() {
    const organizationId = this.tenant.organizationId;

    const [allProducts, totalLocations] = await Promise.all([
      this.prisma.client.product.findMany({
        where: { organizationId },
        select: {
          id: true,
          minQuantity: true,
          stockItems: { select: { quantity: true } },
        },
      }),
      this.prisma.client.inventoryLocation.count({ where: { organizationId, isActive: true } }),
    ]);

    const totalProducts = allProducts.length;
    const totalItems = allProducts.filter((p) =>
      p.stockItems.some((si) => si.quantity.gt(0)),
    ).length;
    const lowStockCount = allProducts.filter((p) => {
      const totalQty = p.stockItems.reduce((s, si) => s.plus(si.quantity), ZERO_DEC);
      const minQty = p.minQuantity ?? ZERO_DEC;
      return minQty.gt(0) && totalQty.gt(0) && totalQty.lte(minQty);
    }).length;

    return { totalItems, lowStockCount, totalLocations, totalProducts };
  }

  async getLedger(query: PaginationQuery & {
    productId?: string; locationId?: string; type?: string;
    referenceType?: string; dateFrom?: string; dateTo?: string;
  }) {
    const organizationId = this.tenant.organizationId;
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 25));

    const where: any = { organizationId };
    if (query.productId) where.productId = query.productId;
    if (query.locationId) where.locationId = query.locationId;
    if (query.type) where.type = query.type;
    if (query.referenceType) where.referenceType = query.referenceType;
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.createdAt.lte = new Date(query.dateTo);
    }

    const [data, total] = await Promise.all([
      this.prisma.client.inventoryLedger.findMany({
        where,
        include: {
          product: { select: { id: true, code: true, name: true } },
          variant: { select: { id: true, name: true } },
          location: { select: { id: true, code: true, name: true } },
          batch: { select: { id: true, batchNumber: true, expiryDate: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.inventoryLedger.count({ where }),
    ]);

    return { data, meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
  }

  // ===========================================================================
  // F.8 — Reports: expiry alert, par-based reorder, movement/variance summary
  // ===========================================================================

  /** Active batches expiring within `days` (default 30). FEFO order. */
  async getExpiringBatches(query: { days?: string | number; locationId?: string }) {
    const organizationId = this.tenant.organizationId;
    const days = Math.max(1, Number(query.days) || 30);
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + days);

    const where: any = {
      organizationId,
      isActive: true,
      quantity: { gt: 0 },
      expiryDate: { not: null, lte: horizon },
    };
    if (query.locationId) where.locationId = query.locationId;

    const batches = await this.prisma.client.inventoryBatch.findMany({
      where,
      include: {
        product: { select: { id: true, code: true, name: true, uom: { select: { code: true } } } },
        location: { select: { id: true, code: true, name: true } },
      },
      orderBy: [{ expiryDate: 'asc' }],
    });

    const now = Date.now();
    return batches.map((b) => ({
      ...b,
      daysToExpiry: b.expiryDate
        ? Math.ceil((new Date(b.expiryDate).getTime() - now) / 86_400_000)
        : null,
      expired: b.expiryDate ? new Date(b.expiryDate).getTime() < now : false,
    }));
  }

  /**
   * Par-based reorder suggestions. A product is below par when its total on-hand
   * (optionally at one location) is ≤ its minQuantity (par). Suggested order qty
   * is expressed in PURCHASE units: `reorderQty` when set, else the shortfall
   * converted via `uomConversion`.
   */
  async getReorderSuggestions(query: { locationId?: string }) {
    const organizationId = this.tenant.organizationId;

    const products = await this.prisma.client.product.findMany({
      where: {
        organizationId,
        trackInventory: true,
        OR: [{ minQuantity: { gt: 0 } }, { reorderQty: { gt: 0 } }],
      },
      select: {
        id: true,
        code: true,
        name: true,
        minQuantity: true,
        reorderQty: true,
        uomConversion: true,
        supplierId: true,
        supplier: { select: { id: true, name: true } },
        stockItems: {
          where: query.locationId ? { locationId: query.locationId } : {},
          select: { quantity: true },
        },
      },
    });

    const ZEROD = new Prisma.Decimal(0);
    const out = products.map((p) => {
      const onHand = p.stockItems.reduce((s, si) => s.plus(si.quantity), ZERO_DEC);
      const par = p.minQuantity ?? ZEROD;
      const shortfall = par.minus(onHand);
      const conversion = p.uomConversion && p.uomConversion.gt(0) ? p.uomConversion : new Prisma.Decimal(1);
      const suggestPurchaseQty =
        p.reorderQty && p.reorderQty.gt(0)
          ? p.reorderQty
          : shortfall.gt(0)
            ? shortfall.dividedBy(conversion).toDecimalPlaces(2, Prisma.Decimal.ROUND_CEIL)
            : ZEROD;
      return {
        productId: p.id,
        code: p.code,
        name: p.name,
        onHand: Number(onHand),
        par: Number(par),
        belowPar: onHand.lte(par),
        suggestedOrderQty: Number(suggestPurchaseQty),
        supplier: p.supplier,
      };
    });

    return out.filter((r) => r.belowPar);
  }

  /**
   * Movement summary per product over a window — the raw material for a
   * theoretical-vs-actual variance report. Groups the ledger by product and
   * move type and returns signed quantity + value totals.
   */
  async getMovementSummary(query: { start?: string; end?: string; locationId?: string }) {
    const organizationId = this.tenant.organizationId;
    const where: any = { organizationId };
    if (query.locationId) where.locationId = query.locationId;
    if (query.start || query.end) {
      where.createdAt = {};
      if (query.start) where.createdAt.gte = new Date(query.start);
      if (query.end) where.createdAt.lte = new Date(query.end);
    }

    const grouped = await this.prisma.client.inventoryLedger.groupBy({
      by: ['productId', 'type'],
      where,
      _sum: { quantityChange: true, totalValue: true },
    });

    const productIds = [...new Set(grouped.map((g) => g.productId))];
    const products = await this.prisma.client.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, code: true, name: true },
    });
    const nameById = Object.fromEntries(products.map((p) => [p.id, p]));

    const byProduct: Record<string, any> = {};
    for (const g of grouped) {
      const row = (byProduct[g.productId] ??= {
        product: nameById[g.productId] ?? { id: g.productId },
        byType: {},
        netQty: 0,
        netValue: 0,
      });
      const qty = Number(g._sum.quantityChange ?? 0);
      const val = Number(g._sum.totalValue ?? 0);
      row.byType[g.type] = { qty, value: val };
      row.netQty += qty;
      row.netValue += val;
    }

    return Object.values(byProduct);
  }
}

const ZERO_DEC = new Prisma.Decimal(0);
