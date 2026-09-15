import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { PERMISSIONS } from '@erp/shared';
import { PaginationDto } from '../../kernel/common/pagination.dto';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { Idempotent } from '../../kernel/idempotency/idempotent.decorator';
import { IdempotencyInterceptor } from '../../kernel/idempotency/idempotency.interceptor';
import { LocationService } from './location.service';
import { StockDocService } from './stock-doc.service';
import { StockReversalService } from './stock-reversal.service';
import { InventoryQueryService } from './inventory-query.service';
import { LedgerDetailService } from './ledger-detail.service';
import { InventoryReportsService, type ReportScopeQuery } from './inventory-reports.service';
import { InventoryRegisterService, type RegisterQuery } from './inventory-register.service';
import { InventoryQueryDto } from './dto/inventory-query.dto';
import { DirectStockService } from './direct-stock.service';
import { DirectStockInDto, DirectStockOutDto, StockLedgerQueryDto } from './dto/direct-stock.dto';
import { CreateLocationDto, UpdateLocationDto, LocationQueryDto } from './dto/location.dto';
import {
  CreateStockOutDto,
  CreateWasteDto,
  CreateStockAdjustmentDto,
  CreateStockTransferDto,
  ReceiveStockTransferDto,
  WasteQueryDto,
  ApproveAdjustmentDto,
  ReverseStockDocDto,
} from './dto/stock-doc.dto';

@Controller('inventory')
@UseInterceptors(IdempotencyInterceptor)
export class InventoryController {
  constructor(
    private readonly locations: LocationService,
    private readonly stockDocs: StockDocService,
    private readonly reversals: StockReversalService,
    private readonly queries: InventoryQueryService,
    private readonly directStock: DirectStockService,
    private readonly ledgerDetail: LedgerDetailService,
    private readonly reports: InventoryReportsService,
    private readonly registers: InventoryRegisterService,
  ) {}

  // ---- Locations ----

  @Get('locations')
  @RequirePermissions(PERMISSIONS.inventoryLocation.read)
  listLocations(@Query() query: LocationQueryDto) {
    return this.locations.list(query);
  }

  @Get('locations/:id')
  @RequirePermissions(PERMISSIONS.inventoryLocation.read)
  findLocation(@Param('id') id: string) {
    return this.locations.findOne(id);
  }

  @Post('locations')
  @RequirePermissions(PERMISSIONS.inventoryLocation.create)
  createLocation(@Body() dto: CreateLocationDto) {
    return this.locations.create(dto);
  }

  @Patch('locations/:id')
  @RequirePermissions(PERMISSIONS.inventoryLocation.update)
  updateLocation(@Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.locations.update(id, dto);
  }

  @Delete('locations/:id')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.inventoryLocation.delete)
  removeLocation(@Param('id') id: string) {
    return this.locations.remove(id);
  }

  // Bare quantity movements (/stock/receive|issue|adjust|transfer) are
  // intentionally NOT exposed: they bypass document approval and (for receive)
  // the GL. Use direct-stock, stock documents, or procurement instead.

  // ---- Direct Stock In / Out ----

  @Post('direct-stock/in')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventory.move)
  directStockIn(@Body() dto: DirectStockInDto) {
    return this.directStock.directIn(dto);
  }

  @Post('direct-stock/out')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventory.move)
  directStockOut(@Body() dto: DirectStockOutDto) {
    return this.directStock.directOut(dto);
  }

  // ---- Query Endpoints ----

  @Get('items')
  @RequirePermissions(PERMISSIONS.inventory.read)
  listItems(@Query() query: InventoryQueryDto) {
    return this.queries.listItems(query);
  }

  @Get('items/:productId')
  @RequirePermissions(PERMISSIONS.inventory.read)
  itemDetail(@Param('productId') productId: string, @Query('locationId') locationId?: string) {
    return this.queries.getItemDetail(productId, locationId);
  }

  @Get('stats')
  @RequirePermissions(PERMISSIONS.inventory.read)
  stats() {
    return this.queries.getStockStats();
  }

  @Get('product-stock-levels')
  @RequirePermissions(PERMISSIONS.inventory.read)
  productStockLevels(@Query() query: InventoryQueryDto) {
    return this.queries.listProductStockLevels(query);
  }

  @Get('ledger')
  @RequirePermissions(PERMISSIONS.inventory.read)
  ledger(@Query() query: StockLedgerQueryDto) {
    return this.queries.getLedger(query);
  }

  /** One ledger line plus its source transaction — powers the ledger "View" drill-down. */
  @Get('ledger/:id')
  @RequirePermissions(PERMISSIONS.inventory.read)
  ledgerEntry(@Param('id') id: string) {
    return this.ledgerDetail.getEntry(id);
  }

  // ---- F.8 Reports ----

  @Get('reports/expiring')
  @RequirePermissions(PERMISSIONS.inventory.read)
  expiring(@Query() query: ReportScopeQuery & { days?: string }) {
    return this.reports.expiring(query);
  }

  @Get('reports/reorder')
  @RequirePermissions(PERMISSIONS.inventory.read)
  reorder(@Query() query: ReportScopeQuery) {
    return this.reports.reorder(query);
  }

  @Get('reports/movements')
  @RequirePermissions(PERMISSIONS.inventory.read)
  movements(@Query() query: { start?: string; end?: string; locationId?: string }) {
    return this.queries.getMovementSummary(query);
  }

  /**
   * Item movement summary (stock card summary) — per item: opening, in, out,
   * closing qty, inbound/outbound value and closing value over local-day
   * [start, end]. Filters: location, item, category (incl. sub-categories),
   * search, move types, includeIdle, excludeTransfers.
   */
  @Get('reports/item-movements')
  @RequirePermissions(PERMISSIONS.inventory.read)
  itemMovements(@Query() query: ReportScopeQuery & { includeIdle?: string; excludeTransfers?: string }) {
    return this.reports.itemMovements(query);
  }

  /** Current on-hand valuation per item, with stock-status filter and category breakdown. */
  @Get('reports/valuation')
  @RequirePermissions(PERMISSIONS.inventory.read)
  valuation(@Query() query: ReportScopeQuery & { status?: string; includeZero?: string }) {
    return this.reports.valuation(query);
  }

  /** Movement analysis — totals by move type, daily in/out trend, top consumed/lost/received items. */
  @Get('reports/movement-analysis')
  @RequirePermissions(PERMISSIONS.inventory.read)
  movementAnalysis(@Query() query: ReportScopeQuery) {
    return this.reports.movementAnalysis(query);
  }

  /**
   * Movement registers with analytics: stock_in | stock_out | damages |
   * adjustments | transfers. Line register + summary with previous-period
   * comparison, trend, and breakdowns by item/category/location/source/reason/staff.
   */
  @Get('reports/register/:kind')
  @RequirePermissions(PERMISSIONS.inventory.read)
  movementRegister(@Param('kind') kind: string, @Query() query: RegisterQuery) {
    return this.registers.register(kind, query);
  }

  @Get('reports/reconciliation')
  @RequirePermissions(PERMISSIONS.inventory.read)
  reconciliation(
    @Query() query: { locationId?: string; tolerance?: string; includeMatched?: string },
  ) {
    return this.queries.getStockReconciliation({
      locationId: query.locationId,
      tolerance: query.tolerance != null ? Number(query.tolerance) : undefined,
      includeMatched: query.includeMatched === 'true',
    });
  }

  /**
   * Quants sitting at negative on-hand — goods sold before they were received.
   * Sales are never blocked, so this is the operational safety net: until the
   * covering receipt lands, those units were expensed at a stale cost basis and
   * inventory is overstated by `valuationExposure`.
   */
  /**
   * Stock health: aging buckets, turnover, days of cover and slow / dead stock
   * classification per quant (INV-P2-04).
   */
  @Get('reports/stock-health')
  @RequirePermissions(PERMISSIONS.inventory.read)
  stockHealth(@Query() query: ReportScopeQuery & { slowDays?: string; deadDays?: string; status?: string }) {
    return this.reports.stockHealth(query);
  }

  @Get('reports/negative-stock')
  @RequirePermissions(PERMISSIONS.inventory.read)
  negativeStock(@Query() query: ReportScopeQuery) {
    return this.reports.negativeStock(query);
  }

  // ---- F.8 Stock documents: StockOut ----

  @Post('stock-outs')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.create)
  createStockOut(@Body() dto: CreateStockOutDto) {
    return this.stockDocs.createStockOut(dto);
  }

  @Get('stock-outs')
  @RequirePermissions(PERMISSIONS.inventoryDoc.read)
  listStockOuts(@Query('status') status?: string) {
    return this.stockDocs.list('out', status);
  }

  @Post('stock-outs/:id/approve')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.approve)
  approveStockOut(@Param('id') id: string) {
    return this.stockDocs.approveStockOut(id);
  }

  // ---- F.8 Stock documents: Waste ----

  @Post('waste')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.create)
  createWaste(@Body() dto: CreateWasteDto) {
    return this.stockDocs.createWaste(dto);
  }

  @Get('waste')
  @RequirePermissions(PERMISSIONS.inventoryDoc.read)
  listWaste(@Query() query: WasteQueryDto) {
    return this.stockDocs.listWaste(query);
  }

  /** Posted damages & waste totals by category / product / location. Declared before `waste/:id`. */
  @Get('waste/summary')
  @RequirePermissions(PERMISSIONS.inventoryDoc.read)
  wasteSummary(@Query() query: WasteQueryDto) {
    return this.stockDocs.wasteSummary(query);
  }

  @Get('waste/:id')
  @RequirePermissions(PERMISSIONS.inventoryDoc.read)
  getWaste(@Param('id') id: string) {
    return this.stockDocs.getWaste(id);
  }

  @Post('waste/:id/approve')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.approve)
  approveWaste(@Param('id') id: string) {
    return this.stockDocs.approveWaste(id);
  }

  @Post('waste/:id/cancel')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.approve)
  cancelWaste(@Param('id') id: string) {
    return this.stockDocs.cancelWaste(id);
  }

  // ---- F.8 Stock documents: Adjustment ----

  @Post('adjustments')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.create)
  createAdjustment(@Body() dto: CreateStockAdjustmentDto) {
    return this.stockDocs.createAdjustment(dto);
  }

  @Get('adjustments')
  @RequirePermissions(PERMISSIONS.inventoryDoc.read)
  listAdjustments(@Query('status') status?: string) {
    return this.stockDocs.list('adjustment', status);
  }

  @Post('adjustments/:id/approve')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.approve)
  approveAdjustment(@Param('id') id: string, @Body() dto: ApproveAdjustmentDto) {
    return this.stockDocs.approveAdjustment(id, undefined, dto ?? {});
  }

  @Post('adjustments/:id/cancel')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.approve)
  cancelAdjustment(@Param('id') id: string) {
    return this.stockDocs.cancelAdjustment(id);
  }

  // ---- F.8 Stock documents: Transfer ----

  @Post('transfers')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.create)
  createTransfer(@Body() dto: CreateStockTransferDto) {
    return this.stockDocs.createTransfer(dto);
  }

  @Get('transfers')
  @RequirePermissions(PERMISSIONS.inventoryDoc.read)
  listTransfers(@Query('status') status?: string) {
    return this.stockDocs.list('transfer', status);
  }

  @Post('transfers/:id/approve')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.approve)
  approveTransfer(@Param('id') id: string) {
    return this.stockDocs.approveTransfer(id);
  }

  @Get('transfers/:id')
  @RequirePermissions(PERMISSIONS.inventoryDoc.read)
  getTransfer(@Param('id') id: string) {
    return this.stockDocs.getTransfer(id);
  }

  /** Transit transfers: stock leaves the source into the transit location. */
  @Post('transfers/:id/dispatch')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.update)
  dispatchTransfer(@Param('id') id: string) {
    return this.stockDocs.dispatchTransfer(id);
  }

  /** Transit transfers: destination receipt with optional damage / shortage split. */
  @Post('transfers/:id/receive')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.update)
  receiveTransfer(@Param('id') id: string, @Body() dto: ReceiveStockTransferDto) {
    return this.stockDocs.receiveTransfer(id, dto);
  }

  /** Transit transfers: return everything still in transit to the source. */
  @Post('transfers/:id/recall')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.approve)
  recallTransfer(@Param('id') id: string, @Body() dto: ReverseStockDocDto) {
    return this.stockDocs.recallTransfer(id, dto.reason);
  }

  @Post('transfers/:id/cancel')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.approve)
  cancelTransfer(@Param('id') id: string) {
    return this.stockDocs.cancelTransfer(id);
  }

  // ---- Posted reversals (linked inverse movements + mirrored journals) ----

  @Post('stock-outs/:id/reverse')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.approve)
  reverseStockOut(@Param('id') id: string, @Body() dto: ReverseStockDocDto) {
    return this.reversals.reverseDocument('stock_out', id, dto.reason);
  }

  @Post('waste/:id/reverse')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.approve)
  reverseWaste(@Param('id') id: string, @Body() dto: ReverseStockDocDto) {
    return this.reversals.reverseDocument('waste', id, dto.reason);
  }

  @Post('adjustments/:id/reverse')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.approve)
  reverseAdjustment(@Param('id') id: string, @Body() dto: ReverseStockDocDto) {
    return this.reversals.reverseDocument('stock_adjustment', id, dto.reason);
  }

  @Post('transfers/:id/reverse')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.inventoryDoc.approve)
  reverseTransfer(@Param('id') id: string, @Body() dto: ReverseStockDocDto) {
    return this.reversals.reverseDocument('stock_transfer', id, dto.reason);
  }
}
