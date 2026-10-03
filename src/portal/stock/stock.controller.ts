import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { PortalAuthGuard } from '../../auth/guards/portal-auth.guard';
import { StockService, MovementResponse, StockLevel } from './stock.service';
import {
  TransferDto,
  CreateCountDto,
  UpdateCountDto,
} from './dto/inventory.dto';
import { ReceiveDto } from './dto/receive.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { ManagerAccess } from '../../staff/portal-scope';

/**
 * Task 15 — portal stock, gated by `PortalAuthGuard` (tenant scope).
 * `POST /v1/portal/branches/:branchId/stock/receive`,
 * `POST /v1/portal/branches/:branchId/stock/adjustments`,
 * `GET  /v1/portal/branches/:branchId/stock`.
 */
@Controller('portal/branches/:branchId/stock')
@UseGuards(PortalAuthGuard)
@ManagerAccess({ action: 'portal_stock', branchParam: 'branchId' })
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Post('receive')
  receive(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: ReceiveDto,
  ): Promise<{ operationId: string; movements: MovementResponse[] }> {
    return this.stock.receive(branchId, dto);
  }

  @Post('adjustments')
  adjust(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: AdjustStockDto,
  ): Promise<{
    productId: string;
    variantId: string | null;
    qty: number;
    movement: MovementResponse;
  }> {
    return this.stock.adjust(branchId, dto);
  }

  @Post('transfers')
  transfer(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: TransferDto,
  ) {
    return this.stock.transfer(branchId, dto);
  }
  @Get('transfers')
  transfers(@Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.stock.transfers(branchId);
  }
  @Post('counts')
  createCount(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateCountDto,
  ) {
    return this.stock.createCount(branchId, dto);
  }
  @Get('counts')
  counts(@Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.stock.counts(branchId);
  }
  @Get('counts/:countId')
  count(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('countId', ParseUUIDPipe) id: string,
  ) {
    return this.stock.count(branchId, id);
  }
  @Put('counts/:countId')
  updateCount(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('countId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCountDto,
  ) {
    return this.stock.updateCount(branchId, id, dto);
  }
  @Post('counts/:countId/post')
  postCount(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('countId', ParseUUIDPipe) id: string,
  ) {
    return this.stock.postCount(branchId, id);
  }
  @Get('expiry')
  expiry(@Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.stock.expiry(branchId);
  }

  @Get()
  levels(
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): Promise<StockLevel[]> {
    return this.stock.levels(branchId);
  }
}
