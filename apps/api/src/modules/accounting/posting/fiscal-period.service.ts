import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../kernel/prisma/prisma.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Period control (ADR-009): a posting date that falls inside a defined fiscal
 * period must land in an `open` one. If no period covers the date, posting is
 * allowed (organizations that don't manage periods are unaffected).
 */
@Injectable()
export class FiscalPeriodService {
  constructor(private readonly prisma: PrismaService) {}

  async assertOpen(date: Date, client: any = this.prisma.client): Promise<void> {
    const period = await client.fiscalPeriod.findFirst({
      where: { startDate: { lte: date }, endDate: { gte: date } },
    });
    if (period && period.status !== 'open') {
      throw new BadRequestException(
        `Fiscal period '${period.name}' is ${period.status}; cannot post on ${date.toISOString().slice(0, 10)}`,
      );
    }
  }
}
