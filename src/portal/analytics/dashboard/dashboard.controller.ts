import { Controller, Get, UseGuards } from '@nestjs/common';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { DashboardService, type DashboardReport } from './dashboard.service';

/**
 * The portal landing (analytics-spec §0). `GET /v1/portal/dashboard`.
 *
 * No query parameters: it spans every non-demo business and ignores the
 * business switcher. No CSV either — this is a glanceable summary, and every
 * card taps through to a report that does export.
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  get(): Promise<DashboardReport> {
    return this.dashboard.run(new Date());
  }
}
