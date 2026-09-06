import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { renderReport } from '../report-response';
import { TaxReportService, type TaxReport } from './tax-report.service';
import { taxCsv } from './tax-report.csv';

/** Tax summary (analytics-spec §6). `GET /v1/portal/analytics/tax`. */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class TaxReportController {
  constructor(private readonly tax: TaxReportService) {}

  @Get('analytics/tax')
  async get(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaxReport | string> {
    return renderReport(res, 'tax', query, await this.tax.run(query), taxCsv);
  }
}
