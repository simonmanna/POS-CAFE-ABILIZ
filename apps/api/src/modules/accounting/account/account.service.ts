import { Injectable } from '@nestjs/common';
import type { Account } from '@prisma/client';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { BaseCrudService, type CrudDelegate } from '../../../kernel/common/base-crud.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@Injectable()
export class AccountService extends BaseCrudService<Account, CreateAccountDto, UpdateAccountDto> {
  protected readonly entityName = 'Account';
  protected readonly searchFields = ['code', 'name'];
  protected readonly defaultOrderBy = { code: 'asc' as const };

  constructor(private readonly prisma: PrismaService) {
    super(prisma.client.account as unknown as CrudDelegate);
  }
}
