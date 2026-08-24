import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService, LoginResult } from './auth.service';
import { TotpService } from './totp.service';
import { InviteService } from './invite.service';
import { LockoutService } from '../common/lockout/lockout.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { TotpEnableDto } from './dto/totp-enable.dto';
import { TotpVerifyDto } from './dto/totp-verify.dto';
import { InviteAcceptDto } from './dto/invite-accept.dto';
import { PasswordResetRequestDto } from './dto/password-reset-request.dto';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.dto';
import { PreauthGuard, PreauthPayload } from './guards/preauth.guard';
import {
  UnauthorizedError,
  TotpInvalidError,
} from '../common/errors/api-errors';

interface RequestWithPreauth {
  preauthUser: PreauthPayload;
}

@Controller('auth')
export class AuthController {
  private readonly accessSecret: string;

  constructor(
    private readonly auth: AuthService,
    private readonly totp: TotpService,
    private readonly invites: InviteService,
    private readonly lockout: LockoutService,
    private readonly raw: PrismaService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.accessSecret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  // ---------------------------------------------------------------------------
  // Password auth
  // ---------------------------------------------------------------------------

  @Post('login')
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto.email, dto.password);
  }

  @Post('refresh')
  refresh(
    @Body() dto: RefreshDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() dto: RefreshDto): Promise<{ ok: true }> {
    await this.auth.logout(dto.refreshToken);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Invite acceptance (Task 9)
  // ---------------------------------------------------------------------------

  /**
   * Accept an invite: verify the single-use token, set the user's password,
   * activate the owner, and seed the demo business. Invalid/expired/used tokens
   * collapse to a generic 400 `invalid_token`.
   */
  @Post('invite/accept')
  async acceptInvite(@Body() dto: InviteAcceptDto): Promise<{ ok: true }> {
    await this.invites.acceptInvite(dto.token, dto.password);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Password reset (Task 9)
  // ---------------------------------------------------------------------------

  /**
   * Request a password reset. ALWAYS returns 204 — never reveals whether the
   * email exists (no user enumeration). A token + email are produced only when
   * the account actually exists.
   */
  @Post('password-reset/request')
  @HttpCode(HttpStatus.NO_CONTENT)
  async requestPasswordReset(
    @Body() dto: PasswordResetRequestDto,
  ): Promise<void> {
    await this.invites.requestReset(dto.email);
  }

  /**
   * Confirm a password reset: verify the single-use token, set the new password,
   * and revoke ALL of the user's refresh tokens. Returns 204 on success.
   */
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmPasswordReset(
    @Body() dto: PasswordResetConfirmDto,
  ): Promise<void> {
    await this.invites.confirmReset(dto.token, dto.password);
  }

  // ---------------------------------------------------------------------------
  // TOTP: setup (store pending secret)
  // ---------------------------------------------------------------------------

  /**
   * Accepts ONLY preauth tokens (via PreauthGuard). Returns otpauth URI + raw
   * secret for QR display. Stores secret as PENDING so Task 7's login contract
   * (totpSecret == null → setupRequired) is not broken until enable succeeds.
   */
  @Post('totp/setup')
  @UseGuards(PreauthGuard)
  setup(
    @Req() req: RequestWithPreauth,
  ): Promise<{ secret: string; otpauthUri: string }> {
    return this.totp.generateSetup(req.preauthUser.sub);
  }

  // ---------------------------------------------------------------------------
  // TOTP: enable (activate after user scans QR and confirms a code)
  // ---------------------------------------------------------------------------

  /**
   * Accepts ONLY preauth tokens (via PreauthGuard). Verifies the provided TOTP
   * code against the pending secret, then moves pending → active and generates
   * 8 one-time recovery codes returned ONCE in plaintext.
   */
  @Post('totp/enable')
  @UseGuards(PreauthGuard)
  enable(
    @Req() req: RequestWithPreauth,
    @Body() dto: TotpEnableDto,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.totp.enableTotp(req.preauthUser.sub, dto.code);
  }

  // ---------------------------------------------------------------------------
  // TOTP: verify (exchange preauth + TOTP/recovery code for full token pair)
  // ---------------------------------------------------------------------------

  /**
   * Does NOT use PreauthGuard (token is in the body, not the Authorization
   * header). Manually verifies the JWT, enforces kind:"preauth", then verifies
   * the TOTP or recovery code. On success, mints a full access/refresh token
   * pair. Failed TOTP attempts count toward the login lockout.
   */
  @Post('totp/verify')
  async verify(
    @Body() dto: TotpVerifyDto,
  ): Promise<{ accessToken: string; refreshToken: string; role: string }> {
    // Manually verify the preauth JWT from the body
    let payload: { sub: string; kind?: string };
    try {
      payload = this.jwt.verify<{ sub: string; kind?: string }>(
        dto.preAuthToken,
        { secret: this.accessSecret },
      );
    } catch {
      throw new UnauthorizedError('Invalid or expired pre-auth token.');
    }

    if (payload.kind !== 'preauth') {
      throw new UnauthorizedError('Pre-auth token required.');
    }

    const userId = payload.sub;

    // Fetch user to get role and check lockout
    const user = await this.raw.user.findUniqueOrThrow({
      where: { id: userId },
    });

    // Check lockout before attempting TOTP verification
    this.lockout.assertNotLocked(user, 'login');

    // Attempt TOTP / recovery code verification
    try {
      await this.totp.verifyTotp(userId, dto.code);
    } catch {
      // Update the lockout counter (recordFailure always throws LoginInvalidError;
      // we swallow it and throw TotpInvalidError so the client gets the stable code).
      try {
        await this.lockout.recordFailure(userId, 'login');
      } catch {
        // Swallow LoginInvalidError / LoginLockedError — the DB counter was updated.
        // The next login() call will check assertNotLocked() and enforce the lock.
      }
      throw new TotpInvalidError();
    }

    // Success — reset lockout counter
    await this.lockout.recordSuccess(userId, 'login');

    // Mint full token pair
    const { accessToken, refreshToken } = await this.auth.mintTokenPair(
      userId,
      user.role,
    );

    return { accessToken, refreshToken, role: user.role };
  }
}
