import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { dec, ZERO } from '../../kernel/common/money';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { AuditService } from '../../kernel/audit/audit.service';
import { PostingService } from '../accounting/posting/posting.service';
import { StockService, InternalIssueInput } from './stock.service';
import { StockPostingService } from './posting/stock-posting.service';

export type ReversibleStockDoc = 'stock_out' | 'waste' | 'stock_adjustment' | 'stock_transfer';

/**
 * Posted reversals.
 *
 * A reversal never edits or deletes history (the ledger and posted journals are
 * append-only). It posts NEW, linked evidence dated today, in the current open
 * period:
 *   - stock: the inverse of every ledger row the document wrote — an issue is
 *     received back into the same lot / serial at its original cost, a receipt is
 *     issued back out of the same lot / serial (`reversal_in` / `reversal_out`,
 *     referenceType `<kind>_reversal`, referenceId = the document code);
 *   - GL: every journal entry the document posted is mirrored line-for-line
 *     (debits ↔ credits) under sourceType `<kind>_reversal`, and any difference
 *     between the value the GL reverses and the value the layers actually moved
 *     (a lot consumed since, a changed average) is squared up as a stock
 *     adjustment, so the GL keeps tying to the sub-ledger.
 */
@Injectable()
export class StockReversalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
    private readonly stock: StockService,
    private readonly stockPosting: StockPostingService,
  ) {}

  private get org(): string {
    return this.tenant.organizationId;
  }

  // ===========================================================================
  // Stock documents
  // ===========================================================================

  async reverseDocument(kind: ReversibleStockDoc, id: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('A reason is required to reverse a posted document');
    const spec = this.docSpec(kind);
    const doc = await spec.model(this.prisma.client).findFirst({ where: { id } });
    if (!doc) throw new NotFoundException(`${spec.label} not found`);
    if (doc.reversedAt || doc.status === 'reversed') throw new ConflictException(`${spec.label} ${doc[spec.codeField]} is already reversed`);
    if (doc.status !== 'completed' || !doc.postedAt) {
      throw new BadRequestException(`Only posted ${spec.label.toLowerCase()}s can be reversed (this one is ${doc.status}); cancel it instead`);
    }
    const code: string = doc[spec.codeField];

    return this.prisma.client.$transaction(
      async (tx: any) => {
        // Atomic claim: a second concurrent reversal matches nothing.
        const claim = await spec.model(tx).updateMany({
          where: { id, organizationId: this.org, reversedAt: null, status: 'completed' },
          data: { status: 'reversed', reversedAt: new Date(), reversedById: this.tenant.userId ?? null, reversalReason: reason.trim() },
        });
        if (claim.count === 0) throw new ConflictException(`${spec.label} ${code} was reversed concurrently`);

        const reversalSource = `${kind}_reversal`;
        if (kind === 'stock_transfer') {
          await this.reverseTransferMovements(tx, doc, code, reason);
        } else {
          await this.reverseLedgerSource(tx, {
            referenceType: spec.ledgerReferenceType,
            referenceId: code,
            reversalSourceType: reversalSource,
            reversalSourceId: code,
            journalSourceTypes: spec.journalSourceTypes,
            notes: `Reversal of ${code}: ${reason.trim()}`,
            legacyNotesPrefix: kind === 'stock_adjustment' ? `${code} ·` : undefined,
          });
        }

        await this.audit.recordInTx(tx, {
          entity: spec.entity,
          entityId: id,
          action: 'update',
          newValues: { status: 'reversed', reversalReason: reason.trim(), code },
        });
        return spec.model(tx).findFirst({ where: { id }, include: { items: true } });
      },
      { timeout: 60_000 },
    );
  }

  private docSpec(kind: ReversibleStockDoc) {
    switch (kind) {
      case 'stock_out':
        return { model: (db: any) => db.stockOut, codeField: 'outCode', label: 'Stock-out', entity: 'StockOut', ledgerReferenceType: 'stock_out', journalSourceTypes: ['stock_out'] };
      case 'waste':
        return { model: (db: any) => db.wasteRecord, codeField: 'wasteCode', label: 'Waste record', entity: 'WasteRecord', ledgerReferenceType: 'waste', journalSourceTypes: ['waste'] };
      case 'stock_adjustment':
        return { model: (db: any) => db.stockAdjustment, codeField: 'adjCode', label: 'Adjustment', entity: 'StockAdjustment', ledgerReferenceType: 'stock_adjustment', journalSourceTypes: ['stock_adjustment', 'stock_adjust'] };
      case 'stock_transfer':
        return { model: (db: any) => db.stockTransfer, codeField: 'transferCode', label: 'Transfer', entity: 'StockTransfer', ledgerReferenceType: 'stock_transfer', journalSourceTypes: ['stock_transfer'] };
    }
  }

  /** Move a completed transfer's quantities back from destination to source (GL-neutral, re-posted by transfer()). */
  private async reverseTransferMovements(tx: any, doc: any, code: string, reason: string) {
    const rows = await tx.inventoryLedger.findMany({
      where: { organizationId: this.org, referenceType: 'stock_transfer', referenceId: code, type: 'transfer_in' },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) throw new BadRequestException(`Transfer ${code} has no posted movements to reverse`);
    const byProduct = new Map<string, { productId: string; variantId: string | null; locationId: string; qty: ReturnType<typeof dec> }>();
    for (const r of rows) {
      const key = `${r.productId}:${r.variantId ?? ''}:${r.locationId}`;
      const cur = byProduct.get(key) ?? { productId: r.productId, variantId: r.variantId, locationId: r.locationId, qty: ZERO };
      cur.qty = cur.qty.plus(dec(r.quantityChange));
      byProduct.set(key, cur);
    }
    for (const line of byProduct.values()) {
      await this.stock.transfer(
        {
          productId: line.productId,
          variantId: line.variantId ?? undefined,
          fromLocationId: line.locationId,
          toLocationId: doc.fromLocId,
          quantity: Number(line.qty),
          sourceType: 'stock_transfer_reversal',
          sourceId: code,
          notes: `Reversal of ${code}: ${reason.trim()}`,
          approvedById: this.tenant.userId ?? undefined,
        },
        tx,
      );
    }
  }

  // ===========================================================================
  // Shared engine (also used by goods-receipt reversal)
  // ===========================================================================

  /**
   * Post the inverse of every ledger row written under (referenceType,
   * referenceId), mirror the journals posted for it, and square any value
   * difference. Runs inside the caller's transaction.
   */
  async reverseLedgerSource(
    tx: any,
    p: {
      referenceType: string;
      referenceId: string;
      reversalSourceType: string;
      reversalSourceId: string;
      journalSourceTypes: string[];
      notes: string;
      legacyNotesPrefix?: string;
    },
  ): Promise<{ rows: number; journals: number }> {
    const rows = await tx.inventoryLedger.findMany({
      where: {
        organizationId: this.org,
        OR: [
          { referenceType: p.referenceType, referenceId: p.referenceId },
          // Adjustments posted before referenceType carried the document code
          // were stamped only in their notes ("ADJ-00012 · reason").
          ...(p.legacyNotesPrefix
            ? [{ referenceType: 'stock_adjust', notes: { startsWith: p.legacyNotesPrefix } }]
            : []),
        ],
      },
      include: {
        batch: { select: { batchNumber: true, expiryDate: true } },
        serial: { select: { serialNumber: true } },
        product: { select: { name: true, batchTracking: true, serialTracking: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) throw new BadRequestException(`${p.referenceId} has no posted stock movements to reverse`);

    // Journal entries this source posted: by document id / code or per ledger code.
    const sourceIds = [p.referenceId, ...new Set(rows.map((r: any) => r.ledgerCode))];
    const journals = await tx.journalEntry.findMany({
      where: {
        organizationId: this.org,
        status: 'posted',
        sourceType: { in: p.journalSourceTypes },
        sourceId: { in: sourceIds },
        reversalOfId: null,
      },
      include: { lines: true, journal: { select: { code: true } } },
    });

    // Value the GL will reverse per product vs value the layers actually move.
    const glValueByProduct = new Map<string, ReturnType<typeof dec>>();
    const movedByProduct = new Map<string, ReturnType<typeof dec>>();
    const add = (m: Map<string, any>, k: string, v: any) => m.set(k, (m.get(k) ?? ZERO).plus(v));

    for (const r of rows) {
      const qty = dec(r.quantityChange).abs();
      if (qty.isZero()) continue;
      const originalValue = dec(r.totalValue);
      // The original movement's signed effect on inventory value.
      add(glValueByProduct, r.productId, dec(r.quantityChange).gt(ZERO) ? originalValue : originalValue.negated());

      const common = {
        productId: r.productId,
        variantId: r.variantId ?? undefined,
        locationId: r.locationId,
        quantity: Number(qty),
        sourceType: p.reversalSourceType,
        sourceId: p.reversalSourceId,
        notes: p.notes,
        responsibleById: r.responsibleById ?? undefined,
        approvedById: this.tenant.userId ?? undefined,
        serialNumbers: r.serial?.serialNumber ? [r.serial.serialNumber] : undefined,
        batchNumber: r.batch?.batchNumber ?? undefined,
      };

      if (dec(r.quantityChange).lt(ZERO)) {
        // Original took stock out → put it back at its original cost.
        const res = await this.stock.receive(
          {
            ...common,
            unitCost: Number(r.unitCost),
            moveType: 'reversal_in',
            batchNumber: r.product.batchTracking ? (r.batch?.batchNumber ?? `REV-${p.reversalSourceId}`) : undefined,
            expiryDate: r.product.batchTracking && r.batch?.expiryDate ? new Date(r.batch.expiryDate).toISOString() : undefined,
          } as any,
          tx,
        );
        add(movedByProduct, r.productId, dec(res.totalValue).negated());
      } else {
        // Original brought stock in → take it back out of the same lot / serial.
        const res = await this.stock.issue(
          {
            ...common,
            moveType: 'reversal_out',
            distStrategy: r.batch?.batchNumber ? 'MANUAL' : undefined,
            skipGlPosting: true,
          } as InternalIssueInput,
          tx,
        );
        add(movedByProduct, r.productId, dec(res.totalValue));
      }
    }

    for (const je of journals) {
      await this.posting.post(
        {
          journalCode: je.journal.code,
          date: new Date(),
          description: `Reversal of ${je.entryNumber} · ${p.notes}`,
          sourceType: p.reversalSourceType,
          sourceId: p.reversalSourceId,
          postingType: 'reversal',
          postingKey: `inventory:reversal:${this.org}:${je.id}`,
          branchId: je.branchId ?? undefined,
          costCenterId: je.costCenterId ?? undefined,
          lines: je.lines.filter((l: any) => dec(l.debit).gt(ZERO) || dec(l.credit).gt(ZERO)).map((l: any) => ({
            accountId: l.accountId,
            partnerId: l.partnerId ?? undefined,
            description: `Reversal: ${l.description ?? ''}`.trim(),
            debit: dec(l.credit).gt(ZERO) ? l.credit.toString() : undefined,
            credit: dec(l.debit).gt(ZERO) ? l.debit.toString() : undefined,
          })),
        },
        tx,
      );
    }

    // Square up: the GL mirror reverses each product's ORIGINAL value; the
    // layers moved `moved`. Post the difference so Stock Valuation follows the
    // sub-ledger. Only meaningful when the original actually hit the GL.
    if (journals.length > 0) {
      for (const [productId, original] of glValueByProduct) {
        const moved = movedByProduct.get(productId) ?? ZERO;
        // GL value change from the mirror = -original; ledger change = -moved.
        const diff = original.minus(moved); // amount GL over-reversed (Dr stock when > 0)
        if (diff.abs().lt(dec('0.005'))) continue;
        await this.stockPosting.postAdjustment({
          productId,
          delta: diff.gt(ZERO) ? 1 : -1,
          unitCost: diff.abs(),
          date: new Date(),
          sourceType: p.reversalSourceType,
          sourceId: p.reversalSourceId,
          description: `Reversal cost difference · ${p.referenceId}`,
          tx,
        });
      }
    }

    return { rows: rows.length, journals: journals.length };
  }
}
