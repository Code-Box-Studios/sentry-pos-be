import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { SalesTrendQueryDto } from '../dto/sales-trend-query.dto';
import { renderReport } from '../report-response';
import { leaksCsv, profitCsv } from './profit-report.csv';
import {
  ProfitReportService,
  type ProfitReport,
} from './profit-report.service';
import { LeaksReportService, type LeaksReport } from './leaks-report.service';

/**
 * §4 Profit & leaks —
 * `GET /v1/portal/analytics/profit` and `GET /v1/portal/analytics/leaks`.
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class ProfitReportController {
  constructor(
    private readonly profit: ProfitReportService,
    private readonly leaks: LeaksReportService,
  ) {}

  @Get('analytics/profit')
  async get(
    @Query() query: SalesTrendQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProfitReport | string> {
    const report = await this.profit.run(query);
    return renderReport(res, 'profit', query, report, profitCsv);
  }

  @Get('analytics/leaks')
  async getLeaks(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeaksReport | string> {
    const report = await this.leaks.run(query);
    return renderReport(res, 'leaks', query, report, leaksCsv);
  }
}
