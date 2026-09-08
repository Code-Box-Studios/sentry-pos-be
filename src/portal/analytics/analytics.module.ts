import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AnalyticsScopeService } from './scope/analytics-scope.service';
import { ReportAuditService } from './report-audit.service';
import { OverviewController } from './overview/overview.controller';
import { OverviewService } from './overview/overview.service';
import { SalesReportController } from './sales/sales-report.controller';
import { SalesReportService } from './sales/sales-report.service';
import { TaxReportController } from './tax/tax-report.controller';
import { TaxReportService } from './tax/tax-report.service';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { ProductsReportController } from './products/products-report.controller';
import { ProductsReportService } from './products/products-report.service';
import { ProfitReportController } from './profit/profit-report.controller';
import { ProfitReportService } from './profit/profit-report.service';

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
  controllers: [
    DashboardController,
    OverviewController,
    SalesReportController,
    TaxReportController,
    ProductsReportController,
    ProfitReportController,
  ],
  providers: [
    AnalyticsScopeService,
    ReportAuditService,
    OverviewService,
    SalesReportService,
    TaxReportService,
    DashboardService,
    ProductsReportService,
    ProfitReportService,
  ],
})
export class AnalyticsModule {}
