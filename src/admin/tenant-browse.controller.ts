import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuditLog, Branch, Business } from '@prisma/client';
import { AdminGuard } from '../auth/guards/admin.guard';
import { TenantBrowseService } from './tenant-browse.service';
import { Paginated } from '../common/types/pagination';
import { ActivityLogQueryDto } from './dto/activity-log-query.dto';

/**
 * Task 10 — read-only platform browse of tenant data, gated by `AdminGuard`
 * (platform scope). Routes: `GET /v1/admin/owners/:id/businesses`,
 * `GET /v1/admin/businesses/:id/branches`,
 * `GET /v1/admin/businesses/:id/activity-log`.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class TenantBrowseController {
  constructor(private readonly browse: TenantBrowseService) {}

  @Get('owners/:id/businesses')
  businesses(@Param('id', ParseUUIDPipe) id: string): Promise<Business[]> {
    return this.browse.businesses(id);
  }

  @Get('businesses/:id/branches')
  branches(@Param('id', ParseUUIDPipe) id: string): Promise<Branch[]> {
    return this.browse.branches(id);
  }

  @Get('businesses/:id/activity-log')
  activityLog(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ActivityLogQueryDto,
  ): Promise<Paginated<AuditLog>> {
    return this.browse.activityLog(id, query);
  }
}
