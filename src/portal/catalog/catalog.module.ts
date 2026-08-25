import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { ModifierGroupsController } from './modifier-groups.controller';
import { ModifierGroupsService } from './modifier-groups.service';

/**
 * Catalog feature module (tenant scope): categories, products + variants, and
 * modifier groups + product↔group links. Split out of PortalModule (Task 14) to
 * keep the portal surface organized as it grows. `AuthModule` provides
 * `PortalAuthGuard`; the global `PrismaModule` provides raw + scoped clients.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    CategoriesController,
    ProductsController,
    ModifierGroupsController,
  ],
  providers: [CategoriesService, ProductsService, ModifierGroupsService],
})
export class CatalogModule {}
