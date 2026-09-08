import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import type { Paginated } from '../../../common/types/pagination';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { MovementsQueryDto } from '../dto/movements-query.dto';
import { renderReport } from '../report-response';
import { movementsCsv, onHandCsv, shrinkageCsv } from './inventory-report.csv';
import {
  InventoryReportService,
  type Movement,
  type OnHandReport,
  type ShrinkageReport,
} from './inventory-report.service';

/**
 * §5 Inventory —
 * `GET /v1/portal/analytics/inventory/{movements,shrinkage,on-hand}`.
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class InventoryReportController {
  constructor(private readonly inventory: InventoryReportService) {}

  @Get('analytics/inventory/movements')
  async movements(
    @Query() query: MovementsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Paginated<Movement> | string> {
    const report = await this.inventory.movements(query);
    return renderReport(
      res,
      'inventory-movements',
      query,
      report,
      movementsCsv,
    );
  }

  @Get('analytics/inventory/shrinkage')
  async shrinkage(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ShrinkageReport | string> {
    const report = await this.inventory.shrinkage(query);
    return renderReport(
      res,
      'inventory-shrinkage',
      query,
      report,
      shrinkageCsv,
    );
  }

  @Get('analytics/inventory/on-hand')
  async onHand(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OnHandReport | string> {
    const report = await this.inventory.onHand(query);
    return renderReport(res, 'inventory-on-hand', query, report, onHandCsv);
  }
}
