import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { TerminalGuard } from '../guards/terminal.guard';
import {
  SalesService,
  type CompletedSale,
  type SaleSummary,
} from './sales.service';
import { SaleDraftDto } from './dto/sale-draft.dto';
import { ListSalesQueryDto } from './dto/list-sales-query.dto';

/**
 * Task 19 — POS sales (all TerminalGuard). `completeSale` is idempotent: a first
 * insert responds 201, a replay of the same draft responds 200 with the stored
 * sale. Both `listSales` and `getSale` assemble responses from the persisted
 * draft snapshot (never rebuilt from current product/discount rows).
 */
@Controller('pos/sales')
@UseGuards(TerminalGuard)
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Post()
  async completeSale(
    @Body() dto: SaleDraftDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CompletedSale> {
    const { replayed, sale } = await this.sales.completeSale(dto);
    res.status(replayed ? 200 : 201);
    return sale;
  }

  @Get()
  listSales(@Query() query: ListSalesQueryDto): Promise<SaleSummary[]> {
    return this.sales.listSales(query.date ?? null);
  }

  @Get(':id')
  getSale(@Param('id') id: string): Promise<CompletedSale> {
    return this.sales.getSale(id);
  }
}
