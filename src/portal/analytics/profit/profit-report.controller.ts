import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { SalesTrendQueryDto } from '../dto/sales-trend-query.dto';
import { renderReport } from '../report-response';
import { profitCsv } from './profit-report.csv';
import {
  ProfitReportService,
  type ProfitReport,
} from './profit-report.service';

/** §4 Profit — `GET /v1/portal/analytics/profit`. */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class ProfitReportController {
  constructor(private readonly profit: ProfitReportService) {}

  @Get('analytics/profit')
  async get(
    @Query() query: SalesTrendQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProfitReport | string> {
    const report = await this.profit.run(query);
    return renderReport(res, 'profit', query, report, profitCsv);
  }
}
