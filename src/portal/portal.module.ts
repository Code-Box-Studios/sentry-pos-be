import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { StockModule } from './stock/stock.module';
import { BusinessesController } from './businesses/businesses.controller';
import { BusinessesService } from './businesses/businesses.service';
import { BranchesController } from './branches/branches.controller';
import { BranchesService } from './branches/branches.service';
import { DiscountsController } from './discounts/discounts.controller';
import { DiscountsService } from './discounts/discounts.service';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { ActivityLogController } from './activity-log/activity-log.controller';
import { ActivityLogService } from './activity-log/activity-log.service';
import { TerminalsController } from './terminals/terminals.controller';
import { TerminalsService } from './terminals/terminals.service';

/**
 * Portal module (tenant scope). Task 11 — businesses + branches; Task 13 —
 * discounts; Task 14 — settings (refund PIN), activity log, terminals. The
 * catalog features (categories/products/modifiers, built in Tasks 12/13) now
 * live in `CatalogModule`, imported here.
 *
 * Imports `AuthModule` for `PortalAuthGuard` and `CatalogModule` for the catalog
 * routes. `PrismaService` (raw) and `SCOPED_PRISMA` (tenant scope) come from the
 * global `PrismaModule`.
 */
@Module({
  imports: [AuthModule, CatalogModule, StockModule],
  controllers: [
    BusinessesController,
    BranchesController,
    DiscountsController,
    SettingsController,
    ActivityLogController,
    TerminalsController,
  ],
  providers: [
    BusinessesService,
    BranchesService,
    DiscountsService,
    SettingsService,
    ActivityLogService,
    TerminalsService,
  ],
})
export class PortalModule {}
