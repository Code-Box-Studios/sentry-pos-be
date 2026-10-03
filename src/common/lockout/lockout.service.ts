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
import { getContext, type RequestContext } from '../context/request-context';
import { Prisma, User } from '@prisma/client';

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
    const attemptsRemaining = await this.raw.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      return this.incrementFailure(tx, user, kind);
    });
    // Throw outside the transaction so the counter/lock is committed.
    if (kind === 'pin') throw new PinInvalidError(attemptsRemaining);
    throw new LoginInvalidError(attemptsRemaining);
  }

  private async incrementFailure(
    tx: Prisma.TransactionClient,
    user: User,
    kind: LockoutKind,
  ): Promise<number> {
    const currentCount =
      kind === 'pin' ? user.failedPinCount : user.failedLoginCount;
    const newCount = currentCount + 1;
    const attemptsRemaining = Math.max(0, MAX_ATTEMPTS - newCount);

    const shouldLock = newCount >= MAX_ATTEMPTS;
    const lockedUntil = shouldLock
      ? new Date(Date.now() + LOCKOUT_SECONDS * 1000)
      : null;

    if (kind === 'pin') {
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedPinCount: newCount,
          ...(shouldLock ? { pinLockedUntil: lockedUntil } : {}),
        },
      });
    } else {
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: newCount,
          ...(shouldLock ? { loginLockedUntil: lockedUntil } : {}),
        },
      });
    }
    return attemptsRemaining;
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
      where: { ownerId, role: 'owner', deletedAt: null },
    });

    if (!user) {
      throw new ValidationFailedError('set the refund PIN in the portal');
    }

    if (!user.pinHash) {
      throw new ValidationFailedError('set the refund PIN in the portal');
    }

    await this.verifyUserPin(user.id, pin);
  }

  /** Verifies a named terminal operator's permanent PIN with the shared lockout. */
  async verifyUserPin(userId: string, pin: string): Promise<string> {
    const result = await this.raw.$transaction(async (tx) => {
      // Serialize verification too: a valid PIN cannot undo a lock reached by
      // another request while hashing, and guesses cannot share one counter.
      await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.deletedAt || !user.ownerId || !user.pinHash) {
        throw new ValidationFailedError(
          'Set a permanent PIN before unlocking.',
        );
      }
      this.assertNotLocked(user, 'pin');
      if (!(await verifySecret(user.pinHash, pin))) {
        await this._writePinFailureAudit(user.id, user.ownerId, tx);
        return {
          accepted: false as const,
          attemptsRemaining: await this.incrementFailure(tx, user, 'pin'),
        };
      }
      await tx.user.update({
        where: { id: user.id },
        data: { failedPinCount: 0, pinLockedUntil: null },
      });
      return { accepted: true as const, pinHash: user.pinHash };
    });
    if (!result.accepted) throw new PinInvalidError(result.attemptsRemaining);
    return result.pinHash;
  }

  /**
   * Writes an audit log row for a PIN failure with the attempted identity.
   * Called internally on every failed verifyPinWithLockout attempt.
   */
  private async _writePinFailureAudit(
    userId: string,
    ownerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    // Collect request context metadata (may be partial depending on caller)
    let ctx: Partial<RequestContext> = {};
    try {
      ctx = getContext();
    } catch {
      // Outside a request context (e.g., tests calling directly) — use empty metadata
    }

    await tx.auditLog.create({
      data: {
        // Attribute to the ACTUAL actor (a POS refund is a terminal, not the
        // owner) so (actorType, actorId) stays a consistent pair.
        actorType: ctx.actor?.type ?? 'owner',
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
          attemptedBy: userId,
          terminalId:
            ctx.terminalId ??
            (ctx.actor?.type === 'terminal' ? ctx.actor.id : null),
        },
      },
    });
  }
}
