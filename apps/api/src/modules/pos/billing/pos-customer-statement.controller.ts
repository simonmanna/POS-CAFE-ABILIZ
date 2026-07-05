/**
 * POS — Customer credit statement (D4).
 *
 * A read-only house-account statement DERIVED from the source records, not a
 * second set of books:
 *   - charges   ← credit Invoices (paymentMode = 'credit')
 *   - payments  ← PaymentAllocations against those invoices (inbound)
 *   - write-offs← 'pos_invoice_writeoff' journal entries on those invoices
 *
 * Deriving avoids the drift a parallel ledger would introduce, and surfaces
 * historical credit sales with no backfill. `CustomerTab.balance` /
 * `CustomerTabLedger` remain reserved for the manual tab API in
 * pos-loyalty.service.ts and are intentionally NOT touched here.
 *
 * Scope note: this covers on-account (credit) invoices only. A full AR
 * statement across all invoice payment modes is a where-clause extension.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Controller, Get, Injectable, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';

export interface StatementEntry {
  date: string;
  type: 'credit_issue' | 'payment' | 'write_off';
  reference: string;
  invoiceId: string;
  invoiceNumber: string;
  /** Signed: charges positive (increase balance), payments/write-offs negative. */
  amount: number;
  runningBalance: number;
}

export interface CustomerStatement {
  partner: { id: string; name: string; code: string | null };
  creditLimit: number;
  outstanding: number;
  entries: StatementEntry[];
}

@Injectable()
export class PosCustomerStatementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async statement(partnerId: string): Promise<CustomerStatement> {
    const orgId = this.tenant.organizationId;

    const partner = await this.prisma.client.partner.findFirst({
      where: { id: partnerId, organizationId: orgId },
      select: { id: true, name: true, code: true },
    });
    if (!partner) throw new NotFoundException('Customer not found');

    const invoices = await this.prisma.client.invoice.findMany({
      where: { organizationId: orgId, partnerId, paymentMode: 'credit' },
      select: {
        id: true, invoiceNumber: true, issueDate: true, createdAt: true,
        totalAmount: true, amountResidual: true, settlementStatus: true,
      },
    });
    const invoiceIds = invoices.map((i) => i.id);
    const invById = new Map(invoices.map((i) => [i.id, i]));

    const allocations = invoiceIds.length
      ? await this.prisma.client.paymentAllocation.findMany({
          where: { organizationId: orgId, invoiceId: { in: invoiceIds } },
          include: { payment: { select: { paymentNumber: true, paymentDate: true, direction: true } } },
        })
      : [];

    // Write-offs: sum a per-invoice allocation total so the written-off amount is
    // total − paid. `Invoice.amountPaid` is faked to totalAmount by writeOff(),
    // so it can't be used here.
    const writeOffEntries = invoiceIds.length
      ? await this.prisma.client.journalEntry.findMany({
          where: { organizationId: orgId, sourceType: 'pos_invoice_writeoff', sourceId: { in: invoiceIds } },
          select: { sourceId: true, postingDate: true, createdAt: true },
        })
      : [];

    const paidByInvoice = new Map<string, number>();
    for (const a of allocations) {
      if ((a.payment?.direction ?? 'inbound') !== 'inbound') continue;
      paidByInvoice.set(a.invoiceId!, (paidByInvoice.get(a.invoiceId!) ?? 0) + Number(a.amount));
    }

    const rows: Omit<StatementEntry, 'runningBalance'>[] = [];

    // Charge = the credit issue (booked at bill time).
    for (const inv of invoices) {
      rows.push({
        date: new Date(inv.issueDate ?? inv.createdAt).toISOString(),
        type: 'credit_issue',
        reference: inv.invoiceNumber,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amount: Number(inv.totalAmount),
      });
    }
    // Payments reduce the balance.
    for (const a of allocations) {
      if ((a.payment?.direction ?? 'inbound') !== 'inbound') continue;
      const inv = invById.get(a.invoiceId!);
      if (!inv) continue;
      rows.push({
        date: new Date(a.payment?.paymentDate ?? a.createdAt).toISOString(),
        type: 'payment',
        reference: a.payment?.paymentNumber ?? '—',
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amount: -Number(a.amount),
      });
    }
    // Write-offs clear the remaining balance.
    for (const w of writeOffEntries) {
      const inv = invById.get(w.sourceId!);
      if (!inv) continue;
      const written = Number(inv.totalAmount) - (paidByInvoice.get(inv.id) ?? 0);
      if (written <= 0.001) continue;
      rows.push({
        date: new Date(w.postingDate ?? w.createdAt).toISOString(),
        type: 'write_off',
        reference: inv.invoiceNumber,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amount: -written,
      });
    }

    rows.sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    const entries: StatementEntry[] = rows.map((r) => {
      running = Math.round((running + r.amount) * 100) / 100;
      return { ...r, runningBalance: running };
    });

    const outstanding = invoices
      .filter((i) => i.settlementStatus === 'unsettled' || i.settlementStatus === 'partially_settled')
      .reduce((s, i) => s + Number(i.amountResidual), 0);

    const tab = await this.prisma.client.customerTab.findFirst({ where: { organizationId: orgId, partnerId } });

    return {
      partner,
      creditLimit: Number(tab?.creditLimit ?? 0),
      outstanding: Math.round(outstanding * 100) / 100,
      entries,
    };
  }
}

@ApiTags('POS')
@ApiBearerAuth()
@Controller('pos/customers')
export class PosCustomerStatementController {
  constructor(private readonly service: PosCustomerStatementService) {}

  /** Derived house-account statement for a customer. */
  @Get(':partnerId/statement')
  @RequirePermissions('pos:read')
  statement(@Param('partnerId') partnerId: string): Promise<CustomerStatement> {
    return this.service.statement(partnerId);
  }
}
