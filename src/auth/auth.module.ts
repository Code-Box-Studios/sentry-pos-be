import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuditService } from './audit.service';
import { JwtStrategy } from './jwt.strategy';
import { PortalAuthGuard } from './guards/portal-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { LockoutModule } from '../common/lockout/lockout.module';

/**
 * Task 7 — the auth module. All auth paths use the RAW PrismaService (global,
 * pre-scope). JwtModule is registered empty because each sign() call passes its
 * own secret (access vs preauth share JWT_ACCESS_SECRET). Guards + strategy are
 * exported so downstream feature modules (Tasks 8+) can protect their routes.
 */
@Module({
  imports: [PassportModule, JwtModule.register({}), LockoutModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuditService,
    JwtStrategy,
    PortalAuthGuard,
    AdminGuard,
  ],
  exports: [AuthService, AuditService, PortalAuthGuard, AdminGuard],
})
export class AuthModule {}
