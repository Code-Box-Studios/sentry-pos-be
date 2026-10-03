import { Injectable } from '@nestjs/common';
import { Prisma, StaffChallengeKind } from '@prisma/client';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hashSecret, verifySecret } from '../auth/hashing';
import { InvalidTokenError } from '../common/errors/api-errors';
import { getContext, RequestContext } from '../common/context/request-context';

const CHALLENGE_TTL_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

@Injectable()
export class StaffChallengeService {
  private readonly decoyHash = hashSecret('000000');

  constructor(private readonly raw: PrismaService) {}

  async issue(
    tx: Prisma.TransactionClient,
    userId: string,
    kind: StaffChallengeKind,
  ): Promise<string> {
    const now = new Date();
    const pin = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await tx.staffChallenge.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    });
    await tx.staffChallenge.create({
      data: {
        userId,
        kind,
        pinHash: await hashSecret(pin),
        expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
      },
    });
    return pin;
  }

  async rejectUnknown(pin: string): Promise<never> {
    await verifySecret(await this.decoyHash, pin);
    throw new InvalidTokenError();
  }

  async consume<T>(
    userId: string,
    kind: StaffChallengeKind,
    pin: string,
    complete: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const result = await this.raw.$transaction(async (tx) => {
      // Serializes attempts, resets, and simultaneous setup requests for this user.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const challenge = await tx.staffChallenge.findFirst({
        where: { userId, kind, usedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      if (!challenge) {
        await verifySecret(await this.decoyHash, pin);
        await this.auditFailure(tx, userId, kind);
        return { accepted: false as const };
      }
      if (
        challenge.expiresAt <= new Date() ||
        challenge.failedAttempts >= MAX_FAILURES
      ) {
        await this.auditFailure(tx, userId, kind);
        return { accepted: false as const };
      }
      if (!(await verifySecret(challenge.pinHash, pin))) {
        await tx.staffChallenge.update({
          where: { id: challenge.id },
          data: { failedAttempts: { increment: 1 } },
        });
        await this.auditFailure(tx, userId, kind);
        return { accepted: false as const };
      }

      const value = await complete(tx);
      await tx.staffChallenge.update({
        where: { id: challenge.id },
        data: { usedAt: new Date() },
      });
      return { accepted: true as const, value };
    });
    if (!result.accepted) throw new InvalidTokenError();
    return result.value;
  }

  private async auditFailure(
    tx: Prisma.TransactionClient,
    userId: string,
    kind: StaffChallengeKind,
  ) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: { staffProfile: true },
    });
    if (!user) return;
    let ctx: Partial<RequestContext> = {};
    try {
      ctx = getContext();
    } catch {
      /* Direct service calls have no request context. */
    }
    await tx.auditLog.create({
      data: {
        actorType: ctx.actor?.type ?? 'staff',
        actorId: ctx.actor?.id ?? null,
        ownerId: user.ownerId,
        businessId: user.staffProfile?.businessId ?? null,
        branchId: ctx.branchId ?? null,
        action: 'staff.temporary_pin_failed',
        entityType: 'user',
        entityId: userId,
        changes: {},
        metadata: {
          attemptedBy: userId,
          attemptedRole: user.role,
          challengeKind: kind,
          terminalId: ctx.terminalId ?? null,
          requestId: ctx.requestId ?? null,
          ip: ctx.ip ?? null,
          sessionId: ctx.sessionId ?? null,
        },
      },
    });
  }
}
