import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';

export interface PaymentTermDto {
  code: string;
  name: string;
  netDays?: number;
  discountDays?: number | null;
  discountPercent?: number | null;
  isActive?: boolean;
}

/**
 * Payment terms (net-N with optional early-payment discount). Org-scoped by the
 * tenancy extension. Referenced by Partner.paymentTermId; `dueDateFor` derives an
 * invoice due date so AR aging / dunning have a real date instead of a null.
 */
@Injectable()
export class PaymentTermService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  list() {
    return this.prisma.client.paymentTerm.findMany({ orderBy: { code: 'asc' } });
  }

  async get(id: string) {
    const term = await this.prisma.client.paymentTerm.findFirst({ where: { id } });
    if (!term) throw new NotFoundException('Payment term not found');
    return term;
  }

  create(dto: PaymentTermDto) {
    return this.prisma.client.paymentTerm.create({
      data: {
        organizationId: this.tenant.organizationId,
        code: dto.code,
        name: dto.name,
        netDays: dto.netDays ?? 0,
        discountDays: dto.discountDays ?? null,
        discountPercent: dto.discountPercent ?? null,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async update(id: string, dto: Partial<PaymentTermDto>) {
    await this.get(id);
    return this.prisma.client.paymentTerm.update({
      where: { id },
      data: {
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.netDays !== undefined ? { netDays: dto.netDays } : {}),
        ...(dto.discountDays !== undefined ? { discountDays: dto.discountDays } : {}),
        ...(dto.discountPercent !== undefined ? { discountPercent: dto.discountPercent } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  async remove(id: string) {
    await this.get(id);
    return this.prisma.client.paymentTerm.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /** Net days for a term id (0 when none/absent). */
  async netDaysFor(paymentTermId: string | null | undefined): Promise<number> {
    if (!paymentTermId) return 0;
    const term = await this.prisma.client.paymentTerm.findFirst({ where: { id: paymentTermId } });
    return term?.netDays ?? 0;
  }

  /** Due date = base + a partner/term's net days. */
  async dueDateFor(paymentTermId: string | null | undefined, base: Date = new Date()): Promise<Date> {
    const days = await this.netDaysFor(paymentTermId);
    const due = new Date(base);
    due.setDate(due.getDate() + days);
    return due;
  }

  /**
   * Credit-control check for a credit sale. Throws when the partner is on hold or
   * the new balance would exceed their credit limit (0 = unlimited).
   */
  async assertCreditOk(
    partner: { creditHold?: boolean; creditLimit?: unknown } | null,
    currentBalance: number,
    addAmount: number,
  ): Promise<void> {
    if (!partner) return;
    if (partner.creditHold) throw new BadRequestException('Customer is on credit hold.');
    const limit = Number(partner.creditLimit ?? 0);
    if (limit > 0 && currentBalance + addAmount > limit) {
      throw new BadRequestException(
        `Credit limit exceeded: limit ${limit}, would become ${currentBalance + addAmount}.`,
      );
    }
  }
}
