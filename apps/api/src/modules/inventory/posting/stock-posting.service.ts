import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { StockMoveType, InventoryMovementType } from '@erp/shared';
import { dec, ZERO } from '../../../kernel/common/money';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { EventBus } from '../../../kernel/events/event-bus';
import { PostingService } from '../../accounting/posting/posting.service';
import { AccountDeterminationService } from '../../accounting/posting/account-determination.service';
import type { PostingLineInput } from '../../accounting/posting/posting.types';
import { CostResolverService, type CostResolution } from '../costing/cost-resolver.service';
import { InventoryPostingRuleService } from './posting-rule.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * StockPostingService — bridges inventory movements and the General Ledger.
 *
 * M3+: All methods now resolve GL accounts through the configurable
 * InventoryPostingRule engine (Dr/Cr per movement type) with a fallback to
 * the original hardcoded AccountMapping resolution when no rules exist yet.
 *
 * Every physical stock movement that has a financial impact posts a double-entry
 * journal entry, ensuring the GL always reflects true inventory value.
 */
@Injectable()
export class StockPostingService {
  private readonly log = new Logger(StockPostingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly events: EventBus,
    private readonly posting: PostingService,
    private readonly determination: AccountDeterminationService,
    private readonly costResolver: CostResolverService,
    private readonly ruleService: InventoryPostingRuleService,
  ) {}

  /**
   * Issue (sale / consumption / waste / expiry / sample / internal use):
   * Dr {expense} / Cr Stock Valuation.
   * The `movementType` defaults to STOCK_OUT but can be overridden for WASTE,
   * EXPIRY_WRITE_OFF, INTERNAL_CONSUMPTION, PROMO_SAMPLE etc. so the posting
   * rule engine resolves the correct debit account.
   */
  async postIssue(params: {
    productId: string;
    locationId: string;
    quantity: Prisma.Decimal.Value;
    date: Date;
    sourceType: string;
    sourceId: string;
    description?: string;
    /** Movement type for GL resolution. Defaults to 'STOCK_OUT'. */
    movementType?: InventoryMovementType;
    /** When the caller already computed the exact consumed value (FIFO/SPECIFIC/serial
     *  issues that decrement identified layers), pass it here so the GL leg uses it
     *  verbatim instead of re-resolving from the now-mutated batches/serials. */
    overrideTotalValue?: Prisma.Decimal;
    tx: any;
  }): Promise<CostResolution> {
    const qty = dec(params.quantity);
    if (qty.lte(ZERO)) throw new BadRequestException('Issue quantity must be positive');

    const product = await params.tx.product.findFirst({ where: { id: params.productId } });
    if (!product) throw new BadRequestException('Product not found');
    const stockItem = await params.tx.stockItem.findFirst({
      where: { organizationId: this.tenant.organizationId, productId: params.productId, locationId: params.locationId },
    });

    let resolution: CostResolution;
    if (params.overrideTotalValue !== undefined) {
      const totalValue = dec(params.overrideTotalValue);
      resolution = { unitCost: totalValue.gt(ZERO) ? totalValue.dividedBy(qty) : ZERO, totalValue };
    } else if (product.costingMethod === 'FIFO') {
      if (!product.batchTracking) {
        throw new BadRequestException('FIFO costing requires batchTracking=true on the product');
      }
      const batches = await params.tx.inventoryBatch.findMany({
        where: { organizationId: this.tenant.organizationId, productId: params.productId, locationId: params.locationId, quantity: { gt: 0 }, isActive: true },
        orderBy: [{ expiryDate: 'asc', nulls: 'last' }, { receivedAt: 'asc' }],
      });
      resolution = this.costResolver.resolveIssueCost(
        { costingMethod: 'FIFO', costPrice: product.costPrice ?? null },
        stockItem ? { quantity: dec(stockItem.quantity), runningAverageCost: dec(stockItem.runningAverageCost) } : null,
        qty,
        batches.map((b: any) => ({
          quantity: dec(b.quantity),
          unitCost: b.unitCost ? dec(b.unitCost) : null,
          expiryDate: b.expiryDate,
          receivedAt: b.receivedAt,
        })),
      );
    } else if (product.costingMethod === 'AVCO') {
      const unitCost = stockItem ? dec(stockItem.runningAverageCost) : dec(product.costPrice ?? 0);
      resolution = { unitCost, totalValue: unitCost.times(qty) };
    } else {
      resolution = this.costResolver.resolveIssueCost(
        { costingMethod: product.costingMethod, costPrice: product.costPrice ?? null },
        stockItem ? { quantity: dec(stockItem.quantity), runningAverageCost: dec(stockItem.runningAverageCost) } : null,
        qty,
      );
    }

    if (resolution.totalValue.lte(ZERO)) {
      return resolution;
    }

    const mt = (params.movementType ?? 'STOCK_OUT') as InventoryMovementType;
    const lines = await this.resolveLines(
      mt, params.productId, resolution.totalValue, params.tx,
    ) ?? await this.fallbackLinesIssue(mt, resolution.totalValue, product.name, params.tx);

    if (lines.length > 0) {
      await this.posting.post(
        {
          journalCode: 'INV',
          date: params.date,
          description: params.description ?? `Stock issue ${product.name}`,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          lines,
        },
        params.tx,
      );
    }

    return resolution;
  }

  /**
   * Return restock (customer return that goes back on the shelf).
   */
  async postReturnRestock(params: {
    productId: string;
    totalValue: Prisma.Decimal.Value;
    date: Date;
    sourceType: string;
    sourceId: string;
    description?: string;
    tx: any;
  }): Promise<void> {
    const totalValue = dec(params.totalValue);
    if (totalValue.lte(ZERO)) return;

    const product = await params.tx.product.findFirst({ where: { id: params.productId } });
    const name = product?.name ?? params.productId;

    const lines = await this.resolveLines(
      'RETURN_RESTOCK', params.productId, totalValue, params.tx,
    ) ?? await this.fallbackLinesReturnRestock(totalValue, name, params.tx);

    if (lines.length > 0) {
      await this.posting.post(
        {
          journalCode: 'INV',
          date: params.date,
          description: params.description ?? `Return restock ${name}`,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          lines,
        },
        params.tx,
      );
    }
  }

  /**
   * Receive stock from a vendor bill (the "GRNI accrual" leg).
   */
  async postReceiveFromBill(params: {
    productId: string;
    quantity: Prisma.Decimal.Value;
    unitCost: Prisma.Decimal.Value;
    date: Date;
    sourceType: string;
    sourceId: string;
    description?: string;
    tx: any;
  }): Promise<CostResolution> {
    const qty = dec(params.quantity);
    const unitCost = dec(params.unitCost);
    if (qty.lte(ZERO)) throw new BadRequestException('Receive quantity must be positive');
    if (unitCost.lt(ZERO)) throw new BadRequestException('Unit cost cannot be negative');

    const totalValue = unitCost.times(qty);
    if (totalValue.lte(ZERO)) {
      return { unitCost, totalValue, newRunningAverage: unitCost };
    }

    const lines = await this.resolveLines(
      'STOCK_IN', params.productId, totalValue, params.tx,
    ) ?? await this.fallbackLinesStockIn(totalValue, params.tx);

    if (lines.length > 0) {
      await this.posting.post(
        {
          journalCode: 'INV',
          date: params.date,
          description: params.description ?? 'Stock receipt',
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          lines,
        },
        params.tx,
      );
    }

    return { unitCost, totalValue, newRunningAverage: unitCost };
  }

  /**
   * Variance from a stock adjustment (count vs system):
   * positive (delta > 0) → ADJUSTMENT_GAIN, negative (delta < 0) → ADJUSTMENT_LOSS
   */
  async postAdjustment(params: {
    productId: string;
    delta: Prisma.Decimal.Value;
    unitCost: Prisma.Decimal.Value;
    date: Date;
    sourceType: string;
    sourceId: string;
    description?: string;
    tx: any;
  }): Promise<void> {
    const delta = dec(params.delta);
    const unitCost = dec(params.unitCost);
    if (delta.isZero()) return;

    const totalValue = unitCost.times(delta.abs());
    if (totalValue.lte(ZERO)) return;

    const movementType = delta.gt(ZERO) ? 'ADJUSTMENT_GAIN' : 'ADJUSTMENT_LOSS';

    const lines = await this.resolveLines(
      movementType as any, params.productId, totalValue, params.tx,
    ) ?? await this.fallbackLinesAdjustment(totalValue, params.tx, delta.gt(ZERO));

    if (lines.length > 0) {
      await this.posting.post(
        {
          journalCode: 'ADJ',
          date: params.date,
          description: params.description ?? 'Stock adjustment',
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          lines,
        },
        params.tx,
      );
    }
  }

  /**
   * Inter-location stock transfer:
   * Dr Stock Valuation (destination) / Cr Stock Valuation (source)
   *
   * When fromLocationId and toLocationId are in different branches, the seeded
   * rules post a clearing entry so each branch's books are accurate. For same-
   * org transfers the effect is typically a wash at the org level but the rules
   * still produce proper entries for auditability.
   */
  async postTransfer(params: {
    productId: string;
    totalValue: Prisma.Decimal.Value;
    fromLocationId: string;
    toLocationId: string;
    date: Date;
    sourceType: string;
    sourceId: string;
    description?: string;
    tx: any;
  }): Promise<void> {
    const totalValue = dec(params.totalValue);
    if (totalValue.lte(ZERO)) return;

    const product = await params.tx.product.findFirst({ where: { id: params.productId } });
    const name = product?.name ?? params.productId;

    // STOCK_TRANSFER_OUT (source location): Cr Stock Valuation
    const outLines = await this.resolveLines(
      'STOCK_TRANSFER_OUT', params.productId, totalValue, params.tx,
    );
    if (outLines && outLines.length > 0) {
      await this.posting.post(
        {
          journalCode: 'INV',
          date: params.date,
          description: params.description ?? `Transfer out · ${name}`,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          lines: outLines,
        },
        params.tx,
      );
    }

    // STOCK_TRANSFER_IN (destination location): Dr Stock Valuation
    const inLines = await this.resolveLines(
      'STOCK_TRANSFER_IN', params.productId, totalValue, params.tx,
    );
    if (inLines && inLines.length > 0) {
      await this.posting.post(
        {
          journalCode: 'INV',
          date: params.date,
          description: params.description ?? `Transfer in · ${name}`,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          lines: inLines,
        },
        params.tx,
      );
    }
  }

  /**
   * Return to supplier:
   * Dr Accounts Payable (or GRNI-Accrued) / Cr Stock Valuation
   */
  async postReturnToSupplier(params: {
    productId: string;
    totalValue: Prisma.Decimal.Value;
    date: Date;
    sourceType: string;
    sourceId: string;
    description?: string;
    tx: any;
  }): Promise<void> {
    const totalValue = dec(params.totalValue);
    if (totalValue.lte(ZERO)) return;

    const product = await params.tx.product.findFirst({ where: { id: params.productId } });
    const name = product?.name ?? params.productId;

    const lines = await this.resolveLines(
      'RETURN_TO_SUPPLIER', params.productId, totalValue, params.tx,
    ) ?? await (async (): Promise<PostingLineInput[]> => {
      const grniAccountId = await this.determination.mapped('grni_accrued', params.tx);
      const stockValuationAccountId = await this.determination.mapped('stock_valuation', params.tx);
      return [
        { accountId: stockValuationAccountId, credit: dec(totalValue).toString(), description: `Return to supplier · ${name}` },
        { accountId: grniAccountId, debit: dec(totalValue).toString(), description: `Return to supplier · ${name}` },
      ];
    })();

    if (lines.length > 0) {
      await this.posting.post(
        {
          journalCode: 'INV',
          date: params.date,
          description: params.description ?? `Return to supplier · ${name}`,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          lines,
        },
        params.tx,
      );
    }
  }

  /**
   * Internal consumption: Dr Internal Use / Cr Stock Valuation
   */
  async postInternalConsumption(params: {
    productId: string;
    totalValue: Prisma.Decimal.Value;
    date: Date;
    sourceType: string;
    sourceId: string;
    description?: string;
    tx: any;
  }): Promise<void> {
    const totalValue = dec(params.totalValue);
    if (totalValue.lte(ZERO)) return;

    const product = await params.tx.product.findFirst({ where: { id: params.productId } });
    const name = product?.name ?? params.productId;

    const lines = await this.resolveLines(
      'INTERNAL_CONSUMPTION', params.productId, totalValue, params.tx,
    ) ?? await (async (): Promise<PostingLineInput[]> => {
      const stockValuationAccountId = await this.determination.mapped('stock_valuation', params.tx);
      const intUseAccountId = await this.determination.mapped('default_expense', params.tx);
      return [
        { accountId: intUseAccountId, debit: dec(totalValue).toString(), description: `Internal use · ${name}` },
        { accountId: stockValuationAccountId, credit: dec(totalValue).toString(), description: `Internal use · ${name}` },
      ];
    })();

    if (lines.length > 0) {
      await this.posting.post(
        {
          journalCode: 'INV',
          date: params.date,
          description: params.description ?? `Internal consumption · ${name}`,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          lines,
        },
        params.tx,
      );
    }
  }

  /**
   * Promo sample: Dr Promo Expense / Cr Stock Valuation
   */
  async postPromoSample(params: {
    productId: string;
    totalValue: Prisma.Decimal.Value;
    date: Date;
    sourceType: string;
    sourceId: string;
    description?: string;
    tx: any;
  }): Promise<void> {
    const totalValue = dec(params.totalValue);
    if (totalValue.lte(ZERO)) return;

    const product = await params.tx.product.findFirst({ where: { id: params.productId } });
    const name = product?.name ?? params.productId;

    const lines = await this.resolveLines(
      'PROMO_SAMPLE', params.productId, totalValue, params.tx,
    ) ?? await (async (): Promise<PostingLineInput[]> => {
      const stockValuationAccountId = await this.determination.mapped('stock_valuation', params.tx);
      const promoExpenseAccountId = await this.determination.mapped('stock_adjustment_expense', params.tx);
      return [
        { accountId: promoExpenseAccountId, debit: dec(totalValue).toString(), description: `Promo sample · ${name}` },
        { accountId: stockValuationAccountId, credit: dec(totalValue).toString(), description: `Promo sample · ${name}` },
      ];
    })();

    if (lines.length > 0) {
      await this.posting.post(
        {
          journalCode: 'INV',
          date: params.date,
          description: params.description ?? `Promo sample · ${name}`,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          lines,
        },
        params.tx,
      );
    }
  }

  /**
   * Production consume: Dr WIP / Cr Stock Valuation (raw materials)
   */
  async postProductionConsume(params: {
    productId: string;
    totalValue: Prisma.Decimal.Value;
    date: Date;
    sourceType: string;
    sourceId: string;
    description?: string;
    tx: any;
  }): Promise<void> {
    const totalValue = dec(params.totalValue);
    if (totalValue.lte(ZERO)) return;

    const product = await params.tx.product.findFirst({ where: { id: params.productId } });
    const name = product?.name ?? params.productId;

    const lines = await this.resolveLines(
      'PRODUCTION_CONSUME', params.productId, totalValue, params.tx,
    ) ?? await (async (): Promise<PostingLineInput[]> => {
      const stockValuationAccountId = await this.determination.mapped('stock_valuation', params.tx);
      const wipAccountId = await this.determination.mapped('wip', params.tx).catch(() => stockValuationAccountId);
      return [
        { accountId: wipAccountId, debit: dec(totalValue).toString(), description: `Production consume · ${name}` },
        { accountId: stockValuationAccountId, credit: dec(totalValue).toString(), description: `Production consume · ${name}` },
      ];
    })();

    if (lines.length > 0) {
      await this.posting.post(
        {
          journalCode: 'INV',
          date: params.date,
          description: params.description ?? `Production consume · ${name}`,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          lines,
        },
        params.tx,
      );
    }
  }

  /**
   * Production output: Dr Stock Valuation (finished) / Cr WIP
   */
  async postProductionOutput(params: {
    productId: string;
    totalValue: Prisma.Decimal.Value;
    date: Date;
    sourceType: string;
    sourceId: string;
    description?: string;
    tx: any;
  }): Promise<void> {
    const totalValue = dec(params.totalValue);
    if (totalValue.lte(ZERO)) return;

    const product = await params.tx.product.findFirst({ where: { id: params.productId } });
    const name = product?.name ?? params.productId;

    const lines = await this.resolveLines(
      'PRODUCTION_OUTPUT', params.productId, totalValue, params.tx,
    ) ?? await (async (): Promise<PostingLineInput[]> => {
      const stockValuationAccountId = await this.determination.mapped('stock_valuation', params.tx);
      const wipAccountId = await this.determination.mapped('wip', params.tx).catch(() => stockValuationAccountId);
      return [
        { accountId: stockValuationAccountId, debit: dec(totalValue).toString(), description: `Production output · ${name}` },
        { accountId: wipAccountId, credit: dec(totalValue).toString(), description: `Production output · ${name}` },
      ];
    })();

    if (lines.length > 0) {
      await this.posting.post(
        {
          journalCode: 'INV',
          date: params.date,
          description: params.description ?? `Production output · ${name}`,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          lines,
        },
        params.tx,
      );
    }
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  /**
   * Try to resolve posting lines from the rule engine.
   * Returns null if no rules configured (caller should use fallback).
   */
  private async resolveLines(
    movementType: any,
    productId: string,
    totalValue: Prisma.Decimal.Value,
    tx: any,
  ): Promise<PostingLineInput[] | null> {
    try {
      const lines = await this.ruleService.resolve(movementType, productId, totalValue, { tx });
      return lines;
    } catch (err: any) {
      if (err.message?.includes('No posting rule configured')) {
        this.log.warn(`No posting rule for ${movementType}, falling back to AccountMapping defaults`);
        return null;
      }
      throw err;
    }
  }

  // ─── Fallback methods ────────────────────────────────────────────────────

  private async fallbackLinesIssue(movementType: InventoryMovementType, totalValue: Prisma.Decimal.Value, productName: string, tx: any): Promise<PostingLineInput[]> {
    // For non-standard issue types, try to use a sensible fallback
    if (movementType === 'WASTE' || movementType === 'EXPIRY_WRITE_OFF' || movementType === 'INTERNAL_CONSUMPTION' || movementType === 'PROMO_SAMPLE') {
      const stockValuationAccountId = await this.determination.mapped('stock_valuation', tx);
      const expenseAccountId = await this.determination.mapped('stock_adjustment_expense', tx);
      return [
        { accountId: expenseAccountId, debit: dec(totalValue).toString(), description: `${movementType} · ${productName}` },
        { accountId: stockValuationAccountId, credit: dec(totalValue).toString(), description: `${movementType} · ${productName}` },
      ];
    }
    // Default: standard COGS/Stock posting
    const cogsAccountId = await this.determination.mapped('cogs', tx);
    const stockValuationAccountId = await this.determination.mapped('stock_valuation', tx);
    return [
      { accountId: cogsAccountId, debit: dec(totalValue).toString(), description: `COGS · ${productName}` },
      { accountId: stockValuationAccountId, credit: dec(totalValue).toString(), description: `Stock issue · ${productName}` },
    ];
  }

  private async fallbackLinesReturnRestock(totalValue: Prisma.Decimal.Value, productName: string, tx: any): Promise<PostingLineInput[]> {
    const stockValuationAccountId = await this.determination.mapped('stock_valuation', tx);
    const cogsAccountId = await this.determination.mapped('cogs', tx);
    return [
      { accountId: stockValuationAccountId, debit: dec(totalValue).toString(), description: `Return restock · ${productName}` },
      { accountId: cogsAccountId, credit: dec(totalValue).toString(), description: `COGS reversal · ${productName}` },
    ];
  }

  private async fallbackLinesStockIn(totalValue: Prisma.Decimal.Value, tx: any): Promise<PostingLineInput[]> {
    const stockValuationAccountId = await this.determination.mapped('stock_valuation', tx);
    const grniAccountId = await this.determination.mapped('grni_accrued', tx);
    return [
      { accountId: stockValuationAccountId, debit: dec(totalValue).toString(), description: 'Stock receipt' },
      { accountId: grniAccountId, credit: dec(totalValue).toString(), description: 'GRNI accrual' },
    ];
  }

  private async fallbackLinesAdjustment(totalValue: Prisma.Decimal.Value, tx: any, isPositive: boolean): Promise<PostingLineInput[]> {
    const stockValuationAccountId = await this.determination.mapped('stock_valuation', tx);
    if (isPositive) {
      return [
        { accountId: stockValuationAccountId, debit: dec(totalValue).toString(), description: 'Stock variance gain' },
        { accountId: await this.determination.mapped('stock_adjustment_income', tx), credit: dec(totalValue).toString(), description: 'Stock variance gain' },
      ];
    }
    return [
      { accountId: await this.determination.mapped('stock_adjustment_expense', tx), debit: dec(totalValue).toString(), description: 'Stock variance loss' },
      { accountId: stockValuationAccountId, credit: dec(totalValue).toString(), description: 'Stock variance loss' },
    ];
  }
}
