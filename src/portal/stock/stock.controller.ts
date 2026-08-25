import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PortalAuthGuard } from '../../auth/guards/portal-auth.guard';
import { StockService, MovementResponse, StockLevel } from './stock.service';
import { ReceiveDto } from './dto/receive.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';

/**
 * Task 15 — portal stock, gated by `PortalAuthGuard` (tenant scope).
 * `POST /v1/portal/branches/:branchId/stock/receive`,
 * `POST /v1/portal/branches/:branchId/stock/adjustments`,
 * `GET  /v1/portal/branches/:branchId/stock`.
 */
@Controller('portal/branches/:branchId/stock')
@UseGuards(PortalAuthGuard)
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

  @Get()
  levels(
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): Promise<StockLevel[]> {
    return this.stock.levels(branchId);
  }
}
