import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { PaginationDto } from '../../../kernel/common/pagination.dto';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { CreditNoteService } from './credit-note.service';
import { CreateCreditNoteDto } from './dto/credit-note.dto';

@Controller('credit-notes')
export class CreditNoteController {
  constructor(private readonly creditNotes: CreditNoteService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.creditNote.read)
  list(@Query() query: PaginationDto) {
    return this.creditNotes.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.creditNote.read)
  findOne(@Param('id') id: string) {
    return this.creditNotes.findOne(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.creditNote.create)
  create(@Body() dto: CreateCreditNoteDto) {
    return this.creditNotes.create(dto);
  }

  @Post(':id/post')
  @RequirePermissions(PERMISSIONS.creditNote.post)
  post(@Param('id') id: string) {
    return this.creditNotes.post(id);
  }
}
