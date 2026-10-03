import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { TerminalGuard } from '../guards/terminal.guard';
import { OperatorGuard } from '../operators/operator.guard';
import { getContext } from '../../common/context/request-context';
import { StockService } from '../../portal/stock/stock.service';
import { ApprovalService } from '../operators/approval.service';
import { PosAdjustStockDto } from './pos-adjust-stock.dto';

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
  constructor(
    private readonly stock: StockService,
    private readonly approvals: ApprovalService,
  ) {}

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
  @UseGuards(OperatorGuard)
  async adjust(@Body() dto: PosAdjustStockDto): Promise<PosStockLevel> {
    const ctx = getContext();
    const approvedBy = await this.approvals.authorize(
      'terminal_stock_adjust',
      undefined,
      dto.approval,
    );
    const res = await this.stock.adjust(ctx.branchId!, dto, approvedBy);
    return { productId: res.productId, variantId: res.variantId, qty: res.qty };
  }
}
