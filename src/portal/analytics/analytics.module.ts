import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AnalyticsScopeService } from './scope/analytics-scope.service';
import { ReportAuditService } from './report-audit.service';
import { OverviewController } from './overview/overview.controller';
import { OverviewService } from './overview/overview.service';
import { SalesReportController } from './sales/sales-report.controller';
import { SalesReportService } from './sales/sales-report.service';

/**
 * Analytics (tenant scope) — `analytics-spec.md`. Controllers arrive one report
 * family at a time; the shared providers below are what they all stand on.
 *
 * Imports `AuthModule` for `PortalAuthGuard`. `PrismaService` (raw, for the
 * report SQL) and `SCOPED_PRISMA` (for scope resolution) come from the global
 * `PrismaModule`.
 */
@Module({
  imports: [AuthModule],
  controllers: [OverviewController, SalesReportController],
  providers: [
    AnalyticsScopeService,
    ReportAuditService,
    OverviewService,
    SalesReportService,
  ],
})
export class AnalyticsModule {}
