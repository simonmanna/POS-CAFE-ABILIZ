/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { dec, sum, ZERO } from '../../../kernel/common/money';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { SequenceService } from '../../../kernel/sequence/sequence.service';
import { TaxCalculationService } from '../tax/tax-calculation.service';
import { AccountDeterminationService } from '../../accounting/posting/account-determination.service';

export interface DocumentLineInput {
  productId?: string;
  accountId?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  discountPercent?: number;
  taxId?: string;
  /**
   * P10: when true, the line's `unitPrice` is tax-inclusive. The tax engine
   * splits it as net = unitPrice / (1 + rate) and tax = unitPrice - net.
   * Overrides the Tax row's isInclusive flag for this line only.
   */
  taxInclusive?: boolean;
}

export interface DocumentHeaderInput {
  partnerId: string;
  issueDate: string;
  dueDate?: string;
  currencyId?: string;
  exchangeRate?: number;
  reference?: string;
  notes?: string;
  reversedDocumentId?: string;
}

interface PreparedLine {
  productId: string | null;
  accountId: string | null;
  description: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  taxId: string | null;
  subtotal: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  lineNumber: number;
  /** P10: whether the line is tax-inclusive (for receipt badge). */
  taxInclusive: boolean;
}

/**
 * Shared document logic for invoices & credit notes (ADR-010): the SERVER
 * computes line subtotals/tax/totals (never trust the client) and resolves the
 * accounts each line will post to.
 */
@Injectable()
export class DocumentBuilderService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly sequence: SequenceService,
    private readonly tax: TaxCalculationService,
    private readonly determination: AccountDeterminationService,
  ) {}

  async prepareLines(client: any, lines: DocumentLineInput[]) {
    const prepared: PreparedLine[] = [];
    let discountTotal = ZERO;

    for (const [i, l] of lines.entries()) {
      let product: any = null;
      if (l.productId) {
        product = await client.product.findFirst({ where: { id: l.productId }, include: { category: true } });
      }
      const unitPrice = l.unitPrice != null ? dec(l.unitPrice) : product?.salesPrice ? dec(product.salesPrice) : ZERO;
      const quantity = dec(l.quantity ?? 1);
      const discountPercent = dec(l.discountPercent ?? 0);
      const gross = quantity.times(unitPrice);
      const afterDiscount = gross.times(dec(1).minus(discountPercent.dividedBy(100)));
      discountTotal = discountTotal.plus(gross.minus(afterDiscount));

      const taxId = l.taxId ?? product?.taxId ?? null;
      let taxRow: any = null;
      if (taxId) taxRow = await client.tax.findFirst({ where: { id: taxId } });
      // P10: per-line taxInclusive override wins over product/tax default.
      // Falls back to product.taxInclusive (if set), then Tax.isInclusive.
      const taxInclusive = l.taxInclusive
        ?? (product as any)?.taxInclusive
        ?? (taxRow ? !!taxRow.isInclusive : false);
      const result = this.tax.computeLine(
        afterDiscount,
        taxRow
          ? [{ id: taxRow.id, rate: taxRow.rate, isInclusive: taxInclusive, isCompound: taxRow.isCompound }]
          : [],
      );

      prepared.push({
        productId: l.productId ?? null,
        accountId: l.accountId ?? null,
        description: l.description ?? product?.name ?? 'Item',
        quantity,
        unitPrice,
        discountPercent,
        taxId,
        subtotal: result.net,
        taxAmount: result.taxTotal,
        total: result.gross,
        lineNumber: i + 1,
        taxInclusive,
      });
    }

    const subtotal = sum(prepared.map((p) => p.subtotal));
    const taxAmount = sum(prepared.map((p) => p.taxAmount));
    return { prepared, subtotal, taxAmount, total: subtotal.plus(taxAmount), discountTotal };
  }

  async createDocument(
    client: any,
    documentType: 'sales_invoice' | 'credit_note' | 'vendor_bill',
    header: DocumentHeaderInput,
    lines: DocumentLineInput[],
  ) {
    const organizationId = this.tenant.organizationId;
    const totals = await this.prepareLines(client, lines);
    const year = new Date(header.issueDate).getUTCFullYear();
    const numbering: Record<string, { key: string; prefix: string }> = {
      sales_invoice: { key: `invoice:${year}`, prefix: `INV-${year}-` },
      credit_note: { key: `creditnote:${year}`, prefix: `CN-${year}-` },
      vendor_bill: { key: `vendorbill:${year}`, prefix: `BILL-${year}-` },
    };
    const seq = numbering[documentType];
    const documentNumber = await this.sequence.next(seq.key, { prefix: seq.prefix, padding: 6 }, client);

    return client.document.create({
      data: {
        organizationId,
        documentNumber,
        documentType,
        partnerId: header.partnerId,
        currencyId: header.currencyId ?? null,
        exchangeRate: dec(header.exchangeRate ?? 1),
        issueDate: new Date(header.issueDate),
        dueDate: header.dueDate ? new Date(header.dueDate) : null,
        status: 'draft',
        reference: header.reference ?? null,
        notes: header.notes ?? null,
        reversedDocumentId: header.reversedDocumentId ?? null,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        taxAmount: totals.taxAmount,
        totalAmount: totals.total,
        amountResidual: totals.total,
        amountPaid: ZERO,
        paymentStatus: 'not_paid',
        lines: {
          create: totals.prepared.map((p) => ({
            organizationId,
            productId: p.productId,
            accountId: p.accountId,
            description: p.description,
            quantity: p.quantity,
            unitPrice: p.unitPrice,
            discountPercent: p.discountPercent,
            taxId: p.taxId,
            subtotal: p.subtotal,
            taxAmount: p.taxAmount,
            total: p.total,
            lineNumber: p.lineNumber,
            // P10: taxInclusive persisted on the line so receipts can
            // render "(incl. tax)" without re-deriving it.
            taxInclusive: p.taxInclusive,
          })),
        },
      },
      include: { lines: true, partner: true },
    });
  }

  /**
   * Resolve the counter account (AR for sales, AP for purchase) plus the
   * income/expense and tax accounts (grouped) for a document.
   */
  async groupForPosting(client: any, doc: any, kind: 'sales' | 'purchase' = 'sales', _grniAccountId?: string) {
    const partner = await client.partner.findFirst({ where: { id: doc.partnerId } });
    const counterAccount =
      kind === 'sales'
        ? await this.determination.receivableAccount(partner, client)
        : await this.determination.payableAccount(partner, client);
    const itemByAccount = new Map<string, Prisma.Decimal>();
    const taxByAccount = new Map<string, Prisma.Decimal>();

    for (const line of doc.lines) {
      let category: any = null;
      if (line.productId) {
        const p = await client.product.findFirst({ where: { id: line.productId }, include: { category: true } });
        category = p?.category ?? null;
      }
      const itemAcc =
        kind === 'sales'
          ? await this.determination.incomeAccount({ lineAccountId: line.accountId, category }, client)
          : await this.determination.expenseAccount({ lineAccountId: line.accountId, category }, client);
      itemByAccount.set(itemAcc, (itemByAccount.get(itemAcc) ?? ZERO).plus(line.subtotal));

      if (line.taxId && !(line.taxAmount as Prisma.Decimal).isZero()) {
        const tax = await client.tax.findFirst({ where: { id: line.taxId } });
        const taxAcc = await this.determination.taxAccount(
          tax,
          client,
          kind === 'sales' ? 'tax_payable' : 'tax_receivable',
        );
        taxByAccount.set(taxAcc, (taxByAccount.get(taxAcc) ?? ZERO).plus(line.taxAmount));
      }
    }

    return { counterAccount, itemByAccount, taxByAccount };
  }
}