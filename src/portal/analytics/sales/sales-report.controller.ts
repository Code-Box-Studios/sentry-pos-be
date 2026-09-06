import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { SalesTrendQueryDto } from '../dto/sales-trend-query.dto';
import { renderReport } from '../report-response';
import {
  SalesReportService,
  type BreakdownsReport,
  type HeatmapDay,
  type PatternsReport,
  type TrendBucket,
} from './sales-report.service';
import {
  breakdownsCsv,
  heatmapCsv,
  patternsCsv,
  trendCsv,
} from './sales-report.csv';

/** Sales reports (analytics-spec §2) under `/v1/portal/analytics/sales/*`. */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class SalesReportController {
  constructor(private readonly sales: SalesReportService) {}

  @Get('analytics/sales/heatmap')
  async heatmap(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HeatmapDay[] | string> {
    return renderReport(
      res,
      'sales-heatmap',
      query,
      await this.sales.heatmap(query),
      heatmapCsv,
    );
  }

  @Get('analytics/sales/trend')
  async trend(
    @Query() query: SalesTrendQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TrendBucket[] | string> {
    return renderReport(
      res,
      'sales-trend',
      query,
      await this.sales.trend(query),
      trendCsv,
    );
  }

  @Get('analytics/sales/patterns')
  async patterns(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PatternsReport | string> {
    return renderReport(
      res,
      'sales-patterns',
      query,
      await this.sales.patterns(query),
      patternsCsv,
    );
  }

  @Get('analytics/sales/breakdowns')
  async breakdowns(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BreakdownsReport | string> {
    return renderReport(
      res,
      'sales-breakdowns',
      query,
      await this.sales.breakdowns(query),
      breakdownsCsv,
    );
  }
}
