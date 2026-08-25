import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OwnersController } from './owners.controller';
import { OwnersService } from './owners.service';
import { TenantBrowseController } from './tenant-browse.controller';
import { TenantBrowseService } from './tenant-browse.service';

/**
 * Task 10 — platform-admin module (owner provisioning + two-tier suspension +
 * audited read-only tenant browse).
 *
 * Imports `AuthModule` for `AdminGuard`, `InviteService`, and `AuditService`.
 * `PrismaService` (raw, for platform-model writes) and `SCOPED_PRISMA` (platform
 * scope, for the read-only browse) come from the global `PrismaModule`; the mail
 * transport comes from the global `MailModule` (via `InviteService`).
 */
@Module({
  imports: [AuthModule],
  controllers: [OwnersController, TenantBrowseController],
  providers: [OwnersService, TenantBrowseService],
})
export class AdminModule {}
