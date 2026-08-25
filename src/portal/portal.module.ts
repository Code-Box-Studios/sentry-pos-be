import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BusinessesController } from './businesses/businesses.controller';
import { BusinessesService } from './businesses/businesses.service';
import { BranchesController } from './branches/branches.controller';
import { BranchesService } from './branches/branches.service';

/**
 * Task 11 — portal module (business + branch CRUD, tenant scope).
 *
 * Imports `AuthModule` for `PortalAuthGuard`. `PrismaService` (raw, for the
 * platform-model maxBusinesses read) and `SCOPED_PRISMA` (tenant scope, for all
 * CRUD) come from the global `PrismaModule`.
 */
@Module({
  imports: [AuthModule],
  controllers: [BusinessesController, BranchesController],
  providers: [BusinessesService, BranchesService],
})
export class PortalModule {}
