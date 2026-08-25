import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { OwnerStatus, Owner, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LockoutService } from '../common/lockout/lockout.service';
import { AuditService } from './audit.service';
import { verifySecret } from './hashing';
import {
  LoginInvalidError,
  UnauthorizedError,
  OwnerSuspendedError,
  ForbiddenError,
} from '../common/errors/api-errors';

const ACCESS_TTL = '15m';
const PREAUTH_TTL = '5m';
const PAIRING_TTL = '10m';
const REFRESH_TTL_DAYS = 30;

const SUSPENDED_STATUSES: ReadonlySet<OwnerStatus> = new Set<OwnerStatus>([
  OwnerStatus.suspended,
  OwnerStatus.hard_suspended,
  OwnerStatus.closed,
]);

/**
 * Constant-work decoy hash for timing-attack resistance.
 *
 * A real user with a set password runs a full argon2 verify on every wrong
 * password. The unknown-email and null-`passwordHash` (pre-activation) branches
 * have no hash to verify against, so returning early there would make those
 * responses measurably faster — a timing side channel that reveals whether an
 * email exists / is activated. We instead run an argon2 verify against this
 * fixed decoy hash on those branches so all three failure paths perform
 * equivalent crypto before returning `login_invalid`. The decoy is a precomputed
 * argon2id hash of a random string (matching `hashSecret`'s params); it never
 * matches any real password.
 */
const DECOY_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$oC3OkBIibBISXXAxDB2G5w$bn2Bi+j0YAUYmt3P6ODBbpWhBhrhH/5mAubxROX/ZWM';

export type LoginResult =
  | { accessToken: string; refreshToken: string; role: 'owner' }
  | { totpRequired: true; preAuthToken: string }
  | { totpSetupRequired: true; preAuthToken: string };

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

@Injectable()
export class AuthService {
  private readonly accessSecret: string;

  constructor(
    private readonly raw: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly lockout: LockoutService,
    private readonly audit: AuditService,
  ) {
    this.accessSecret = this.config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.raw.user.findUnique({ where: { email } });

    // Unknown email: fail like a wrong password, but there is no user row to
    // track lockout against, so we simply return the invalid error. This keeps
    // the response indistinguishable in shape from a genuine wrong password.
    // Run a constant-work decoy verify first so this path spends the same argon2
    // time as a known-user wrong password (no timing enumeration of accounts).
    if (!user) {
      await verifySecret(DECOY_HASH, password);
      throw new LoginInvalidError(3);
    }

    // Lockout gate first (cheap DB fields already loaded on `user`).
    this.lockout.assertNotLocked(user, 'login');

    // A pre-activation user (passwordHash === null) MUST fail exactly like a
    // wrong password — never reveal that the account is not yet activated. Verify
    // against the decoy hash so the null-hash path does the same argon2 work as a
    // real wrong-password attempt (constant-work; the decoy never matches).
    const valid =
      user.passwordHash != null
        ? await verifySecret(user.passwordHash, password)
        : await verifySecret(DECOY_HASH, password).then(() => false);

    if (!valid) {
      // Audit the failure BEFORE recordFailure (which throws login_invalid).
      await this.audit.logAuth(
        'auth.login_failed',
        user.id,
        user.ownerId ?? null,
      );
      await this.lockout.recordFailure(user.id, 'login'); // always throws
      throw new LoginInvalidError(0); // unreachable; satisfies control flow
    }

    // Password correct — clear the failure counter.
    await this.lockout.recordSuccess(user.id, 'login');

    // Owner status gate: suspended/hard_suspended/closed → 403 owner_suspended.
    if (user.ownerId) {
      const owner = await this.raw.owner.findUnique({
        where: { id: user.ownerId },
      });
      if (owner && SUSPENDED_STATUSES.has(owner.status)) {
        // Failed logins for a suspended owner are still audited above only on
        // wrong password; here the password was right but access is denied.
        await this.audit.logAuth('auth.login_suspended', user.id, user.ownerId);
        throw new OwnerSuspendedError();
      }
    }

    // Platform admin path: never issue an access token from a password alone —
    // hand back a 5-minute preauth token that ONLY Task 8's TOTP endpoints
    // accept. Every access-token guard rejects `kind: "preauth"`.
    if (user.role === 'platform_admin') {
      const preAuthToken = this.jwt.sign(
        { sub: user.id, kind: 'preauth' },
        { secret: this.accessSecret, expiresIn: PREAUTH_TTL },
      );
      await this.audit.logAuth('auth.login_preauth', user.id, null);
      if (user.totpSecret) {
        return { totpRequired: true, preAuthToken };
      }
      return { totpSetupRequired: true, preAuthToken };
    }

    // Owner path: mint the access/refresh pair.
    const { accessToken, refreshToken } = await this.mintTokenPair(
      user.id,
      user.role,
      user.ownerId ?? undefined,
    );
    await this.audit.logAuth('auth.login', user.id, user.ownerId ?? null);
    return { accessToken, refreshToken, role: 'owner' };
  }

  // -------------------------------------------------------------------------
  // Refresh — rolling rotation with reuse detection
  // -------------------------------------------------------------------------

  async refresh(
    rawToken: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const tokenHash = sha256(rawToken);
    const row = await this.raw.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!row) {
      throw new UnauthorizedError('Invalid refresh token.');
    }

    // Reuse detection: a previously-revoked token was presented again → an
    // attacker (or a race) is replaying a rotated token. Revoke EVERY active
    // token for this user and reject.
    if (row.revokedAt !== null) {
      await this.raw.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.logAuth(
        'auth.refresh_reuse',
        row.userId,
        row.user.ownerId ?? null,
      );
      throw new UnauthorizedError('Refresh token reuse detected.');
    }

    if (row.expiresAt < new Date()) {
      await this.raw.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedError('Refresh token has expired.');
    }

    // Rotate: revoke the presented row, mint a fresh 30-day pair.
    await this.raw.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });

    const { accessToken, refreshToken } = await this.mintTokenPair(
      row.user.id,
      row.user.role,
      row.user.ownerId ?? undefined,
    );
    return { accessToken, refreshToken };
  }

  // -------------------------------------------------------------------------
  // Logout — idempotent revoke
  // -------------------------------------------------------------------------

  async logout(rawToken: string): Promise<void> {
    const tokenHash = sha256(rawToken);
    const row = await this.raw.refreshToken.findUnique({
      where: { tokenHash },
    });
    if (!row || row.revokedAt !== null) {
      return; // unknown or already revoked — succeed silently
    }
    await this.raw.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // Token minting (shared by login + refresh)
  // -------------------------------------------------------------------------

  /**
   * Mint an access token whose `sid` is the id of the refresh-token row created
   * alongside it (§11 session/token id). The raw refresh token is returned to
   * the caller; only its SHA-256 hash is persisted.
   */
  async mintTokenPair(
    userId: string,
    role: string,
    ownerId?: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const rawRefresh = generateRefreshToken();
    const expiresAt = new Date(
      Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    const row = await this.raw.refreshToken.create({
      data: { tokenHash: sha256(rawRefresh), userId, expiresAt },
    });

    const payload: Record<string, unknown> = { sub: userId, role, sid: row.id };
    if (ownerId) payload.ownerId = ownerId;

    const accessToken = this.jwt.sign(payload, {
      secret: this.accessSecret,
      expiresIn: ACCESS_TTL,
    });

    return { accessToken, refreshToken: rawRefresh };
  }

  // -------------------------------------------------------------------------
  // POS pairing (Task 16)
  // -------------------------------------------------------------------------

  /**
   * Shared owner-credential verification for POS pairing sign-in and unpair
   * re-auth. Runs the SAME constant-work + lockout path as `login` (no account
   * enumeration; a wrong/pre-activation/unknown credential all cost one argon2
   * verify and end in `login_invalid`), then requires an OWNER account. Owner
   * SUSPENSION is deliberately NOT gated here — callers decide (pairing sign-in
   * rejects suspended owners; unpair allows them so a device can be offboarded).
   * Failures are audited with `failAction` before `recordFailure` throws.
   */
  async verifyOwnerCredentials(
    email: string,
    password: string,
    failAction: string,
  ): Promise<{ user: User; owner: Owner }> {
    const user = await this.raw.user.findUnique({ where: { email } });
    if (!user) {
      await verifySecret(DECOY_HASH, password);
      throw new LoginInvalidError(3);
    }

    this.lockout.assertNotLocked(user, 'login');

    const valid =
      user.passwordHash != null
        ? await verifySecret(user.passwordHash, password)
        : await verifySecret(DECOY_HASH, password).then(() => false);

    if (!valid) {
      await this.audit.logAuth(failAction, user.id, user.ownerId ?? null);
      await this.lockout.recordFailure(user.id, 'login'); // always throws
      throw new LoginInvalidError(0); // unreachable; satisfies control flow
    }

    // Pairing is owner-only. Gate role + soft-delete BEFORE resetting the
    // lockout counter so a valid non-owner/deleted credential neither resets its
    // lockout nor proceeds.
    if (user.deletedAt || user.role !== 'owner' || !user.ownerId) {
      throw new ForbiddenError('This account cannot pair terminals.');
    }

    await this.lockout.recordSuccess(user.id, 'login');

    const owner = await this.raw.owner.findUnique({
      where: { id: user.ownerId },
    });
    if (!owner) {
      // Dangling ownerId — fail closed.
      throw new ForbiddenError('This account cannot pair terminals.');
    }
    return { user, owner };
  }

  /** A 10-minute pairing-scoped JWT (`aud: "pairing"`), owner-only. */
  mintPairingToken(userId: string, ownerId: string): string {
    return this.jwt.sign(
      { sub: userId, ownerId, role: 'owner', aud: 'pairing' },
      { secret: this.accessSecret, expiresIn: PAIRING_TTL },
    );
  }
}
