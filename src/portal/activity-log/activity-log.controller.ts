import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuditLog } from '@prisma/client';
import { PortalAuthGuard } from '../../auth/guards/portal-auth.guard';
import { ActivityLogService } from './activity-log.service';
import { Paginated } from '../../common/types/pagination';
import { ActivityLogQueryDto } from './dto/activity-log-query.dto';

/**
 * Task 14 — BO activity log, gated by `PortalAuthGuard` (tenant scope).
 * `GET /v1/portal/businesses/:businessId/activity-log` (paginated).
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class ActivityLogController {
  constructor(private readonly activityLog: ActivityLogService) {}

  @Get('businesses/:businessId/activity-log')
  list(
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Query() query: ActivityLogQueryDto,
  ): Promise<Paginated<AuditLog>> {
    return this.activityLog.list(businessId, query);
  }
}
