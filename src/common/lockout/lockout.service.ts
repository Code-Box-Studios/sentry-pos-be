import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { verifySecret } from '../../auth/hashing';
import {
  PinInvalidError,
  PinLockedError,
  LoginInvalidError,
  LoginLockedError,
  ValidationFailedError,
} from '../errors/api-errors';
import { getContext } from '../context/request-context';
import { User } from '@prisma/client';

export type LockoutKind = 'pin' | 'login';

const LOCKOUT_SECONDS = 300;
const MAX_ATTEMPTS = 4;

@Injectable()
export class LockoutService {
  constructor(private readonly raw: PrismaService) {}

  /**
   * Throws PinLockedError or LoginLockedError if the user is currently locked.
   * No-op if not locked.
   */
  assertNotLocked(user: User, kind: LockoutKind): void {
    const lockedUntil =
      kind === 'pin' ? user.pinLockedUntil : user.loginLockedUntil;

    if (lockedUntil && lockedUntil > new Date()) {
      const retryAfterSeconds = Math.ceil(
        (lockedUntil.getTime() - Date.now()) / 1000,
      );
      if (kind === 'pin') {
        throw new PinLockedError(retryAfterSeconds);
      } else {
        throw new LoginLockedError(retryAfterSeconds);
      }
    }
  }

  /**
   * Records a failed attempt. On every failure where the new count >= 4,
   * sets locked_until = now + 300s (re-locks after expiry too).
   * Throws pin_invalid/login_invalid with attemptsRemaining.
   */
  async recordFailure(userId: string, kind: LockoutKind): Promise<void> {
    const user = await this.raw.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const currentCount =
      kind === 'pin' ? user.failedPinCount : user.failedLoginCount;
    const newCount = currentCount + 1;
    const attemptsRemaining = Math.max(0, MAX_ATTEMPTS - newCount);

    const shouldLock = newCount >= MAX_ATTEMPTS;
    const lockedUntil = shouldLock
      ? new Date(Date.now() + LOCKOUT_SECONDS * 1000)
      : null;

    if (kind === 'pin') {
      await this.raw.user.update({
        where: { id: userId },
        data: {
          failedPinCount: newCount,
          ...(shouldLock ? { pinLockedUntil: lockedUntil } : {}),
        },
      });
      throw new PinInvalidError(attemptsRemaining);
    } else {
      await this.raw.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: newCount,
          ...(shouldLock ? { loginLockedUntil: lockedUntil } : {}),
        },
      });
      throw new LoginInvalidError(attemptsRemaining);
    }
  }

  /**
   * Resets the failure counter and lock for the given kind.
   */
  async recordSuccess(userId: string, kind: LockoutKind): Promise<void> {
    if (kind === 'pin') {
      await this.raw.user.update({
        where: { id: userId },
        data: {
          failedPinCount: 0,
          pinLockedUntil: null,
        },
      });
    } else {
      await this.raw.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: 0,
          loginLockedUntil: null,
        },
      });
    }
  }

  /**
   * Convenience wrapper for PIN verification used by tenant modules (e.g. Task 20).
   * Fetches the owner user, checks lockout, verifies PIN, updates counters.
   * Writes an audit row on every PIN failure.
   */
  async verifyPinWithLockout(ownerId: string, pin: string): Promise<void> {
    // Fetch owner user via raw client (users is a platform model)
    const user = await this.raw.user.findFirst({
      where: { ownerId, deletedAt: null },
    });

    if (!user) {
      throw new ValidationFailedError('set the refund PIN in the portal');
    }

    if (!user.pinHash) {
      throw new ValidationFailedError('set the refund PIN in the portal');
    }

    // Check lockout before attempting verification
    this.assertNotLocked(user, 'pin');

    // Attempt PIN verification
    const valid = await verifySecret(user.pinHash, pin);

    if (!valid) {
      // Write audit row for PIN failure (project-spec §11)
      await this._writePinFailureAudit(user.id, ownerId);
      // Record the failure (throws PinInvalidError)
      await this.recordFailure(user.id, 'pin');
      return; // recordFailure always throws; this is unreachable
    }

    // Success — reset counters
    await this.recordSuccess(user.id, 'pin');
  }

  /**
   * Writes an audit log row for a PIN failure with the attempted identity.
   * Called internally on every failed verifyPinWithLockout attempt.
   */
  private async _writePinFailureAudit(
    userId: string,
    ownerId: string,
  ): Promise<void> {
    // Collect request context metadata (may be partial depending on caller)
    let ctx: {
      actor?: { type: string; id: string } | null;
      ip?: string;
      requestId?: string;
      sessionId?: string | null;
    } = {};
    try {
      ctx = getContext();
    } catch {
      // Outside a request context (e.g., tests calling directly) — use empty metadata
    }

    await this.raw.auditLog.create({
      data: {
        actorType: 'owner',
        actorId: ctx.actor?.id ?? userId,
        ownerId,
        action: 'auth.pin_failure',
        entityType: 'user',
        entityId: userId,
        changes: {},
        metadata: {
          requestId: ctx.requestId ?? null,
          ip: ctx.ip ?? null,
          sessionId: ctx.sessionId ?? null,
          // The "attempted identity" — who tried the PIN (not the PIN itself)
          attemptedBy: ctx.actor?.id ?? userId,
        },
      },
    });
  }
}
