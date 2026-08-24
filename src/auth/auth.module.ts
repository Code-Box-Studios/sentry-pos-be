import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TotpService } from './totp.service';
import { AuditService } from './audit.service';
import { JwtStrategy } from './jwt.strategy';
import { PortalAuthGuard } from './guards/portal-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { PreauthGuard } from './guards/preauth.guard';
import { LockoutModule } from '../common/lockout/lockout.module';

/**
 * Auth module (Tasks 7 + 8). All auth paths use the RAW PrismaService (global,
 * pre-scope). JwtModule is registered empty because each sign() call passes its
 * own secret (access vs preauth share JWT_ACCESS_SECRET). Guards + strategy are
 * exported so downstream feature modules (Tasks 9+) can protect their routes.
 */
@Module({
  imports: [PassportModule, JwtModule.register({}), LockoutModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    TotpService,
    AuditService,
    JwtStrategy,
    PortalAuthGuard,
    AdminGuard,
    PreauthGuard,
  ],
  exports: [
    AuthService,
    TotpService,
    AuditService,
    PortalAuthGuard,
    AdminGuard,
    PreauthGuard,
  ],
})
export class AuthModule {}
