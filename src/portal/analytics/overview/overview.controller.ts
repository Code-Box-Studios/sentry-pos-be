import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { renderReport } from '../report-response';
import { OverviewService, type OverviewReport } from './overview.service';
import { overviewCsv } from './overview.csv';

/**
 * Overview KPIs (analytics-spec §1). `GET /v1/portal/analytics/overview`.
 *
 * `passthrough: true` keeps Nest's serialisation and the global exception
 * filter in play; `renderReport` only sets headers when CSV was asked for.
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get('analytics/overview')
  async get(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OverviewReport | string> {
    const report = await this.overview.run(query);
    return renderReport(res, 'overview', query, report, overviewCsv);
  }
}
