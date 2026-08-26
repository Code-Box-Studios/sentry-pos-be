import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { TerminalGuard } from '../guards/terminal.guard';
import { getContext } from '../../common/context/request-context';
import { StockService } from '../../portal/stock/stock.service';
import { AdjustStockDto } from '../../portal/stock/dto/adjust-stock.dto';

/** FE `StockLevel` — the POS projection of a branch stock row (qty as a number). */
export interface PosStockLevel {
  productId: string;
  variantId: string | null;
  qty: number;
}

/**
 * Task 21 — POS stock read + adjust (TerminalGuard). Both delegate to the shared
 * `StockService` (the same movement + audit path as the portal), scoped to the
 * terminal's branch, projected to the FE `StockLevel` shape.
 */
@Controller('pos/stock')
@UseGuards(TerminalGuard)
export class PosStockController {
  constructor(private readonly stock: StockService) {}

  @Get()
  async getStock(): Promise<PosStockLevel[]> {
    const ctx = getContext();
    const levels = await this.stock.levels(ctx.branchId!);
    return levels.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      qty: l.qty,
    }));
  }

  @Post('adjustments')
  async adjust(@Body() dto: AdjustStockDto): Promise<PosStockLevel> {
    const ctx = getContext();
    const res = await this.stock.adjust(ctx.branchId!, dto);
    return { productId: res.productId, variantId: res.variantId, qty: res.qty };
  }
}
