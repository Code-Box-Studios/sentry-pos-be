import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BusinessesController } from './businesses/businesses.controller';
import { BusinessesService } from './businesses/businesses.service';
import { BranchesController } from './branches/branches.controller';
import { BranchesService } from './branches/branches.service';
import { CategoriesController } from './catalog/categories.controller';
import { CategoriesService } from './catalog/categories.service';
import { ProductsController } from './catalog/products.controller';
import { ProductsService } from './catalog/products.service';

/**
 * Portal module (tenant scope). Task 11 — businesses + branches; Task 12 —
 * catalog (categories, products + variants).
 *
 * Imports `AuthModule` for `PortalAuthGuard`. `PrismaService` (raw, for the
 * platform-model maxBusinesses read + sales-history checks) and `SCOPED_PRISMA`
 * (tenant scope, for all CRUD) come from the global `PrismaModule`.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    BusinessesController,
    BranchesController,
    CategoriesController,
    ProductsController,
  ],
  providers: [
    BusinessesService,
    BranchesService,
    CategoriesService,
    ProductsService,
  ],
})
export class PortalModule {}
