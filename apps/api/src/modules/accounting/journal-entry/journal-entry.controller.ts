import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { PaginationDto } from '../../../kernel/common/pagination.dto';
import { RequirePermissions } from '../../../kernel/auth/decorators/require-permissions.decorator';
import { JournalEntryService } from './journal-entry.service';
import { CreateJournalEntryDto, ReverseJournalEntryDto } from './dto/create-journal-entry.dto';

@Controller('journal-entries')
export class JournalEntryController {
  constructor(private readonly entries: JournalEntryService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.journalEntry.read)
  list(@Query() query: PaginationDto) {
    return this.entries.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.journalEntry.read)
  findOne(@Param('id') id: string) {
    return this.entries.findOne(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.journalEntry.post)
  create(@Body() dto: CreateJournalEntryDto) {
    return this.entries.createManual(dto);
  }

  @Post(':id/reverse')
  @RequirePermissions(PERMISSIONS.journalEntry.reverse)
  reverse(@Param('id') id: string, @Body() dto: ReverseJournalEntryDto) {
    return this.entries.reverse(id, dto);
  }
}
