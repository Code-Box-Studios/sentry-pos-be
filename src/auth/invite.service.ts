import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { AuthTokenKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { AuditService } from './audit.service';
import { hashSecret } from './hashing';
import { seedDemoBusiness } from '../portal/demo-seed';
import { InvalidTokenError } from '../common/errors/api-errors';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A 32-byte URL-safe random token (base64url, no padding). */
function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Task 9 — invite acceptance + password-reset flows.
 *
 * All logic runs on the RAW PrismaService (auth/system paths, pre-scope). Tokens
 * are single-use, sha256-at-rest, and time-boxed (invite 7d, reset 1h). The raw
 * token only ever leaves this service inside the email link; only its hash is
 * persisted.
 */
@Injectable()
export class InviteService {
  private readonly appUrl: string;

  constructor(
    private readonly raw: PrismaService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.appUrl = config.get<string>('APP_URL') ?? 'http://localhost:3000';
  }

  // -------------------------------------------------------------------------
  // Invite
  // -------------------------------------------------------------------------

  /**
   * Create a single-use invite token for `userId`, persist its sha256 hash with
   * a 7-day expiry, and email the recipient a link carrying the RAW token.
   *
   * EXPORTED for Task 10's admin "create owner + invite" endpoint. Returns the
   * raw token so callers/tests can assert on it; the token is also emailed here.
   */
  async createInvite(userId: string): Promise<string> {
    const user = await this.raw.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const rawToken = generateRawToken();
    await this.raw.authToken.create({
      data: {
        kind: AuthTokenKind.invite,
        tokenHash: sha256(rawToken),
        userId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });

    const link = `${this.appUrl}/invite/accept?token=${rawToken}`;
    await this.mail.send({
      to: user.email,
      subject: 'You have been invited to Sentry POS',
      html:
        `<p>You have been invited to Sentry POS.</p>` +
        `<p>Click the link below to set your password and activate your account:</p>` +
        `<p><a href="${link}">${link}</a></p>` +
        `<p>This link expires in 7 days.</p>`,
    });

    return rawToken;
  }

  /**
   * Accept an invite: verify the token, set the user's password (argon2),
   * activate the owner, and seed the demo business. Single-use + expiry
   * enforced. All failures collapse to a generic `invalid_token` (400).
   *
   * The ENTIRE accept is ATOMIC: token-consume + set-password + owner-activation
   * + `seedDemoBusiness` (its ~30 creates + the `business.demo_seeded` audit row)
   * + the `auth.invite_accepted` audit row all run inside a single
   * `$transaction`. If any seed step fails, everything rolls back — the invite
   * token stays UNCONSUMED and the owner stays INACTIVE, so the invite can simply
   * be retried (no half-seeded demo, no stranded activation). Password hashing
   * (CPU-bound, no DB side effects) runs before the transaction so a connection
   * isn't held during argon2.
   */
  async acceptInvite(token: string, password: string): Promise<void> {
    const passwordHash = await hashSecret(password);

    await this.raw.$transaction(async (tx) => {
      const row = await this.consumeToken(tx, token, AuthTokenKind.invite);

      const user = await tx.user.update({
        where: { id: row.userId },
        data: { passwordHash },
      });

      // Activate the owner (a pre-invite owner may be created suspended/inactive)
      // and seed the demo business as system provisioning — all in this tx.
      if (user.ownerId) {
        await tx.owner.update({
          where: { id: user.ownerId },
          data: { status: 'active', suspendedAt: null },
        });
        await seedDemoBusiness(tx, user.ownerId);
      }

      // §11 auth event — actor = the owner (or platform admin fallback).
      await this.audit.logAuth(
        'auth.invite_accepted',
        user.id,
        user.ownerId ?? null,
        {},
        tx,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Password reset
  // -------------------------------------------------------------------------

  /**
   * Request a password reset. ALWAYS succeeds silently (the caller returns 204)
   * to avoid user enumeration: a token is created and mail sent ONLY when the
   * email resolves to an existing user.
   */
  async requestReset(email: string): Promise<void> {
    const user = await this.raw.user.findUnique({ where: { email } });
    if (!user) {
      return; // no enumeration — say nothing, do nothing
    }

    const rawToken = generateRawToken();
    await this.raw.authToken.create({
      data: {
        kind: AuthTokenKind.reset,
        tokenHash: sha256(rawToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });

    const link = `${this.appUrl}/password-reset/confirm?token=${rawToken}`;
    await this.mail.send({
      to: user.email,
      subject: 'Reset your Sentry POS password',
      html:
        `<p>We received a request to reset your Sentry POS password.</p>` +
        `<p>Click the link below to choose a new password:</p>` +
        `<p><a href="${link}">${link}</a></p>` +
        `<p>This link expires in 1 hour. If you did not request this, ignore this email.</p>`,
    });
  }

  /**
   * Confirm a password reset: verify the token, set the new password, and
   * revoke ALL of the user's refresh tokens. Single-use + expiry enforced.
   *
   * Atomic: token-consume + set-password + revoke-all-sessions + the
   * `auth.password_reset` audit row all run in one `$transaction`.
   */
  async confirmReset(token: string, password: string): Promise<void> {
    const passwordHash = await hashSecret(password);

    await this.raw.$transaction(async (tx) => {
      const row = await this.consumeToken(tx, token, AuthTokenKind.reset);

      const user = await tx.user.update({
        where: { id: row.userId },
        data: { passwordHash },
      });

      // Revoke every active refresh token for this user (invalidate all sessions).
      await tx.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      // §11 auth event — actor = the user whose password was reset.
      await this.audit.logAuth(
        'auth.password_reset',
        user.id,
        user.ownerId ?? null,
        {},
        tx,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Shared token consumption
  // -------------------------------------------------------------------------

  /**
   * Look up a token by its hash, enforce kind / not-used / not-expired, and mark
   * it used atomically. Returns the row on success; throws `invalid_token`
   * (generic 400) on any failure so nothing about the token is revealed. Runs on
   * the caller-supplied transaction client so consumption commits/rolls back with
   * the rest of the flow.
   */
  private async consumeToken(
    tx: Prisma.TransactionClient,
    token: string,
    kind: AuthTokenKind,
  ): Promise<{ id: string; userId: string }> {
    const row = await tx.authToken.findUnique({
      where: { tokenHash: sha256(token) },
    });

    if (
      !row ||
      row.kind !== kind ||
      row.usedAt !== null ||
      row.expiresAt < new Date()
    ) {
      throw new InvalidTokenError();
    }

    // Mark used, but guard against a concurrent double-accept: updateMany with
    // usedAt still null so exactly one caller wins the single-use race.
    const result = await tx.authToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (result.count === 0) {
      throw new InvalidTokenError();
    }

    return { id: row.id, userId: row.userId };
  }
}
