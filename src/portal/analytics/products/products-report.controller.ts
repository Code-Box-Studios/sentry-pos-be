import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { ProductReportQueryDto } from '../dto/product-report-query.dto';
import { SalesTrendQueryDto } from '../dto/sales-trend-query.dto';
import { renderReport } from '../report-response';
import {
  productTrendCsv,
  slowProductsCsv,
  topProductsCsv,
} from './products-report.csv';
import {
  ProductsReportService,
  type ProductTrendReport,
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

  @Get('analytics/products/:productId/trend')
  async trend(
    // ParseUUIDPipe defaults to 400; this codebase renders every validation
    // failure as 422, so the status is set explicitly.
    @Param(
      'productId',
      new ParseUUIDPipe({
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    )
    productId: string,
    @Query() query: SalesTrendQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductTrendReport | string> {
    const report = await this.products.trend(productId, query);
    return renderReport(res, 'product-trend', query, report, productTrendCsv);
  }
}
