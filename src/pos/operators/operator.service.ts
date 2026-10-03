import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { hashSecret } from '../../auth/hashing';
import { getContext } from '../../common/context/request-context';
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationFailedError,
} from '../../common/errors/api-errors';
import { LockoutService } from '../../common/lockout/lockout.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StaffChallengeService } from '../../staff/staff-challenge.service';
import { SetupOperatorPinDto, UnlockOperatorDto } from './dto/operator.dto';
import { assertTerminalWrite } from './operator-write';

const SESSION_MAX_MS = 12 * 60 * 60 * 1000;

export interface OperatorIdentity {
  userId: string;
  name: string;
  role: 'owner' | 'manager' | 'cashier';
}

export interface OperatorUnlock {
  operator: OperatorIdentity;
  token: string;
  expiresAt: string;
}

type EligibleUser = Prisma.UserGetPayload<{
  include: { owner: true; staffProfile: { include: { branches: true } } };
}>;

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class OperatorService {
  constructor(
    private readonly raw: PrismaService,
    private readonly lockout: LockoutService,
    private readonly challenges: StaffChallengeService,
  ) {}

  async activity() {
    const ctx = getContext();
    if (!ctx.operator || !ctx.branchId) throw new UnauthorizedError();
    // Identity comes only from the validated human session. No client-supplied actor filter.
    const where = {
      branchId: ctx.branchId,
      deletedAt: null,
      ...(ctx.operator.role === 'cashier'
        ? { operatorUserId: ctx.operator.userId }
        : {}),
    };
    const [sales, shifts] = await Promise.all([
      this.raw.sale.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          receiptNo: true,
          createdAt: true,
          status: true,
          total: true,
          operatorUserId: true,
        },
      }),
      this.raw.shift.findMany({
        where,
        orderBy: { openedAt: 'desc' },
        take: 100,
        select: {
          id: true,
          openedAt: true,
          closedAt: true,
          operatorUserId: true,
          closingCash: true,
          expectedCash: true,
        },
      }),
    ]);
    return {
      sales: sales.map(({ total, createdAt, ...row }) => ({
        ...row,
        totalC: total,
        createdAt: createdAt.toISOString(),
      })),
      shifts: shifts.map(
        ({ openedAt, closedAt, closingCash, expectedCash, ...row }) => ({
          ...row,
          openedAt: openedAt.toISOString(),
          closedAt: closedAt?.toISOString() ?? null,
          overShortC:
            closedAt && closingCash !== null && expectedCash !== null
              ? closingCash - expectedCash
              : null,
        }),
      ),
    };
  }

  async roster(): Promise<(OperatorIdentity & { requiresSetup: boolean })[]> {
    const ctx = getContext();
    if (!ctx.ownerId || !ctx.businessId || !ctx.branchId)
      throw new UnauthorizedError();
    const [owner, staff] = await Promise.all([
      this.raw.owner.findUnique({
        where: { id: ctx.ownerId },
        include: { users: { where: { role: 'owner', deletedAt: null } } },
      }),
      this.raw.staffProfile.findMany({
        where: {
          businessId: ctx.businessId,
          deletedAt: null,
          status: { in: ['active', 'pending'] },
          branches: { some: { branchId: ctx.branchId, deletedAt: null } },
        },
        include: { user: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    if (!owner) throw new UnauthorizedError();
    const owners = owner.users.map((user) => ({
      userId: user.id,
      name: owner.name,
      role: 'owner' as const,
      requiresSetup: !user.pinHash,
    }));
    const resets = await this.raw.staffChallenge.findMany({
      where: {
        userId: { in: staff.map((row) => row.userId) },
        kind: 'pin_reset',
        usedAt: null,
      },
      select: { userId: true },
    });
    const resetIds = new Set(resets.map((row) => row.userId));
    const staffRows = staff
      .filter(
        (row) =>
          !row.user.deletedAt &&
          row.user.ownerId === ctx.ownerId &&
          (row.status === 'active' ||
            row.user.role === 'cashier' ||
            resetIds.has(row.userId)),
      )
      .map((row) => ({
        userId: row.userId,
        name: row.name,
        role: row.user.role as 'manager' | 'cashier',
        requiresSetup: row.status === 'pending' || !row.user.pinHash,
      }));
    return [...owners, ...staffRows];
  }

  private async eligible(
    userId: string,
    allowPending = false,
    db: Prisma.TransactionClient | PrismaService = this.raw,
  ): Promise<{
    user: EligibleUser;
    identity: OperatorIdentity;
  }> {
    const ctx = getContext();
    if (!ctx.ownerId || !ctx.businessId || !ctx.branchId)
      throw new UnauthorizedError();
    const user = await db.user.findUnique({
      where: { id: userId },
      include: { owner: true, staffProfile: { include: { branches: true } } },
    });
    if (!user || user.deletedAt || user.ownerId !== ctx.ownerId)
      throw new UnauthorizedError();
    if (user.role === 'owner' && user.owner && !user.owner.deletedAt) {
      return {
        user,
        identity: { userId, name: user.owner.name, role: 'owner' },
      };
    }
    const profile = user.staffProfile;
    if (
      (user.role !== 'manager' && user.role !== 'cashier') ||
      !profile ||
      profile.deletedAt ||
      profile.businessId !== ctx.businessId ||
      (profile.status !== 'active' &&
        !(allowPending && profile.status === 'pending')) ||
      !profile.branches.some(
        (branch) => branch.branchId === ctx.branchId && !branch.deletedAt,
      )
    )
      throw new UnauthorizedError();
    return { user, identity: { userId, name: profile.name, role: user.role } };
  }

  private async issueSession(
    identity: OperatorIdentity,
    verifiedPinHash: string,
  ): Promise<OperatorUnlock> {
    const ctx = getContext();
    if (!ctx.terminalId || !ctx.branchId || !ctx.businessId || !ctx.ownerId) {
      throw new UnauthorizedError();
    }
    // Re-check after any preceding PIN change; deactivation/branch removal wins.
    await this.eligible(identity.userId);
    const rawToken = randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_MAX_MS);
    await this.raw.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM terminals WHERE id = ${ctx.terminalId}::uuid FOR UPDATE`;
      // Serialize with owner staff changes, then validate the current status and
      // assignments inside the transaction that creates the session.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${identity.userId}::uuid FOR UPDATE`;
      const current = await this.eligible(identity.userId, false, tx);
      if (
        current.identity.role !== identity.role ||
        current.user.pinHash !== verifiedPinHash
      ) {
        throw new UnauthorizedError();
      }
      await assertTerminalWrite(tx);
      const open = await tx.shift.findFirst({
        where: { terminalId: ctx.terminalId, closedAt: null, deletedAt: null },
        select: { operatorUserId: true },
      });
      if (open && open.operatorUserId !== identity.userId) {
        throw new ForbiddenError(
          'Only the shift operator can resume this drawer.',
        );
      }
      await tx.operatorSession.updateMany({
        where: { terminalId: ctx.terminalId, revokedAt: null },
        data: { revokedAt: now },
      });
      const session = await tx.operatorSession.create({
        data: {
          tokenHash: sha256(rawToken),
          userId: identity.userId,
          terminalId: ctx.terminalId!,
          branchId: ctx.branchId!,
          lastActivityAt: now,
          expiresAt,
        },
      });
      await tx.auditLog.create({
        data: {
          actorType: identity.role === 'owner' ? 'owner' : 'staff',
          actorId: identity.userId,
          ownerId: ctx.ownerId,
          businessId: ctx.businessId,
          branchId: ctx.branchId,
          action: 'operator.unlocked',
          entityType: 'operatorSession',
          entityId: session.id,
          changes: {},
          metadata: { terminalId: ctx.terminalId, role: identity.role },
        },
      });
    });
    return {
      operator: identity,
      token: rawToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async unlock(dto: UnlockOperatorDto): Promise<OperatorUnlock> {
    const { user, identity } = await this.eligible(dto.userId, true);
    if (user.staffProfile?.status === 'pending') {
      throw new ValidationFailedError(
        'Complete credential setup before unlocking.',
      );
    }
    if (!user.pinHash) {
      throw new ValidationFailedError(
        user.role === 'owner'
          ? 'Set a six-digit PIN in portal settings before using this terminal.'
          : 'Set a permanent PIN with your temporary PIN before unlocking.',
      );
    }
    const verifiedPinHash = await this.lockout.verifyUserPin(user.id, dto.pin);
    return this.issueSession(identity, verifiedPinHash);
  }

  async setupPin(dto: SetupOperatorPinDto): Promise<OperatorUnlock> {
    if (dto.newPin === dto.temporaryPin) {
      throw new ValidationFailedError(
        'Choose a new PIN different from the temporary PIN.',
      );
    }
    const { user, identity } = await this.eligible(dto.userId, true);
    if (user.role === 'owner' || !user.staffProfile) {
      throw new ValidationFailedError(
        'This operator does not need temporary PIN setup.',
      );
    }
    if (user.staffProfile.status !== 'pending') {
      return this.challenges.rejectUnknown(dto.temporaryPin);
    }
    const challenge = await this.raw.staffChallenge.findFirst({
      where: { userId: user.id, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const kind = challenge?.kind;
    if (!kind || (kind !== 'cashier_setup' && kind !== 'pin_reset')) {
      return this.challenges.rejectUnknown(dto.temporaryPin);
    }
    if (user.role === 'manager' && kind !== 'pin_reset') {
      return this.challenges.rejectUnknown(dto.temporaryPin);
    }
    const pinHash = await hashSecret(dto.newPin);
    await this.challenges.consume(
      user.id,
      kind,
      dto.temporaryPin,
      async (tx: Prisma.TransactionClient) => {
        const profile = await tx.staffProfile.findUnique({
          where: { userId: user.id },
        });
        if (!profile || profile.status !== 'pending')
          throw new UnauthorizedError();
        await tx.user.update({
          where: { id: user.id },
          data: {
            pinHash,
            failedPinCount: 0,
            pinLockedUntil: null,
          },
        });
        await tx.staffProfile.update({
          where: { id: profile.id },
          data: { status: 'active' },
        });
      },
    );
    return this.issueSession(identity, pinHash);
  }

  async lock(): Promise<{ ok: true }> {
    const ctx = getContext();
    if (!ctx.operatorSessionId || !ctx.operator || !ctx.terminalId)
      throw new UnauthorizedError();
    await this.raw.operatorSession.updateMany({
      where: {
        id: ctx.operatorSessionId,
        terminalId: ctx.terminalId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }
}
