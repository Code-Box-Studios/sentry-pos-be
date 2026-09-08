import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { ProductReportQueryDto } from '../dto/product-report-query.dto';
import { renderReport } from '../report-response';
import { slowProductsCsv, topProductsCsv } from './products-report.csv';
import {
  ProductsReportService,
  type SlowProductsReport,
  type TopProductsReport,
} from './products-report.service';

/** §3 Products sold — `GET /v1/portal/analytics/products/{top,slow}`. */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class ProductsReportController {
  constructor(private readonly products: ProductsReportService) {}

  @Get('analytics/products/top')
  async top(
    @Query() query: ProductReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TopProductsReport | string> {
    const report = await this.products.top(query);
    return renderReport(res, 'products-top', query, report, topProductsCsv);
  }

  @Get('analytics/products/slow')
  async slow(
    @Query() query: ProductReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SlowProductsReport | string> {
    const report = await this.products.slow(query);
    return renderReport(res, 'products-slow', query, report, slowProductsCsv);
  }
}
